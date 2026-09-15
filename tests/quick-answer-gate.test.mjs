// tests/quick-answer-gate.test.mjs
//
// createQuickAnswerGate: the cached, fail-closed reader of the Mini App
// allowlist. One read per TTL, a failed or hung read counts as an empty set and
// is logged once per TTL, and load() never rejects. The clock and the reader
// are injected; nothing here touches Redis (tests/support/load-ts.mjs stubs it).

import { test } from "node:test";
import assert from "node:assert/strict";
import "./support/load-ts.mjs";

const gateModule = await import("../lib/quick-answer-gate.ts");
const { createQuickAnswerGate, QUICK_ANSWER_GATE_READ_TIMEOUT_MS, QUICK_ANSWER_GATE_TTL_MS } = gateModule;

const T0 = 1_750_000_000_000;
const TTL = 60_000;

function manualClock(start = T0) {
  let at = start;
  return {
    now: () => at,
    advance: (ms) => {
      at += ms;
    },
    set: (value) => {
      at = value;
    },
  };
}

/** A reader that plays `steps` in order and repeats the last one; an Error step rejects. */
function scriptedRead(steps) {
  const state = { calls: 0 };
  const read = async () => {
    const step = steps[Math.min(state.calls, steps.length - 1)];
    state.calls += 1;
    if (step instanceof Error) throw step;
    return step;
  };
  return { read, state };
}

function recordingLog() {
  const lines = [];
  return { lines, logError: (message, err) => lines.push({ message, err }) };
}

function gateWith(steps, extra = {}) {
  const clock = manualClock();
  const log = recordingLog();
  const { read, state } = scriptedRead(steps);
  const gate = createQuickAnswerGate({ read, now: clock.now, ttlMs: TTL, logError: log.logError, ...extra });
  return { gate, clock, log, state };
}

test("defaults: a one-minute cache and a bounded read", () => {
  assert.equal(QUICK_ANSWER_GATE_TTL_MS, 60_000);
  assert.equal(QUICK_ANSWER_GATE_READ_TIMEOUT_MS, 1_500);
  assert.equal(createQuickAnswerGate({ read: async () => [] }).ttlMs, QUICK_ANSWER_GATE_TTL_MS);
});

test("one read serves every update within the TTL, the next one reads again", async () => {
  const { gate, clock, state } = gateWith([["*"]]);

  const first = await gate.load();
  assert.deepEqual(first, { members: ["*"], source: "redis", loadedAt: T0 });
  for (const step of [1, 29_999, 29_999]) {
    clock.advance(step);
    assert.equal(await gate.load(), first);
  }
  assert.equal(state.calls, 1);

  clock.set(T0 + TTL);
  const second = await gate.load();
  assert.equal(state.calls, 2);
  assert.notEqual(second, first);
  assert.equal(second.loadedAt, T0 + TTL);
});

test("SADD and SREM reach the bot on the first read after the TTL", async () => {
  const { gate, clock } = gateWith([[], ["*"], ["tg_42"]]);
  assert.deepEqual((await gate.load()).members, []);
  clock.advance(TTL - 1);
  assert.deepEqual((await gate.load()).members, []);
  clock.advance(1);
  assert.deepEqual((await gate.load()).members, ["*"]);
  clock.advance(TTL);
  assert.deepEqual((await gate.load()).members, ["tg_42"]);
});

test("the snapshot is a frozen copy of what was read", async () => {
  const raw = ["tg_42"];
  const gate = createQuickAnswerGate({ read: async () => raw, logError: () => assert.fail("no failure expected") });
  const snapshot = await gate.load();
  raw.push("*");
  assert.deepEqual(snapshot.members, ["tg_42"]);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.members));
  assert.throws(() => snapshot.members.push("*"), TypeError);
});

