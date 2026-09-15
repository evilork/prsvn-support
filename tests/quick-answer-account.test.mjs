// tests/quick-answer-account.test.mjs
//
// createQuickAnswerAccountCheck: whether a Telegram user reaches an account on
// the site, cached per person. One read per person per TTL, a failed, hung or
// odd read counts as "no account" and is cached too, the map is bounded, and
// has() never rejects. The clock and the reader are injected; nothing here
// touches Redis (tests/support/load-ts.mjs stubs it).

import { test } from "node:test";
import assert from "node:assert/strict";
import "./support/load-ts.mjs";

const gateModule = await import("../lib/quick-answer-gate.ts");
const {
  QUICK_ANSWER_ACCOUNT_CACHE_MAX,
  QUICK_ANSWER_GATE_TTL_MS,
  createQuickAnswerAccountCheck,
  siteAccountIdFor,
} = gateModule;

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

function recordingLog() {
  const lines = [];
  return { lines, logError: (message, err) => lines.push({ message, err }) };
}

/** A reader backed by a per-person script: `answers[id]` is a list played in order, the last repeating. */
function scriptedRead(answers) {
  const calls = [];
  const read = async (userId) => {
    const script = answers[userId] ?? [false];
    const seen = calls.filter((id) => id === userId).length;
    calls.push(userId);
    const step = script[Math.min(seen, script.length - 1)];
    if (step instanceof Error) throw step;
    return step;
  };
  return { read, calls };
}

function checkWith(answers, extra = {}) {
  const clock = manualClock();
  const log = recordingLog();
  const { read, calls } = scriptedRead(answers);
  const check = createQuickAnswerAccountCheck({ read, now: clock.now, ttlMs: TTL, logError: log.logError, ...extra });
  return { check, clock, log, calls };
}

test("defaults: the gate's minute and a bounded map", () => {
  assert.equal(QUICK_ANSWER_ACCOUNT_CACHE_MAX, 5_000);
  assert.equal(createQuickAnswerAccountCheck({ read: async () => true }).ttlMs, QUICK_ANSWER_GATE_TTL_MS);
});

test("one read per person serves every menu within the TTL", async () => {
  const { check, clock, calls } = checkWith({ 42: [true], 43: [false] });

  assert.equal(await check.has(42), true);
  assert.equal(await check.has(43), false);
  for (const step of [1, 30_000, TTL - 30_002]) {
    clock.advance(step);
    assert.equal(await check.has(42), true);
    assert.equal(await check.has(43), false);
  }
  assert.deepEqual(calls, [42, 43]);

  clock.set(T0 + TTL);
  await check.has(42);
  assert.deepEqual(calls, [42, 43, 42]);
});

test("an account created or linked on the site shows up after the TTL", async () => {
  const { check, clock } = checkWith({ 42: [false, true] });
  assert.equal(await check.has(42), false);
  clock.advance(TTL - 1);
  assert.equal(await check.has(42), false);
  clock.advance(1);
  assert.equal(await check.has(42), true);
});

test("a Redis error counts as no account, is cached and logged without the id", async () => {
  const { check, clock, log, calls } = checkWith({ 42: [new Error("ECONNRESET"), true] });

  assert.equal(await check.has(42), false);
  clock.advance(TTL - 1);
  assert.equal(await check.has(42), false);
  assert.deepEqual(calls, [42], "not retried within the TTL");
  assert.equal(log.lines.length, 1);
  assert.match(log.lines[0].message, /site account lookup failed/);
  assert.ok(!log.lines[0].message.includes("42"), log.lines[0].message);
  assert.equal(log.lines[0].err.message, "ECONNRESET");

  clock.advance(1);
  assert.equal(await check.has(42), true, "recovers on the first read after the TTL");
});

test("a reply that is not a boolean fails closed", async () => {
  for (const reply of [1, 0, "1", "true", null, undefined, [], {}, [true]]) {
    const log = recordingLog();
    const check = createQuickAnswerAccountCheck({ read: async () => reply, logError: log.logError });
    assert.equal(await check.has(42), false, JSON.stringify(reply));
    assert.equal(log.lines.length, 1, JSON.stringify(reply));
    assert.match(log.lines[0].err.message, /not a boolean/);
  }
});

test("a reader that throws synchronously fails closed instead of crashing", async () => {
  const log = recordingLog();
  const check = createQuickAnswerAccountCheck({
    read: () => {
      throw new Error("Redis used from a unit test");
    },
    logError: log.logError,
  });
  assert.equal(await check.has(42), false);
  assert.equal(log.lines.length, 1);
});

