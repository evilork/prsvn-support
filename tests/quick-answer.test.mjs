// tests/quick-answer.test.mjs
//
// quickAnswerButton: who gets the ProxysAI Mini App as a web_app button follows
// the site's Redis set support:miniapp:users — the owner always, "*" everyone,
// "tg_<id>" one person — and only in their private chat. Everyone else, every
// non-private chat and every unusable SITE_URL keep the in-chat callback
// exactly as before.

import { test } from "node:test";
import assert from "node:assert/strict";
import "./support/load-ts.mjs";

const quickAnswer = await import("../lib/quick-answer.ts");
const {
  QUICK_ANSWER_CALLBACK,
  QUICK_ANSWER_LABEL,
  QUICK_ANSWER_WEBAPP_EVERYONE,
  QUICK_ANSWER_WEBAPP_PATH,
  QUICK_ANSWER_WEBAPP_USERS_KEY,
  quickAnswerButton,
  quickAnswerCallbackRetry,
  quickAnswerOpensWebApp,
  quickAnswerWebAppMember,
  quickAnswerWebAppUrl,
  summarizeQuickAnswerWebAppMembers,
} = quickAnswer;
const { OWNER_USER_ID } = await import("../lib/owner.ts");

const OWNER = 6944217115;
const SITE = "https://proxysvpn.com";
const MINI_APP = "https://proxysvpn.com/tg/support";
const OPERATOR_GROUP = -1001234567890;

const NOBODY = [];
const EVERYONE = ["*"];

const inOwnChat = (userId, webAppMembers = NOBODY, siteUrl = SITE) => ({ userId, chatId: userId, siteUrl, webAppMembers });

const CALLBACK_OPEN = { text: "⚡ Быстрый ответ", callback_data: "ai" };
const WEB_APP_OPEN = { text: "⚡ Быстрый ответ", web_app: { url: MINI_APP } };

test("the allowlist is the site's Redis set, spelled as the site spells it", () => {
  // src/lib/support-miniapp-access.ts on the frontend: the same key, "*" for
  // everyone, "tg_<telegram id>" for one person.
  assert.equal(QUICK_ANSWER_WEBAPP_USERS_KEY, "support:miniapp:users");
  assert.equal(QUICK_ANSWER_WEBAPP_EVERYONE, "*");
  assert.equal(quickAnswerWebAppMember(OWNER), "tg_6944217115");
  assert.equal(quickAnswerWebAppMember(42), "tg_42");
  for (const userId of [0, -1, -OWNER, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, String(OWNER), null, undefined]) {
    assert.equal(quickAnswerWebAppMember(userId), null, String(userId));
  }
  // The code-level allowlist is gone: the set is the only switch.
  assert.ok(!("QUICK_ANSWER_WEBAPP_USER_IDS" in quickAnswer));
  assert.equal(QUICK_ANSWER_WEBAPP_PATH, "/tg/support");
  assert.equal(QUICK_ANSWER_LABEL, CALLBACK_OPEN.text);
  assert.equal(QUICK_ANSWER_CALLBACK, CALLBACK_OPEN.callback_data);
});

test("only the menu button can open the Mini App, never «Спросить ещё»", () => {
  // «⚡ Спросить ещё» lives under an in-chat answer, where the in-chat mode is
  // on and only the bot can turn it off; it must stay the ai:more callback.
  const exported = JSON.stringify(Object.values(quickAnswer).filter((v) => typeof v !== "function"));
  assert.ok(!exported.includes("Спросить ещё"), exported);
  assert.ok(!exported.includes("ai:more"), exported);
  assert.equal(quickAnswerButton.length, 1);
});

test("the owner always gets the Mini App, whatever the set holds or if it was not read", () => {
  assert.equal(OWNER_USER_ID, OWNER);
  // An empty list is also what the gate hands over when Redis failed.
  for (const members of [NOBODY, EVERYONE, ["tg_42"], [OWNER], null, undefined, "*"]) {
    assert.deepEqual(quickAnswerButton(inOwnChat(OWNER, members)), WEB_APP_OPEN, String(members));
    assert.equal(quickAnswerOpensWebApp(OWNER, OWNER, members), true, String(members));
  }
});

test('"*" opens the Mini App to everyone in their private chat', () => {
  for (const userId of [1, 42, 123456789, OWNER - 1, OWNER + 1, 7_000_000_000]) {
    assert.deepEqual(quickAnswerButton(inOwnChat(userId, EVERYONE)), WEB_APP_OPEN, String(userId));
    assert.equal(quickAnswerOpensWebApp(userId, userId, ["tg_2", "*", "tg_3"]), true, String(userId));
  }
});