test("a Redis error counts as an empty set", async () => {
  const { gate, clock, log } = gateWith([["*"], new Error("ECONNRESET")]);
  assert.equal((await gate.load()).source, "redis");

  clock.advance(TTL);
  const failed = await gate.load();
  assert.deepEqual(failed, { members: [], source: "unavailable", loadedAt: T0 + TTL });
  assert.ok(Object.isFrozen(failed.members));
  assert.equal(log.lines.length, 1);
  assert.match(log.lines[0].message, /support:miniapp:users/);
  assert.equal(log.lines[0].err.message, "ECONNRESET");
});

test("an outage is logged once per TTL and Redis is not retried within it", async () => {
  const { gate, clock, log, state } = gateWith([new Error("down")]);

  await gate.load();
  for (const at of [1, 30_000, TTL - 1]) {
    clock.set(T0 + at);
    assert.equal((await gate.load()).source, "unavailable");
  }
  assert.equal(state.calls, 1);
  assert.equal(log.lines.length, 1);

  clock.set(T0 + TTL);
  await gate.load();
  clock.set(T0 + 2 * TTL - 1);
  await gate.load();
  assert.equal(state.calls, 2);
  assert.equal(log.lines.length, 2);

  clock.set(T0 + 2 * TTL);
  await gate.load();
  assert.equal(state.calls, 3);
  assert.equal(log.lines.length, 3);
});

test("the first read after the TTL recovers from an outage", async () => {
  const { gate, clock, log } = gateWith([new Error("down"), ["*"]]);
  assert.equal((await gate.load()).source, "unavailable");
  clock.advance(TTL);
  assert.deepEqual(await gate.load(), { members: ["*"], source: "redis", loadedAt: T0 + TTL });
  assert.equal(log.lines.length, 1);
});

test("a reader that throws synchronously fails closed instead of crashing", async () => {
  const log = recordingLog();
  const gate = createQuickAnswerGate({
    read: () => {
      throw new Error("Redis used from a unit test");
    },
    logError: log.logError,
  });
  const snapshot = await gate.load();
  assert.equal(snapshot.source, "unavailable");
  assert.deepEqual(snapshot.members, []);
  assert.equal(log.lines.length, 1);
});

test("a reply that is not a list fails closed", async () => {
  for (const reply of [null, undefined, "*", 1, { 0: "*" }, new Set(["*"])]) {
    const log = recordingLog();
    const gate = createQuickAnswerGate({ read: async () => reply, logError: log.logError });
    const snapshot = await gate.load();
    assert.equal(snapshot.source, "unavailable", String(reply));
    assert.deepEqual(snapshot.members, [], String(reply));
    assert.equal(log.lines.length, 1, String(reply));
    assert.match(log.lines[0].err.message, /not a list/);
  }
});

test("a read that never answers times out and fails closed", async () => {
  const log = recordingLog();
  const gate = createQuickAnswerGate({ read: () => new Promise(() => {}), timeoutMs: 20, logError: log.logError });
  const started = Date.now();
  const snapshot = await gate.load();
  assert.equal(snapshot.source, "unavailable");
  assert.ok(Date.now() - started < 1_000, "the menu is not held up by a hung read");
  assert.equal(log.lines.length, 1);
  assert.match(log.lines[0].err.message, /no answer in 20 ms/);
});

