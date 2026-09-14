// tests/client-reply.test.mjs
//
// isClosingRemark / isClosingMessage: a short thank-you after an operator reply
// must not reopen "waiting" (audit BS-1), and anything that may still need an
// answer must keep counting as a question.

import { test } from "node:test";
import assert from "node:assert/strict";
import "./support/load-ts.mjs";

const { isClosingRemark, isClosingMessage } = await import("../lib/client-reply.ts");

test("Russian thanks and acknowledgements close", () => {
  for (const text of [
    "спасибо",
    "Спасибо!!!",
    "СПАСИБО БОЛЬШОЕ 🙏",
    "спс",
    "ок",
    "Ок, понял",
    "хорошо",
    "помогло",
    "всё работает",
    "Всё работает, спасибо",
    "всё заработало)",
    "теперь работает, благодарю",
    "ещё раз спасибо, вы лучшие",
    "спасибо, хорошего дня",
  ]) {
    assert.equal(isClosingRemark(text), true, text);
  }
});

test("English thanks and acknowledgements close", () => {
  for (const text of ["thanks", "Thank you!", "thx", "ok", "Okay", "thanks, it works now", "all good", "got it", "thank you so much"]) {
    assert.equal(isClosingRemark(text), true, text);
  }
});

test("emoji-only positive replies close", () => {
  for (const text of ["👍", "🙏🙏", "❤️", "👌 👍"]) {
    assert.equal(isClosingRemark(text), true, text);
  }
});

test("thanks followed by a real problem still waits", () => {
  for (const text of [
    "спасибо, но не работает",
    "спасибо но не работает",
    "Спасибо, а как продлить?",
    "спасибо а как продлить",
    "спасибо, всё равно не грузит",
    "ок, жду ответа",
    "thanks but it still doesn't work",
    "thanks, not working",
  ]) {
    assert.equal(isClosingRemark(text), false, text);
  }
});

test("negations, questions and complaints wait", () => {
  for (const text of [
    "не помогло",
    "не работает",
    "всё не работает",
    "работает?",
    "ок?",
    "спасибо ❓",
    "ничего не заработало",
    "опять не работает",
    "not working",
  ]) {
    assert.equal(isClosingRemark(text), false, text);
  }
});

test("bare yes/no answers wait: the operator may have asked something", () => {
  for (const text of ["да", "нет", "ага", "угу", "yes", "no"]) {
    assert.equal(isClosingRemark(text), false, text);
  }
});

test("filler words alone do not close", () => {
  for (const text of ["вам", "теперь", "всё", "it", "now", "большое"]) {
    assert.equal(isClosingRemark(text), false, text);
  }
});

test("negative or unclear emoji wait", () => {
  for (const text of ["👎", "😡", "спасибо 👎", "🤔", ")))", "...", "+"]) {
    assert.equal(isClosingRemark(text), false, text);
  }
});

test("numbers, links and long texts wait", () => {
  assert.equal(isClosingRemark("спасибо 100"), false);
  assert.equal(isClosingRemark("спасибо https://proxysvpn.com/api/sub/Ab3dE_f9-KLmnOPq"), false);
  assert.equal(isClosingRemark("спасибо ".repeat(9)), false);
  assert.equal(isClosingRemark(`спасибо ${"о".repeat(80)}`), false);
});

test("empty input waits", () => {
  assert.equal(isClosingRemark(""), false);
  assert.equal(isClosingRemark("   "), false);
});

test("isClosingMessage: plain text is classified", () => {
  assert.equal(isClosingMessage({ text: "спасибо" }), true);
  assert.equal(isClosingMessage({ text: "спасибо, но не работает" }), false);
});

test("isClosingMessage: captions on media never close", () => {
  assert.equal(isClosingMessage({ caption: "спасибо" }), false);
});

test("isClosingMessage: stickers are judged by their emoji", () => {
  assert.equal(isClosingMessage({ sticker: { file_id: "x", emoji: "👍" } }), true);
  assert.equal(isClosingMessage({ sticker: { file_id: "x", emoji: "👎" } }), false);
  assert.equal(isClosingMessage({ sticker: { file_id: "x" } }), false);
});

test("isClosingMessage: no text and no sticker waits", () => {
  assert.equal(isClosingMessage({}), false);
});