test('"tg_<id>" opens the Mini App to that person only', () => {
  const members = ["tg_42", "tg_123456789"];
  assert.deepEqual(quickAnswerButton(inOwnChat(42, members)), WEB_APP_OPEN);
  assert.deepEqual(quickAnswerButton(inOwnChat(123456789, members)), WEB_APP_OPEN);
  for (const userId of [1, 2, 4, 43, 420, 12345678, 1234567890]) {
    assert.deepEqual(quickAnswerButton(inOwnChat(userId, members)), CALLBACK_OPEN, String(userId));
    assert.equal(quickAnswerOpensWebApp(userId, userId, members), false, String(userId));
  }
});

test("everyone outside the set keeps the in-chat callback, unchanged", () => {
  for (const userId of [1, 42, 123456789, OWNER - 1, OWNER + 1, 7_000_000_000]) {
    for (const members of [NOBODY, ["tg_5"], null, undefined, "*", { 0: "*" }]) {
      assert.deepEqual(quickAnswerButton(inOwnChat(userId, members)), CALLBACK_OPEN, `${userId} ${String(members)}`);
      assert.equal(quickAnswerOpensWebApp(userId, userId, members), false, `${userId} ${String(members)}`);
    }
  }
});

test("members the site would not accept open nothing", () => {
  // Upstash hands a bare numeric member back as a number.
  const nearMisses = [42, "42", "tg_042", "TG_42", "tg-42", " tg_42", "tg_42 ", "tg_42\n", "**", " *", "all", "tg_*", "", null, ["tg_42"], ["*"]];
  for (const member of nearMisses) {
    assert.deepEqual(quickAnswerButton(inOwnChat(42, [member])), CALLBACK_OPEN, JSON.stringify(member));
  }
});

test("outside a private chat nobody gets web_app, not the owner and not with \"*\"", () => {
  for (const chatId of [OPERATOR_GROUP, -OWNER, 123456789, 0, Number.NaN]) {
    for (const webAppMembers of [NOBODY, EVERYONE]) {
      const target = { userId: OWNER, chatId, siteUrl: SITE, webAppMembers };
      assert.deepEqual(quickAnswerButton(target), CALLBACK_OPEN, String(chatId));
    }
  }
  for (const chatId of [OPERATOR_GROUP, -42, 43]) {
    const target = { userId: 42, chatId, siteUrl: SITE, webAppMembers: ["*", "tg_42"] };
    assert.deepEqual(quickAnswerButton(target), CALLBACK_OPEN, String(chatId));
  }
});

test("missing SITE_URL falls back to the callback", () => {
  // Built inline: `inOwnChat`'s default argument would turn undefined into SITE.
  for (const siteUrl of ["", "   ", undefined, null]) {
    assert.equal(quickAnswerWebAppUrl(siteUrl), null, String(siteUrl));
    for (const userId of [OWNER, 42]) {
      const target = { userId, chatId: userId, siteUrl, webAppMembers: EVERYONE };
      assert.deepEqual(quickAnswerButton(target), CALLBACK_OPEN, `${userId} ${String(siteUrl)}`);
    }
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
    assert.deepEqual(quickAnswerButton(inOwnChat(OWNER, NOBODY, siteUrl)), CALLBACK_OPEN, siteUrl);
    assert.deepEqual(quickAnswerButton(inOwnChat(42, EVERYONE, siteUrl)), CALLBACK_OPEN, siteUrl);
  }
});

test("usable SITE_URL spellings give the same Mini App URL", () => {
  for (const siteUrl of [SITE, `${SITE}/`, `${SITE}///`, `  ${SITE}  `, "https://ProxysVPN.com"]) {
    assert.equal(quickAnswerWebAppUrl(siteUrl), MINI_APP, siteUrl);
  }
  assert.equal(quickAnswerWebAppUrl("https://preview.example.com:8443"), "https://preview.example.com:8443/tg/support");
  assert.equal(quickAnswerWebAppUrl("https://example.com/base/"), "https://example.com/base/tg/support");
});

test("malformed user ids never open the Mini App, even with \"*\"", () => {
  const members = ["*", "tg_0", "tg_-1", "tg_NaN", "tg_undefined", "tg_null"];
  for (const userId of [0, -1, -OWNER, Number.NaN, Number.POSITIVE_INFINITY, OWNER + 0.5, String(OWNER), null, undefined]) {
    assert.equal(quickAnswerOpensWebApp(userId, userId, members), false, String(userId));
    const target = { userId, chatId: userId, siteUrl: SITE, webAppMembers: members };
    assert.deepEqual(quickAnswerButton(target), CALLBACK_OPEN, String(userId));
  }
});