test("updates that arrive during a read share it", async () => {
  let release;
  let calls = 0;
  const gate = createQuickAnswerGate({
    read: () => {
      calls += 1;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  const pending = [gate.load(), gate.load(), gate.load()];
  assert.equal(calls, 1);
  release(["tg_42"]);
  const [a, b, c] = await Promise.all(pending);
  assert.equal(a, b);
  assert.equal(b, c);
  assert.deepEqual(a.members, ["tg_42"]);
  assert.equal(calls, 1);
});

test("a clock that goes backwards re-reads rather than trusting the cache forever", async () => {
  const { gate, clock, state } = gateWith([["*"]]);
  await gate.load();
  clock.set(T0 - 1);
  await gate.load();
  assert.equal(state.calls, 2);
});

test("a logger that throws cannot break the menu", async () => {
  const gate = createQuickAnswerGate({
    read: async () => {
      throw new Error("down");
    },
    logError: () => {
      throw new Error("logger down");
    },
  });
  assert.equal((await gate.load()).source, "unavailable");
});

test("invalid options are refused when the gate is built", () => {
  const read = async () => [];
  for (const options of [undefined, null, {}, { read: "smembers" }, { read: null }]) {
    assert.throws(() => createQuickAnswerGate(options), TypeError, JSON.stringify(options));
  }
  assert.throws(() => createQuickAnswerGate({ read, now: 5 }), TypeError);
  assert.throws(() => createQuickAnswerGate({ read, logError: "console" }), TypeError);
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "60000", null]) {
    assert.throws(() => createQuickAnswerGate({ read, ttlMs: bad }), RangeError, `ttlMs ${String(bad)}`);
    assert.throws(() => createQuickAnswerGate({ read, timeoutMs: bad }), RangeError, `timeoutMs ${String(bad)}`);
  }
});

test("a failed read closes the Mini App to all but the owner, never the menu", async () => {
  const { quickAnswerButton } = await import("../lib/quick-answer.ts");
  const SITE = "https://proxysvpn.com";
  const WEB_APP_OPEN = { text: "⚡ Быстрый ответ", web_app: { url: `${SITE}/tg/support` } };
  const CALLBACK_OPEN = { text: "⚡ Быстрый ответ", callback_data: "ai" };
  const { gate, clock, log } = gateWith([["*"], new Error("down")]);
  // hasSiteAccount: true, so only the set's read decides here.
  const menuButton = async (userId) =>
    quickAnswerButton({
      userId,
      chatId: userId,
      siteUrl: SITE,
      webAppMembers: (await gate.load()).members,
      hasSiteAccount: true,
    });

  assert.deepEqual(await menuButton(42), WEB_APP_OPEN);
  clock.advance(TTL);
  assert.deepEqual(await menuButton(42), CALLBACK_OPEN);
  assert.deepEqual(await menuButton(6944217115), WEB_APP_OPEN);
  assert.equal(log.lines.length, 1);
});

test("the probe report counts the set and names no one", () => {
  const snapshot = Object.freeze({
    members: Object.freeze(["*", "tg_42", "tg_6944217115", 6944217115]),
    source: "redis",
    loadedAt: T0,
  });
  const report = gateModule.describeQuickAnswerGate(snapshot, T0 + 1_234, TTL);
  assert.deepEqual(report, {
    key: "support:miniapp:users",
    source: "redis",
    everyone: true,
    membersCount: 2,
    ignoredMembers: 1,
    ageMs: 1_234,
    ttlMs: TTL,
  });
  const json = JSON.stringify(report);
  assert.ok(!json.includes("tg_"), json);
  assert.ok(!json.includes("6944217115"), json);
  assert.ok(!/\b42\b/.test(json), json);
});

test("the probe report of a failed read says so", async () => {
  const { gate, clock } = gateWith([new Error("down")]);
  const snapshot = await gate.load();
  clock.advance(5_000);
  assert.deepEqual(gateModule.describeQuickAnswerGate(snapshot, clock.now(), gate.ttlMs), {
    key: "support:miniapp:users",
    source: "unavailable",
    everyone: false,
    membersCount: 0,
    ignoredMembers: 0,
    ageMs: 5_000,
    ttlMs: TTL,
  });
  // A clock behind the snapshot reports zero age, never a negative one.
  for (const at of [T0 - 10, Number.NaN]) {
    assert.equal(gateModule.describeQuickAnswerGate(snapshot, at, TTL).ageMs, 0, String(at));
  }
});

test("the bot's own gate fails closed on a Redis it cannot use", async (t) => {
  // The stubbed Upstash client throws on any use, as a broken one would.
  const errors = t.mock.method(console, "error", () => {});
  const snapshot = await gateModule.quickAnswerGate.load();
  assert.equal(snapshot.source, "unavailable");
  assert.deepEqual(snapshot.members, []);
  assert.equal(errors.mock.callCount(), 1);
  assert.match(String(errors.mock.calls[0].arguments[0]), /support:miniapp:users/);
});
