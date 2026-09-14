// tests/ticket-state.test.mjs
//
// applyClientMessage / isWaiting: a closing remark after an operator reply keeps
// the ticket answered (audit BS-1); everything else waits as before.

import { test } from "node:test";
import assert from "node:assert/strict";
import "./support/load-ts.mjs";

const { applyClientMessage, isWaiting } = await import("../lib/ticket-state.ts");
const { isClosingMessage } = await import("../lib/client-reply.ts");

const T0 = 1_757_000_000_000;
const MIN = 60_000;

/** An open ticket: client asked at T0, operator answered at T0 + 10 min. */
function answeredTicket(extra = {}) {
  return {
    id: 1,
    userId: 42,
    firstName: "Test",
    status: "open",
    createdAt: T0,
    updatedAt: T0 + 10 * MIN,
    messagesCount: 1,
    lastClientAt: T0,
    lastOperatorAt: T0 + 10 * MIN,
    lastClientText: "не подключается Германия",
    ...extra,
  };
}

/** Classify like the handler does, then apply. */
function send(t, text, at) {
  return applyClientMessage(t, { now: at, messageId: 100, text, closing: isClosingMessage({ text }) });
}

test("isWaiting: fresh ticket waits, answered does not, closed never", () => {
  assert.equal(isWaiting({ status: "open", updatedAt: T0 }), true);
  assert.equal(isWaiting(answeredTicket()), false);
  assert.equal(isWaiting({ ...answeredTicket(), lastClientAt: T0 + 11 * MIN }), true);
  assert.equal(isWaiting({ ...answeredTicket(), status: "closed", lastClientAt: T0 + 11 * MIN }), false);
});

test("thank-you after an operator reply keeps the ticket answered", () => {
  const t = answeredTicket();
  const at = T0 + 20 * MIN;
  assert.equal(send(t, "спасибо, всё работает", at), "acknowledged");

  assert.equal(isWaiting(t), false);
  assert.equal(t.waitingSince, undefined);
  assert.equal(t.lastClientAt, T0);
  assert.equal(t.lastClientAckAt, at);
  assert.equal(t.lastClientText, "не подключается Германия");
  assert.equal(t.messagesCount, 2);
  assert.equal(t.updatedAt, at);
  assert.equal(t.lastUserMsgId, 100);
});

test("thanks with a real problem after an operator reply waits", () => {
  const t = answeredTicket();
  const at = T0 + 20 * MIN;
  assert.equal(send(t, "спасибо, но не работает", at), "waiting");

  assert.equal(isWaiting(t), true);
  assert.equal(t.waitingSince, at);
  assert.equal(t.lastClientAt, at);
  assert.equal(t.lastClientText, "спасибо, но не работает");
  assert.equal(t.lastClientAckAt, undefined);
});

test("distress emoji, a sad sticker or an interrobang after an operator reply wait", () => {
  for (const text of ["🆘", "⏳", "спасибо⁉️", "работает 😐"]) {
    const t = answeredTicket();
    const at = T0 + 20 * MIN;
    assert.equal(send(t, text, at), "waiting", text);
    assert.equal(isWaiting(t), true, text);
    assert.equal(t.lastClientAckAt, undefined, text);
  }
  for (const emoji of ["😔", "🤦‍♂️"]) {
    const t = answeredTicket();
    const closing = isClosingMessage({ sticker: { file_id: "x", emoji } });
    assert.equal(applyClientMessage(t, { now: T0 + 20 * MIN, messageId: 100, closing }), "waiting", emoji);
    assert.equal(isWaiting(t), true, emoji);
  }
});

test("a question after an acknowledgement starts waiting from the question", () => {
  const t = answeredTicket();
  send(t, "👍", T0 + 20 * MIN);
  const at = T0 + 90 * MIN;
  assert.equal(send(t, "а как продлить?", at), "waiting");

  assert.equal(isWaiting(t), true);
  assert.equal(t.waitingSince, at);
  assert.equal(t.lastClientText, "а как продлить?");
});

