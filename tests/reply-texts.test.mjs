// tests/reply-texts.test.mjs
//
// Invariants of the texts clients read without a human in between: the FAQ
// tree (sent with parse_mode HTML) and the operator's reply templates (sent as
// plain text, no parse_mode). They carry the current state of the fleet, so
// the checks pin what went wrong before: the Netherlands advised as a cure
// (22.09.2026: Hysteria2 over UDP, cut by part of Russian operators), node
// addresses in public text, and a template key that breaks callback_data.

import { test } from "node:test";
import assert from "node:assert/strict";
import "./support/load-ts.mjs";

// lib/config.ts demands these on import; faq.ts only reads public URLs from it.
process.env.SUPPORT_BOT_TOKEN ||= "test-token";
process.env.SUPPORT_BOT_WEBHOOK_SECRET ||= "test-secret";

const { FAQ_TREE, findNode } = await import("../lib/faq.ts");
const { TEMPLATES, findTemplate } = await import("../lib/templates.ts");

/** Telegram's limit for a message text, counted after entity parsing. */
const TG_TEXT_LIMIT = 4096;
/** Telegram's limit for callback_data, in bytes. */
const TG_CALLBACK_LIMIT = 64;
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/;

function faqLeaves(node, out = []) {
  if (node.text) out.push(node);
  for (const child of node.children ?? []) faqLeaves(child, out);
  return out;
}

const stripHtml = (html) => html.replace(/<\/?(?:b|i|code)>/g, "");

/** Every sentence that mentions the Netherlands. */
const netherlandsSentences = (text) => text.match(/[^.;\n]*Нидерланд[^.;\n]*/g) ?? [];

const LEAVES = faqLeaves(FAQ_TREE);

test("template keys are unique, short and safe inside callback_data", () => {
  const seen = new Set();
  for (const { key } of TEMPLATES) {
    assert.match(key, /^[a-z0-9]{1,12}$/, `key «${key}»`);
    assert.ok(!seen.has(key), `duplicate key «${key}»`);
    seen.add(key);
    // Ticket ids are numbers; seven digits leave room for years of tickets.
    assert.ok(Buffer.byteLength(`tps:9999999:${key}`) <= TG_CALLBACK_LIMIT, `key «${key}»`);
    assert.equal(findTemplate(key)?.key, key);
  }
});

test("templates are plain text that fits one message", () => {
  for (const { key, title, text } of TEMPLATES) {
    assert.ok(title.trim().length > 0, `empty title for «${key}»`);
    assert.doesNotMatch(text, /<\/?[a-z]+[^>]*>/i, `«${key}» is sent without parse_mode, tags would show raw`);
    assert.ok(text.length <= TG_TEXT_LIMIT, `«${key}» is ${text.length} chars`);
  }
});

test("FAQ answers use only b/i/code, balanced, and fit one message", () => {
  for (const { id, text } of LEAVES) {
    for (const tag of ["b", "i", "code"]) {
      const open = text.split(`<${tag}>`).length - 1;
      const close = text.split(`</${tag}>`).length - 1;
      assert.equal(open, close, `<${tag}> unbalanced in «${id}»`);
    }
    const plain = stripHtml(text);
    assert.doesNotMatch(plain, /[<>]/, `«${id}» has a raw < or > that breaks parse_mode HTML`);
    assert.ok(plain.length <= TG_TEXT_LIMIT, `«${id}» is ${plain.length} chars`);
  }
});

test("no node address appears in any client-facing text", () => {
  for (const { id, text } of LEAVES) assert.doesNotMatch(text, IPV4, `FAQ «${id}»`);
  for (const { key, text } of TEMPLATES) assert.doesNotMatch(text, IPV4, `template «${key}»`);
});

test("the Netherlands are never offered as a location to switch to", () => {
  const texts = [
    ...LEAVES.map(({ id, text }) => [`FAQ «${id}»`, stripHtml(text)]),
    ...TEMPLATES.map(({ key, text }) => [`template «${key}»`, text]),
  ];
  for (const [where, text] of texts) {
    for (const sentence of netherlandsSentences(text)) {
      assert.match(sentence, /не выбирайте|не работа(?:ет|ют)/, `${where}: «${sentence.trim()}»`);
    }
  }
});

test("«Запасная ссылка» template names the bot and dashboard paths and the binding reset", () => {
  const tpl = findTemplate("reserve");
  assert.ok(tpl, "template «reserve» is missing");
  assert.match(tpl.text, /«📡 Мои устройства» → нужное устройство → «🆘 Запасная ссылка»/);
  assert.match(tpl.text, /зелёная кнопка «Запасная ссылка» в карточке устройства/);
  assert.match(tpl.text, /сбрасывает привязку/);
});

test("403 template sends the VPN user off the VPN, not down the domain ladder", () => {
  const tpl = findTemplate("vpn403");
  assert.ok(tpl, "template «vpn403» is missing");
  assert.match(tpl.text, /This request was blocked/);
  assert.match(tpl.text, /выключите VPN или переключитесь на другую локацию/);
  // Step 0 of the dashboard ladder: VPN off or another location, not the reserve domain.
  assert.doesNotMatch(tpl.text, /запасн/i);
});

test("FAQ on a filtered domain offers the reserve link before text links", () => {
  const text = findNode("trouble_site_blocked")?.text ?? "";
  const reserve = text.indexOf("«🆘 Запасная ссылка»");
  const textLinks = text.indexOf("«📄 Ссылки текстом»");
  assert.ok(reserve >= 0, "reserve link is missing");
  assert.ok(textLinks > reserve, "text links must come after the reserve link");
  assert.match(text, /This request was blocked/);
});

test("subscription refresh advice turns the VPN off first (entry addresses change)", () => {
  assert.match(findTemplate("refresh")?.text ?? "", /^Выключите VPN и обновите подписку/);
  assert.match(findNode("trouble_no_connect")?.text ?? "", /Выключите VPN и обновите подписку/);
  assert.match(findNode("trouble_tls")?.text ?? "", /Выключите VPN и обновите подписку/);
});
