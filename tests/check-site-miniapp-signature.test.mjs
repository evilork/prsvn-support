// tests/check-site-miniapp-signature.test.mjs
//
// scripts/check-site-miniapp-signature.mjs: the probe's initData verifies the
// way the site verifies it, a stale one can never sign anyone in, the verdict
// table reads the site's answers correctly, and the script refuses to run
// without a usable token or URL. No network: the script exits on bad input
// before its first request, and the pure functions are imported directly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, timingSafeEqual } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/check-site-miniapp-signature.mjs", import.meta.url));
const probe = await import("../scripts/check-site-miniapp-signature.mjs");
const {
  MINIAPP_AUTH_PATH,
  PROBE_AGE_SEC,
  botIdFromToken,
  buildProbeInitData,
  probeEndpoint,
  randomControlToken,
  signInitData,
  verdictOf,
} = probe;

// Built from parts so a secret scanner does not read it as a real token.
const TOKEN = ["123456789", "TEST-token-for-the-signature-probe"].join(":");
const OTHER = ["987654321", "ANOTHER-token-for-the-signature-probe"].join(":");
const NOW_SEC = Math.floor(Date.UTC(2026, 8, 15, 12, 0, 0) / 1000);

/**
 * The site's check, step for step (validateWebAppInitData in
 * src/lib/telegram-webapp.ts): hash first, then age, then the user.
 */
function siteValidate(initData, token, nowSec, maxAgeSec = 3600) {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return { ok: false, reason: "no_hash" };
  const pairs = [];
  for (const [key, value] of params.entries()) if (key !== "hash") pairs.push(`${key}=${value}`);
  pairs.sort();
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const expected = Buffer.from(createHmac("sha256", secret).update(pairs.join("\n")).digest("hex"));
  const given = Buffer.from(hash.toLowerCase());
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: "bad_hash" };
  const authDate = Number(params.get("auth_date"));
  if (!Number.isInteger(authDate) || authDate <= 0 || nowSec - authDate > maxAgeSec) return { ok: false, reason: "expired" };
  return { ok: true, user: JSON.parse(params.get("user")) };
}

test("the probe verifies with its own token and is refused with any other", () => {
  const initData = buildProbeInitData(TOKEN, NOW_SEC);
  assert.deepEqual(siteValidate(initData, TOKEN, NOW_SEC), { ok: false, reason: "expired" });
  assert.deepEqual(siteValidate(initData, OTHER, NOW_SEC), { ok: false, reason: "bad_hash" });
  // The signature itself is right: with the age limit out of the way it passes.
  const accepted = siteValidate(initData, TOKEN, NOW_SEC, PROBE_AGE_SEC);
  assert.equal(accepted.ok, true);
});

test("the probe is a week old and names the bot, not a person", () => {
  const params = new URLSearchParams(buildProbeInitData(TOKEN, NOW_SEC));
  assert.equal(Number(params.get("auth_date")), NOW_SEC - PROBE_AGE_SEC);
  assert.ok(PROBE_AGE_SEC >= 7 * 24 * 3600);
  assert.deepEqual(JSON.parse(params.get("user")), { id: 123456789, first_name: "signature-probe" });
  assert.deepEqual([...params.keys()].sort(), ["auth_date", "hash", "user"]);
});

test("signInitData ignores a hash field and the order of fields", () => {
  const fields = { user: "{\"id\":1}", auth_date: "100" };
  const same = { auth_date: "100", user: "{\"id\":1}", hash: "whatever" };
  assert.equal(signInitData(fields, TOKEN), signInitData(same, TOKEN));
  assert.notEqual(signInitData(fields, TOKEN), signInitData(fields, OTHER));
  assert.match(signInitData(fields, TOKEN), /^[0-9a-f]{64}$/);
});

test("a control token has a bot token's shape and is never the same twice", () => {
  const a = randomControlToken();
  const b = randomControlToken();
  assert.notEqual(a, b);
  assert.notEqual(botIdFromToken(a), null);
  assert.deepEqual(siteValidate(buildProbeInitData(a, NOW_SEC), TOKEN, NOW_SEC), { ok: false, reason: "bad_hash" });
});

