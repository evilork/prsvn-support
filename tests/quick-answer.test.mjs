// tests/quick-answer.test.mjs
//
// quickAnswerButton: the owner gets the ProxysAI Mini App as a web_app button in
// his private chat; everyone else, every non-private chat and every unusable
// SITE_URL keep the in-chat callback exactly as before.

import { test } from "node:test";
import assert from "node:assert/strict";
import "./support/load-ts.mjs";

const {
  QUICK_ANSWER_WEBAPP_PATH,
  QUICK_ANSWER_WEBAPP_USER_IDS,
  quickAnswerButton,
  quickAnswerOpensWebApp,
  quickAnswerWebAppUrl,
} = await import("../lib/quick-answer.ts");
const { OWNER_USER_ID } = await import("../lib/owner.ts");

const OWNER = 6944217115;
const SITE = "https://proxysvpn.com";
const MINI_APP = "https://proxysvpn.com/tg/support";
const OPERATOR_GROUP = -1001234567890;

const inOwnChat = (userId, siteUrl = SITE) => ({ userId, chatId: userId, siteUrl });

const CALLBACK_OPEN = { text: "⚡ Быстрый ответ", callback_data: "ai" };
const CALLBACK_MORE = { text: "⚡ Спросить ещё", callback_data: "ai:more" };

test("the gate is the owner alone and cannot be widened at runtime", () => {
  assert.equal(OWNER_USER_ID, OWNER);
  assert.deepEqual([...QUICK_ANSWER_WEBAPP_USER_IDS], [OWNER]);
  assert.ok(Object.isFrozen(QUICK_ANSWER_WEBAPP_USER_IDS));
  assert.throws(() => QUICK_ANSWER_WEBAPP_USER_IDS.push(123456789), TypeError);
  assert.equal(QUICK_ANSWER_WEBAPP_PATH, "/tg/support");
});

test("owner in his private chat gets web_app with the exact Mini App URL", () => {
  assert.deepEqual(quickAnswerButton("open", inOwnChat(OWNER)), {
    text: "⚡ Быстрый ответ",
    web_app: { url: MINI_APP },
  });
  assert.deepEqual(quickAnswerButton("more", inOwnChat(OWNER)), {
    text: "⚡ Спросить ещё",
    web_app: { url: MINI_APP },
  });
});

test("everyone else keeps the in-chat callback, unchanged", () => {
  for (const userId of [1, 42, 123456789, OWNER - 1, OWNER + 1, 7_000_000_000]) {
    assert.deepEqual(quickAnswerButton("open", inOwnChat(userId)), CALLBACK_OPEN, String(userId));
    assert.deepEqual(quickAnswerButton("more", inOwnChat(userId)), CALLBACK_MORE, String(userId));
    assert.equal(quickAnswerOpensWebApp(userId, userId), false, String(userId));
  }
});

test("owner outside his private chat gets the callback: web_app is invalid there", () => {
  for (const chatId of [OPERATOR_GROUP, -OWNER, 123456789, 0, Number.NaN]) {
    assert.deepEqual(quickAnswerButton("open", { userId: OWNER, chatId, siteUrl: SITE }), CALLBACK_OPEN, String(chatId));
    assert.deepEqual(quickAnswerButton("more", { userId: OWNER, chatId, siteUrl: SITE }), CALLBACK_MORE, String(chatId));
  }
});

test("missing SITE_URL falls back to the callback", () => {
  // Built inline: `inOwnChat`'s default argument would turn undefined into SITE.
  for (const siteUrl of ["", "   ", undefined, null]) {
    const target = { userId: OWNER, chatId: OWNER, siteUrl };
    assert.equal(quickAnswerWebAppUrl(siteUrl), null, String(siteUrl));
    assert.deepEqual(quickAnswerButton("open", target), CALLBACK_OPEN, String(siteUrl));
    assert.deepEqual(quickAnswerButton("more", target), CALLBACK_MORE, String(siteUrl));
  }
});

test("unusable SITE_URL falls back: Telegram would reject the whole menu", () => {
  for (const siteUrl of [
    "/",
    "proxysvpn.com",
    "http://proxysvpn.com",
    "ftp://proxysvpn.com",
    "javascript:alert(1)",
    "data:text/html,hi",
    "https://",
    "https://user:pass@proxysvpn.com",
    "https://proxysvpn.com/?next=1",
    "https://proxysvpn.com?",
    "https://proxysvpn.com#top",
    "https://proxys vpn.com",
    "https://proxysvpn.com/a b",
  ]) {
    assert.equal(quickAnswerWebAppUrl(siteUrl), null, siteUrl);
    assert.deepEqual(quickAnswerButton("open", inOwnChat(OWNER, siteUrl)), CALLBACK_OPEN, siteUrl);
  }
});

test("usable SITE_URL spellings give the same Mini App URL", () => {
  for (const siteUrl of [SITE, `${SITE}/`, `${SITE}///`, `  ${SITE}  `, "https://ProxysVPN.com"]) {
    assert.equal(quickAnswerWebAppUrl(siteUrl), MINI_APP, siteUrl);
  }
  assert.equal(quickAnswerWebAppUrl("https://preview.example.com:8443"), "https://preview.example.com:8443/tg/support");
  assert.equal(quickAnswerWebAppUrl("https://example.com/base/"), "https://example.com/base/tg/support");
});

test("malformed user ids never open the Mini App", () => {
  for (const userId of [0, -1, -OWNER, Number.NaN, Number.POSITIVE_INFINITY, OWNER + 0.5, String(OWNER), null, undefined]) {
    assert.equal(quickAnswerOpensWebApp(userId, userId), false, String(userId));
    assert.deepEqual(quickAnswerButton("open", { userId, chatId: userId, siteUrl: SITE }), CALLBACK_OPEN, String(userId));
  }
});

test("a button carries exactly one action", () => {
  for (const target of [inOwnChat(OWNER), inOwnChat(42), inOwnChat(OWNER, "")]) {
    for (const action of ["open", "more"]) {
      const button = quickAnswerButton(action, target);
      const actions = ["callback_data", "web_app", "url"].filter((key) => key in button);
      assert.equal(actions.length, 1, `${action} for ${target.userId} (${target.siteUrl})`);
    }
  }
});