test("a button carries exactly one action", () => {
  for (const target of [inOwnChat(OWNER), inOwnChat(42), inOwnChat(42, EVERYONE), inOwnChat(OWNER, NOBODY, "")]) {
    const button = quickAnswerButton(target);
    const actions = ["callback_data", "web_app", "url"].filter((key) => key in button);
    assert.equal(actions.length, 1, `${target.userId} (${target.siteUrl})`);
  }
});

test("the members summary counts without naming anyone", () => {
  const summarize = summarizeQuickAnswerWebAppMembers;
  assert.deepEqual(summarize([]), { everyone: false, users: 0, ignored: 0 });
  assert.deepEqual(summarize(["*"]), { everyone: true, users: 0, ignored: 0 });
  assert.deepEqual(summarize(["tg_42", "tg_6944217115", "*"]), { everyone: true, users: 2, ignored: 0 });
  // A bare id comes back from Upstash as a number; neither side accepts it.
  assert.deepEqual(
    summarize([6944217115, "6944217115", "tg_", "tg_0", "tg_01", "TG_42", " tg_42", "tg_42 ", "tg_9007199254740993", "**", "all", null, {}]),
    { everyone: false, users: 0, ignored: 13 },
  );
  for (const notAList of [null, undefined, "*", { 0: "*" }]) {
    assert.deepEqual(summarize(notAList), { everyone: false, users: 0, ignored: 0 }, String(notAList));
  }
});

// A menu as lib/faq.ts builds it: sections, the quick answer, contact.
const SECTION = { text: "🔌 Не подключается", callback_data: "faq:connect" };
const CONTACT = { text: "🆘 Связаться со специалистом", callback_data: "contact" };
const webAppMenu = () => [[SECTION], [WEB_APP_OPEN], [CONTACT]];
const REJECTED = { ok: false, error_code: 400, description: "Bad Request: BUTTON_TYPE_INVALID" };

test("keyboardOpensWebApp sees a web_app button anywhere and nothing else", () => {
  assert.equal(quickAnswer.keyboardOpensWebApp(webAppMenu()), true);
  assert.equal(quickAnswer.keyboardOpensWebApp([[SECTION], [CALLBACK_OPEN], [CONTACT]]), false);
  assert.equal(quickAnswer.keyboardOpensWebApp([]), false);
  assert.equal(quickAnswer.keyboardOpensWebApp([[]]), false);
});

test("a 400 on the Mini App menu is resent with the in-chat callback in place", () => {
  const menu = webAppMenu();
  const snapshot = structuredClone(menu);
  assert.deepEqual(quickAnswerCallbackRetry(menu, REJECTED), [[SECTION], [CALLBACK_OPEN], [CONTACT]]);
  assert.deepEqual(menu, snapshot, "the original keyboard is not mutated");
});

test("no retry unless Telegram itself rejected a keyboard with web_app", () => {
  const menu = webAppMenu();
  const callbackMenu = [[SECTION], [CALLBACK_OPEN], [CONTACT]];
  // Delivered: nothing to do.
  assert.equal(quickAnswerCallbackRetry(menu, { ok: true }), null);
  // No web_app: the failure has another cause, the same keyboard fails again.
  assert.equal(quickAnswerCallbackRetry(callbackMenu, REJECTED), null);
  // Network failure (call() returns no error_code): the first send may have arrived.
  assert.equal(quickAnswerCallbackRetry(menu, { ok: false, description: "TimeoutError" }), null);
  // Blocked by the user, flood control, server errors: a resend cannot help.
  for (const error_code of [401, 403, 404, 409, 429, 500, 502]) {
    assert.equal(quickAnswerCallbackRetry(menu, { ok: false, error_code }), null, String(error_code));
  }
});

test("the retry drops a foreign web_app button and the row it empties", () => {
  const foreign = { text: "Other app", web_app: { url: "https://example.com/app" } };
  const keyboard = [[SECTION, foreign], [foreign], [WEB_APP_OPEN], [CONTACT]];
  const retry = quickAnswerCallbackRetry(keyboard, REJECTED);
  assert.deepEqual(retry, [[SECTION], [CALLBACK_OPEN], [CONTACT]]);
  assert.equal(quickAnswer.keyboardOpensWebApp(retry), false);
});