test("only values shaped like a bot token are used", () => {
  assert.equal(botIdFromToken(TOKEN), 123456789);
  for (const bad of ["", " ", "123456789", "123456789:", "abc:DEFGHIJKLMNOPQRSTUVWXYZ", "0123:ABCDEFGHIJKLMNOPQRSTUVWXYZ", `${TOKEN} `, `${TOKEN}\n`, "1:short", null, undefined, 42]) {
    assert.equal(botIdFromToken(bad), null, JSON.stringify(bad));
  }
  assert.throws(() => buildProbeInitData("nope", NOW_SEC), TypeError);
  for (const badNow of [0, -1, 1.5, Number.NaN, PROBE_AGE_SEC]) {
    assert.throws(() => buildProbeInitData(TOKEN, badNow), RangeError, String(badNow));
  }
});

test("the endpoint is the site's sign-in route on a plain https URL", () => {
  assert.equal(MINIAPP_AUTH_PATH, "/api/auth/telegram/miniapp");
  assert.equal(probeEndpoint("https://proxysvpn.com"), "https://proxysvpn.com/api/auth/telegram/miniapp");
  assert.equal(probeEndpoint(" https://proxysvpn.com/// "), "https://proxysvpn.com/api/auth/telegram/miniapp");
  assert.equal(probeEndpoint("https://example.com/base/"), "https://example.com/base/api/auth/telegram/miniapp");
  for (const bad of ["", "proxysvpn.com", "http://proxysvpn.com", "https://", "https://u:p@proxysvpn.com", "https://proxysvpn.com/?x=1", "https://proxysvpn.com#a", null, undefined]) {
    assert.equal(probeEndpoint(bad), null, JSON.stringify(bad));
  }
});

const BAD_HASH = { status: 401, error: "bad_hash" };
const EXPIRED = { status: 401, error: "expired" };

test("verdict: expired with the bot's token and bad_hash for the control means accepted", () => {
  assert.equal(verdictOf(EXPIRED, BAD_HASH).code, 0);
});

test("verdict: bad_hash with the bot's token means the site does not know it", () => {
  const verdict = verdictOf(BAD_HASH, BAD_HASH);
  assert.equal(verdict.code, 1);
  assert.match(verdict.message, /NOT accepted/);
});

test("verdict: anything else cannot be read as a yes or a no", () => {
  const unreadable = [
    // The control was not refused as a forgery: the validator may check the date first now.
    [EXPIRED, EXPIRED],
    [EXPIRED, { status: 429, error: "Too many requests" }],
    [EXPIRED, { failure: "fetch failed" }],
    [BAD_HASH, { status: 500, error: "Not configured" }],
    // The signed request itself gave no usable answer.
    [{ failure: "The operation was aborted due to timeout" }, BAD_HASH],
    [{ status: 429, error: "Too many requests" }, BAD_HASH],
    [{ status: 500, error: "Not configured" }, BAD_HASH],
    [{ status: 400, error: "initData required" }, BAD_HASH],
    [{ status: 200, error: null }, BAD_HASH],
    [{ status: 401, error: "no_user" }, BAD_HASH],
  ];
  for (const [signed, control] of unreadable) {
    assert.equal(verdictOf(signed, control).code, 2, `${JSON.stringify(signed)} / ${JSON.stringify(control)}`);
  }
});

function runScript(env, args = []) {
  const clean = { PATH: process.env.PATH, ...env };
  return spawnSync(process.execPath, [SCRIPT, ...args], { env: clean, encoding: "utf8", timeout: 10_000 });
}

test("the script refuses to run without a usable token, and never prints it", () => {
  for (const token of [undefined, "", "not-a-token"]) {
    const env = token === undefined ? {} : { SUPPORT_BOT_TOKEN: token };
    const run = runScript(env, ["https://proxysvpn.com"]);
    assert.equal(run.status, 2, JSON.stringify(token));
    assert.match(run.stderr, /SUPPORT_BOT_TOKEN/);
    assert.equal(run.stdout, "", "exits before any request");
  }
});

test("the script refuses a site URL that is not https, before any request", () => {
  for (const args of [[], ["http://proxysvpn.com"], ["proxysvpn.com"]]) {
    const run = runScript({ SUPPORT_BOT_TOKEN: TOKEN }, args);
    assert.equal(run.status, 2, JSON.stringify(args));
    assert.match(run.stderr, /https URL/);
    assert.equal(run.stdout, "");
    assert.ok(!run.stderr.includes("TEST-token"), "the token is not printed");
  }
});