test("a lookup that never answers times out and fails closed", async () => {
  const log = recordingLog();
  const check = createQuickAnswerAccountCheck({ read: () => new Promise(() => {}), timeoutMs: 20, logError: log.logError });
  const started = Date.now();
  assert.equal(await check.has(42), false);
  assert.ok(Date.now() - started < 1_000, "the menu is not held up by a hung lookup");
  assert.match(log.lines[0].err.message, /no answer in 20 ms/);
});

test("menus that arrive during a lookup share it, per person", async () => {
  const releases = new Map();
  const calls = [];
  const check = createQuickAnswerAccountCheck({
    read: (userId) => {
      calls.push(userId);
      return new Promise((resolve) => releases.set(userId, resolve));
    },
  });
  const pending42 = [check.has(42), check.has(42), check.has(42)];
  const pending43 = check.has(43);
  assert.deepEqual(calls, [42, 43]);
  releases.get(42)(true);
  releases.get(43)(false);
  assert.deepEqual(await Promise.all(pending42), [true, true, true]);
  assert.equal(await pending43, false);
  assert.deepEqual(calls, [42, 43]);
});

test("the map never holds more than maxEntries, dropping the oldest verdict", async () => {
  const { check, calls } = checkWith({ 1: [true], 2: [true], 3: [true], 4: [true] }, { maxEntries: 3 });
  for (const id of [1, 2, 3, 4]) await check.has(id);
  assert.deepEqual(calls, [1, 2, 3, 4]);
  // 2, 3 and 4 are still cached; 1 was evicted and is read again.
  for (const id of [2, 3, 4]) await check.has(id);
  assert.deepEqual(calls, [1, 2, 3, 4]);
  await check.has(1);
  assert.deepEqual(calls, [1, 2, 3, 4, 1]);
});

test("a clock that goes backwards re-reads rather than trusting the cache forever", async () => {
  const { check, clock, calls } = checkWith({ 42: [true] });
  await check.has(42);
  clock.set(T0 - 1);
  await check.has(42);
  assert.deepEqual(calls, [42, 42]);
});

test("ids no Telegram user can have are refused without a read", async () => {
  const { check, calls, log } = checkWith({});
  for (const userId of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, "42", null, undefined]) {
    assert.equal(await check.has(userId), false, String(userId));
  }
  assert.deepEqual(calls, []);
  assert.equal(log.lines.length, 0);
});

test("a logger that throws cannot break the menu", async () => {
  const check = createQuickAnswerAccountCheck({
    read: async () => {
      throw new Error("down");
    },
    logError: () => {
      throw new Error("logger down");
    },
  });
  assert.equal(await check.has(42), false);
});

test("invalid options are refused when the check is built", () => {
  const read = async () => true;
  for (const options of [undefined, null, {}, { read: "exists" }, { read: null }]) {
    assert.throws(() => createQuickAnswerAccountCheck(options), TypeError, JSON.stringify(options));
  }
  assert.throws(() => createQuickAnswerAccountCheck({ read, now: 5 }), TypeError);
  assert.throws(() => createQuickAnswerAccountCheck({ read, logError: "console" }), TypeError);
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "60000", null]) {
    assert.throws(() => createQuickAnswerAccountCheck({ read, ttlMs: bad }), RangeError, `ttlMs ${String(bad)}`);
    assert.throws(() => createQuickAnswerAccountCheck({ read, timeoutMs: bad }), RangeError, `timeoutMs ${String(bad)}`);
    assert.throws(() => createQuickAnswerAccountCheck({ read, maxEntries: bad }), RangeError, `maxEntries ${String(bad)}`);
  }
});

test("the account id follows the alias the way the site resolves it", () => {
  assert.equal(siteAccountIdFor("tg_42", null), "tg_42");
  assert.equal(siteAccountIdFor("tg_42", undefined), "tg_42");
  assert.equal(siteAccountIdFor("tg_42", ""), "tg_42");
  assert.equal(siteAccountIdFor("tg_42", "em_user@example.com"), "em_user@example.com");
  // Upstash may hand back a parsed non-string; the site ignores such an alias too.
  for (const odd of [42, true, {}, ["em_x"]]) {
    assert.equal(siteAccountIdFor("tg_42", odd), "tg_42", JSON.stringify(odd));
  }
});

test("the bot's own account check fails closed on a Redis it cannot use", async (t) => {
  // The stubbed Upstash client throws on any use, as a broken one would.
  const errors = t.mock.method(console, "error", () => {});
  assert.equal(await gateModule.quickAnswerAccountCheck.has(42), false);
  assert.equal(errors.mock.callCount(), 1);
  assert.match(String(errors.mock.calls[0].arguments[0]), /site account lookup failed/);
});
