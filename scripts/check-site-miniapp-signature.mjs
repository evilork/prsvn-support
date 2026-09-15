// scripts/check-site-miniapp-signature.mjs
//
// Does the site accept initData signed with THIS bot's token?
//
// A web_app button in the support bot opens `${SITE_URL}/tg/support`, and
// Telegram signs that initData with SUPPORT_BOT_TOKEN. The site signs the
// person in only if its own SUPPORT_BOT_TOKEN holds the same value, and Vercel
// applies a new variable only on a new deploy. If it does not, everyone the
// menu sends to the Mini App gets "something went wrong" with a retry button
// that fails forever, and their menu no longer offers the in-chat assistant.
// Run this before opening the Mini App from the bot to anyone but the owner.
//
// How it checks without signing anyone in. The site verifies the hash before
// the date (validateWebAppInitData in src/lib/telegram-webapp.ts). initData
// signed with the right token but a week old gets `expired`; any other token
// gets `bad_hash`. Neither reaches loginWithTelegram, so no account, user
// record or session is created. A control request signed with a random token
// must get `bad_hash`, or the first answer means nothing.
//
// The only thing it touches on production is the site's per-IP rate-limit
// counter for the endpoint (20 a minute): two requests.
//
//   SUPPORT_BOT_TOKEN=<support bot token> node scripts/check-site-miniapp-signature.mjs https://proxysvpn.com
//
// Exit codes: 0 accepted, 1 NOT accepted (do not open the Mini App),
// 2 could not tell. The token is read from the environment and never printed.

import { createHmac, randomBytes, randomInt } from "node:crypto";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The site's sign-in route for Mini App initData. */
export const MINIAPP_AUTH_PATH = "/api/auth/telegram/miniapp";

/** How stale the probe's auth_date is. The site accepts one hour. */
export const PROBE_AGE_SEC = 7 * 24 * 60 * 60;

/** How long one request may take, ms. */
export const REQUEST_TIMEOUT_MS = 10_000;

const BOT_TOKEN_RE = /^([1-9]\d{0,19}):[A-Za-z0-9_-]{20,}$/;

/**
 * The bot's own id from its token, or null when the value is not shaped like
 * a bot token (an empty or truncated variable, the wrong one pasted).
 */
export function botIdFromToken(token) {
  if (typeof token !== "string") return null;
  const match = BOT_TOKEN_RE.exec(token);
  if (match === null) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : null;
}

/** The hash Telegram puts on initData, per the Bot API ("Validating data received via the Mini App"). */
export function signInitData(fields, token) {
  const dataCheckString = Object.entries(fields)
    .filter(([key]) => key !== "hash")
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  return createHmac("sha256", secret).update(dataCheckString).digest("hex");
}

/**
 * initData signed with `token`, stale by PROBE_AGE_SEC.
 *
 * The user is the bot itself: a bot never opens a Mini App, so even a site
 * that wrongly accepted this string could not sign a real person in.
 */
export function buildProbeInitData(token, nowSec) {
  const botId = botIdFromToken(token);
  if (botId === null) throw new TypeError("not a bot token");
  if (!Number.isSafeInteger(nowSec) || nowSec <= PROBE_AGE_SEC) throw new RangeError("nowSec must be a unix time in seconds");
  const fields = {
    auth_date: String(nowSec - PROBE_AGE_SEC),
    user: JSON.stringify({ id: botId, first_name: "signature-probe" }),
  };
  const params = new URLSearchParams(fields);
  params.set("hash", signInitData(fields, token));
  return params.toString();
}

/** A token of the right shape that no bot has. */
export function randomControlToken() {
  return `${randomInt(100_000_000, 999_999_999)}:${randomBytes(27).toString("base64url")}`;
}

/** The sign-in URL for a site base URL, or null for anything but a plain https origin (with an optional path). */
export function probeEndpoint(siteUrl) {
  if (typeof siteUrl !== "string") return null;
  const raw = siteUrl.trim();
  if (!raw || /[\s?#]/.test(raw)) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) return null;
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}${MINIAPP_AUTH_PATH}`;
}

/**
 * What the two answers mean.
 *
 * Each answer is `{ status, error }` from the site, or `{ failure }` when no
 * answer came. Returns `{ code, message }` with the script's exit code.
 */
export function verdictOf(signed, control) {
  const describe = (answer) =>
    "failure" in answer ? `no answer (${answer.failure})` : `HTTP ${answer.status} ${answer.error ?? "(no error field)"}`;

  if ("failure" in control || control.status !== 401 || control.error !== "bad_hash") {
    return {
      code: 2,
      message: `Could not tell: the control request signed with a random token got ${describe(control)}, not HTTP 401 bad_hash. The site's answers cannot be read this way right now.`,
    };
  }
  if ("failure" in signed) {
    return { code: 2, message: `Could not tell: ${describe(signed)}.` };
  }
  if (signed.status === 401 && signed.error === "expired") {
    return { code: 0, message: "Accepted: the site verifies initData signed with this SUPPORT_BOT_TOKEN." };
  }
  if (signed.status === 401 && signed.error === "bad_hash") {
    return {
      code: 1,
      message:
        "NOT accepted: the site does not know this SUPPORT_BOT_TOKEN (missing, different, or not deployed yet). Do not open the Mini App from the bot until a site deploy fixes it.",
    };
  }
  if (signed.status === 429) {
    return { code: 2, message: "Could not tell: rate-limited by the site, try again in a minute." };
  }
  return { code: 2, message: `Could not tell: the signed request got ${describe(signed)}.` };
}

async function postInitData(endpoint, initData) {
  let res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initData }),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return { failure: err instanceof Error ? err.message : String(err) };
  }
  let error = null;
  try {
    const body = await res.json();
    if (body !== null && typeof body === "object" && typeof body.error === "string") error = body.error;
  } catch {
    // Not JSON: the status alone has to speak.
  }
  return { status: res.status, error };
}

async function main() {
  const token = (process.env.SUPPORT_BOT_TOKEN ?? "").trim();
  if (botIdFromToken(token) === null) {
    console.error("SUPPORT_BOT_TOKEN is not set or does not look like a bot token (<digits>:<secret>).");
    return 2;
  }
  const siteUrl = process.argv[2] ?? process.env.SITE_URL ?? "";
  const endpoint = probeEndpoint(siteUrl);
  if (endpoint === null) {
    console.error("Pass the site as an https URL, e.g. https://proxysvpn.com (or set SITE_URL).");
    return 2;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  console.log(`POST ${endpoint}`);
  const signed = await postInitData(endpoint, buildProbeInitData(token, nowSec));
  const control = await postInitData(endpoint, buildProbeInitData(randomControlToken(), nowSec));
  const { code, message } = verdictOf(signed, control);
  console.log(message);
  return code;
}

const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error("check failed:", err instanceof Error ? err.message : err);
      process.exitCode = 2;
    },
  );
}