test("thanks on a ticket no operator has answered yet still waits", () => {
  const t = { id: 2, userId: 7, firstName: "New", status: "open", createdAt: T0, updatedAt: T0, messagesCount: 0 };
  send(t, "не работает", T0 + MIN);
  assert.equal(send(t, "спасибо", T0 + 2 * MIN), "waiting");

  assert.equal(isWaiting(t), true);
  assert.equal(t.waitingSince, T0 + MIN);
  assert.equal(t.lastClientText, "не работает");
});

test("a fresh ticket with only a thank-you waits and keeps that text for the ping", () => {
  // Shaped like createTicket: a «спасибо» sent after /close opens a new ticket.
  const t = { id: 3, userId: 9, firstName: "Late", status: "open", createdAt: T0, updatedAt: T0, messagesCount: 0 };
  assert.equal(send(t, "спасибо", T0 + MIN), "waiting");

  assert.equal(isWaiting(t), true);
  assert.equal(t.lastClientText, "спасибо");
  assert.equal(t.waitingSince, T0 + MIN);
});

test("a real question replaces a stored thank-you", () => {
  const t = { id: 4, userId: 9, firstName: "Late", status: "open", createdAt: T0, updatedAt: T0, messagesCount: 0 };
  send(t, "спасибо", T0 + MIN);
  send(t, "а как продлить", T0 + 2 * MIN);
  assert.equal(t.lastClientText, "а как продлить");
  send(t, "ок", T0 + 3 * MIN);
  assert.equal(t.lastClientText, "а как продлить");
});

test("thanks while already waiting keeps the wait start and the question", () => {
  const t = answeredTicket();
  send(t, "опять не подключается", T0 + 30 * MIN);
  assert.equal(send(t, "ок", T0 + 31 * MIN), "waiting");

  assert.equal(isWaiting(t), true);
  assert.equal(t.waitingSince, T0 + 30 * MIN);
  assert.equal(t.lastClientText, "опять не подключается");
});

test("repeated nudges do not reset the wait start", () => {
  const t = answeredTicket();
  send(t, "не работает", T0 + 30 * MIN);
  send(t, "ну что там", T0 + 60 * MIN);
  assert.equal(t.waitingSince, T0 + 30 * MIN);
  assert.equal(t.lastClientText, "ну что там");
});

test("legacy ticket without lastClientAt stays answered after thanks", () => {
  const t = answeredTicket({ lastClientAt: undefined, updatedAt: T0 + 10 * MIN });
  assert.equal(isWaiting(t), false);
  assert.equal(send(t, "спасибо", T0 + 20 * MIN), "acknowledged");
  assert.equal(isWaiting(t), false);
  // No invented client time: the card would show it as «клиент писал».
  assert.equal(t.lastClientAt, undefined);
  assert.equal(t.lastClientAckAt, T0 + 20 * MIN);

  // A later real question still waits, from the question.
  assert.equal(send(t, "опять не работает", T0 + 40 * MIN), "waiting");
  assert.equal(isWaiting(t), true);
  assert.equal(t.waitingSince, T0 + 40 * MIN);
});

test("isWaiting: a legacy ticket keeps the updatedAt fallback until a closing remark", () => {
  const legacy = { status: "open", updatedAt: T0 + 20 * MIN, lastOperatorAt: T0 + 10 * MIN };
  assert.equal(isWaiting(legacy), true);
  assert.equal(isWaiting({ ...legacy, lastClientAckAt: T0 + 20 * MIN }), false);
});

test("closed ticket is never acknowledged", () => {
  const t = answeredTicket({ status: "closed" });
  assert.equal(send(t, "спасибо", T0 + 20 * MIN), "waiting");
});

test("stored text is masked and capped", () => {
  const t = answeredTicket();
  send(t, `не работает https://proxysvpn.com/api/sub/Ab3dE_f9-KLmnOPq ${"я".repeat(700)}`, T0 + 20 * MIN);
  assert.ok(!t.lastClientText.includes("Ab3dE_f9-KLmnOPq"));
  assert.ok(t.lastClientText.startsWith("не работает https://proxysvpn.com/api/sub/<ключ скрыт>"));
  assert.equal(t.lastClientText.length, 600);
});

test("message without text keeps the previous question", () => {
  const t = answeredTicket();
  assert.equal(applyClientMessage(t, { now: T0 + 20 * MIN, closing: false }), "waiting");
  assert.equal(t.lastClientText, "не подключается Германия");
  assert.equal(isWaiting(t), true);
});
