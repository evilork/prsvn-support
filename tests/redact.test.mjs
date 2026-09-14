// tests/redact.test.mjs
//
// maskSubscriptionLinks: subscription tokens must never survive into the
// ticket copy that goes to operator pings and to the model (audit BS-7).

import { test } from "node:test";
import assert from "node:assert/strict";
import "./support/load-ts.mjs";

const { maskSubscriptionLinks } = await import("../lib/redact.ts");

const TOKEN = "Ab3dE_f9-KLmnOPq";

test("masks the token in a /api/sub link and keeps the query", () => {
  const out = maskSubscriptionLinks(`не работает https://proxysvpn.com/api/sub/${TOKEN}?split=0 помогите`);
  assert.equal(out, "не работает https://proxysvpn.com/api/sub/<ключ скрыт>?split=0 помогите");
  assert.ok(!out.includes(TOKEN));
});

test("masks /p, /add and /api/qr tokens", () => {
  for (const path of ["/p/", "/add/", "/api/qr/"]) {
    const out = maskSubscriptionLinks(`proxysvpn.com${path}${TOKEN}`);
    assert.equal(out, `proxysvpn.com${path}<ключ скрыт>`);
  }
});

test("masks a token path sent without a host", () => {
  assert.equal(maskSubscriptionLinks(`/api/sub/${TOKEN}/vless`), "/api/sub/<ключ скрыт>/vless");
});

test("masks token paths regardless of case", () => {
  assert.equal(
    maskSubscriptionLinks(`https://proxysvpn.com/API/SUB/${TOKEN}`),
    "https://proxysvpn.com/API/SUB/<ключ скрыт>",
  );
  assert.equal(maskSubscriptionLinks(`proxysvpn.com/P/${TOKEN}`), "proxysvpn.com/P/<ключ скрыт>");
});

test("masks a bare 32-hex subscription token, keeps dashed payment ids", () => {
  const hex = "0f9872eb5d5c0ea318d07bb6f856d31f";
  assert.equal(maskSubscriptionLinks(`мой ключ ${hex}`), "мой ключ <ключ скрыт>");
  assert.equal(maskSubscriptionLinks(hex.toUpperCase()), "<ключ скрыт>");
  assert.equal(maskSubscriptionLinks(`https://proxysvpn.com/api/sub/${hex}`), "https://proxysvpn.com/api/sub/<ключ скрыт>");

  const payment = "платёж 22e12f66-000f-5000-8000-18db351245c7";
  assert.equal(maskSubscriptionLinks(payment), payment);
  // 31 or 33 hex characters are not a token.
  assert.equal(maskSubscriptionLinks(hex.slice(1)), hex.slice(1));
  assert.equal(maskSubscriptionLinks(`${hex}a`), `${hex}a`);
});

test("masks happ://crypt4 and happ://add deep links whole", () => {
  const crypt = maskSubscriptionLinks("открываю happ://crypt4/QUJDREVGR0hJSktMTU5PUA== и ошибка");
  assert.equal(crypt, "открываю happ://<ссылка скрыта> и ошибка");

  const add = maskSubscriptionLinks(`happ://add/https://proxysvpn.com/api/sub/${TOKEN}`);
  assert.equal(add, "happ://<ссылка скрыта>");
  assert.ok(!add.includes(TOKEN));
});

test("keeps the public happ://routing profile link", () => {
  const text = "профиль happ://routing/onadd/eyJuYW1lIjoiUlUifQ";
  assert.equal(maskSubscriptionLinks(text), text);
});

test("masks raw proxy configs", () => {
  const out = maskSubscriptionLinks("vless://1b2c3d4e-0000-4000-8000-123456789abc@203.0.113.7:443?pbk=xyz#DE вот");
  assert.equal(out, "<ссылка скрыта> вот");
});

test("masks every link in one message", () => {
  const out = maskSubscriptionLinks(`/p/${TOKEN} и /api/sub/${TOKEN}X`);
  assert.equal(out, "/p/<ключ скрыт> и /api/sub/<ключ скрыт>");
});

test("leaves ordinary text, guides and short paths alone", () => {
  for (const text of [
    "спасибо, всё работает",
    "https://proxysvpn.com/guides/happ-stuck-creating-tunnel",
    "см. /p/abc",
    "платёж 22e12f66-000f-5000-8000-18db351245c7 не зачислился",
  ]) {
    assert.equal(maskSubscriptionLinks(text), text);
  }
});

test("is idempotent", () => {
  const once = maskSubscriptionLinks(`happ://crypt4/QUJD https://proxysvpn.com/api/sub/${TOKEN}`);
  assert.equal(maskSubscriptionLinks(once), once);
});

test("returns an empty string for empty input", () => {
  assert.equal(maskSubscriptionLinks(""), "");
});
