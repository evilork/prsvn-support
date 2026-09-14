// lib/ticket-state.ts
//
// Pure ticket state transitions: no Redis and no Telegram, so they can be unit
// tested. lib/tickets.ts loads and saves the record; the decisions live here.

import { maskSubscriptionLinks } from './redact';
import type { Ticket } from './tickets';

/** How much of the client's last text is stored for the stale cron. */
const CLIENT_TEXT_MAX = 600;

export type WaitFields = Pick<Ticket, 'status' | 'updatedAt' | 'lastClientAt' | 'lastOperatorAt'>;

/** Ждёт ли тикет ответа оператора. Старые тикеты без отметок считаем ждущими. */
export function isWaiting(t: WaitFields): boolean {
  if (t.status !== 'open') return false;
  const client = t.lastClientAt ?? t.updatedAt;
  return client > (t.lastOperatorAt ?? 0);
}

export interface ClientMessage {
  /** Epoch ms of the message. */
  now: number;
  /** message_id in the client chat, for re-copying. */
  messageId?: number;
  /** Text or caption. Masked and capped before it is stored. */
  text?: string;
  /** A short thank-you or "ok" (`isClosingMessage` in lib/client-reply.ts). */
  closing: boolean;
}

/**
 * `acknowledged` — a closing remark after the operator's reply: the ticket stays
 * answered. `waiting` — every other case: the ticket waits for the operator.
 */
export type ClientMessageEffect = 'waiting' | 'acknowledged';

/**
 * Apply one client message to the ticket record, in place.
 *
 * A closing remark after an operator reply («спасибо», «ок», 👍) is counted as
 * activity but does not move `lastClientAt`, so `isWaiting` stays false: no 🔴,
 * no personal ping, no digest line (audit BS-1). The same remark on a ticket
 * that is already waiting, or that no operator has answered yet, changes
 * nothing about waiting: the earlier question is still unanswered.
 */
export function applyClientMessage(t: Ticket, msg: ClientMessage): ClientMessageEffect {
  // Read BEFORE any field changes: on legacy tickets without `lastClientAt`,
  // isWaiting falls back to `updatedAt`, which is about to move.
  const wasWaiting = isWaiting(t);
  const answered = t.status === 'open' && (t.lastOperatorAt ?? 0) > 0 && !wasWaiting;

  t.updatedAt = msg.now;
  t.messagesCount += 1;
  if (msg.messageId) t.lastUserMsgId = msg.messageId;

  if (msg.closing && answered) {
    t.lastClientAckAt = msg.now;
    // Legacy ticket without `lastClientAt`: isWaiting would now fall back to the
    // `updatedAt` just moved and report "waiting". Pin the client mark to the
    // operator reply this remark answers.
    if (t.lastClientAt === undefined) t.lastClientAt = t.lastOperatorAt;
    return 'acknowledged';
  }

  // Отметку начала ожидания ставим на переходе «отвечен → ждёт» И тогда, когда
  // её ещё нет. Второе условие — не перестраховка: без него отметка не
  // появлялась НИКОГДА у тикета, на который оператор ещё ни разу не отвечал.
  // `isWaiting` у свежесозданного тикета уже true (`lastClientAt ?? updatedAt`
  // больше нуля), поэтому «только на переходе» означало «только со второго
  // круга», а до первого ответа оператора счётчик падал на запасной путь
  // `lastClientAt` — то есть обнулялся каждым «ну что там?» ровно у самых
  // настойчивых, у тех, ради кого всё и делалось.
  if (!t.waitingSince || !wasWaiting) t.waitingSince = msg.now;
  t.lastClientAt = msg.now;

  // Больше 600 знаков помощнику не нужно, а тикет лежит полгода.
  // A closing remark never replaces a stored question: in a ticket that is still
  // waiting, «спасибо» after «не работает» would otherwise become what the
  // operator is pinged with and what the model is asked. With no question stored
  // yet (a thank-you after /close opens a new ticket) it is kept: a ping with no
  // text at all makes the operator open the topic just to read «спасибо». The
  // stale cron does not ask the model about it (`isClosingRemark` there).
  // Links are masked before storing (audit BS-7, lib/redact.ts).
  if (typeof msg.text === 'string' && (!msg.closing || !t.lastClientText)) {
    const masked = maskSubscriptionLinks(msg.text.trim()).slice(0, CLIENT_TEXT_MAX);
    if (masked.trim()) t.lastClientText = masked;
  }
  return 'waiting';
}
