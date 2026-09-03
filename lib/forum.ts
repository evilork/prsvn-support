// lib/forum.ts
//
// Тикет как тема в группе.
//
// ── Почему темы ─────────────────────────────────────────
// В личке оператора все тикеты шли одной лентой: заголовки, сообщения
// клиентов с подписью, «✓ Ответ отправлен», и ответить можно было только
// через Reply на нужное сообщение. При трёх открытых тикетах лента путалась,
// а кнопка «показать историю» копировала сообщения ещё раз и иногда не могла
// («прокрутите вручную»).
//
// В группе с темами каждый тикет — своя тема: сообщения клиента бот кладёт в
// неё, оператор пишет в тему как в обычный чат, бот относит клиенту. История,
// непрочитанные, поиск, закрепы — всё родное для Telegram. Закрыли тикет —
// закрыли тему; клиент написал снова — открывается новая.
//
// Нужно: приватная супергруппа с включёнными темами, бот в ней администратор
// с правами «управлять темами» и «закреплять сообщения». Идентификатор
// группы — в SUPPORT_GROUP_ID; бот подсказывает его командой /id.

import { buildTicketCard } from './card';
import { config } from './config';
import { escapeHtml } from './account';
import {
  closeForumTopic,
  copyMessage,
  createForumTopic,
  editForumTopic,
  editMessageText,
  pinChatMessage,
  reopenForumTopic,
  sendMessage,
} from './telegram';
import { getTicket, getTicketMsgs, isWaiting, setTicketThread, type Ticket } from './tickets';
import type { TgMessage } from './types';

/** Сколько последних сообщений клиента переносить в тему у старого тикета. */
const MIGRATE_LAST = 10;

/** Цвет значка темы — синий, как у Telegram по умолчанию для служебного. */
const TOPIC_COLOR = 0x6fb9f0;

export function topicName(t: Ticket): string {
  const state = t.status === 'closed' ? '✅' : isWaiting(t) ? '🔴' : '🟢';
  const name = (t.firstName + (t.lastName ? ' ' + t.lastName : '')).trim().slice(0, 40) || 'без имени';
  const user = t.username ? ` @${t.username}` : '';
  return `${state} #${t.id} · ${name}${user}`;
}

export function topicUrl(threadId: number): string {
  const internal = String(config.groupId ?? '').replace(/^-100/, '');
  return `https://t.me/c/${internal}/${threadId}`;
}

/**
 * Тема для тикета: есть — вернуть, нет — создать, закрепить карточку и
 * перенести хвост переписки (у тикетов, начатых ещё в личке).
 */
export async function ensureTopic(
  ticket: Ticket,
  opts: { migrate: boolean },
): Promise<Ticket | null> {
  if (!config.groupId) return null;
  if (ticket.threadId) return ticket;

  const created = await createForumTopic(config.groupId, topicName(ticket), TOPIC_COLOR);
  if (!created.ok || !created.result) {
    console.error('[support][forum] createForumTopic failed:', created.description);
    return null;
  }
  const threadId = created.result.message_thread_id;

  const card = await buildTicketCard(ticket);
  const posted = await sendMessage(config.groupId, card.text, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: card.keyboard },
    message_thread_id: threadId,
    disable_notification: true,
  });
  const headerMsgId = posted.ok && posted.result ? posted.result.message_id : undefined;
  if (headerMsgId) await pinChatMessage(config.groupId, headerMsgId);

  await setTicketThread(ticket.id, threadId, headerMsgId);

  if (opts.migrate) {
    // Старый тикет: тема пустая, а переписка была в личке. Переносим то, что
    // ещё можно скопировать из чата клиента; неудачи молчим — история в личке
    // никуда не делась.
    const ids = (await getTicketMsgs(ticket.id)).slice(-MIGRATE_LAST);
    if (ids.length > 0) {
      await sendMessage(config.groupId, `📜 Последние сообщения клиента до переноса в тему:`, {
        message_thread_id: threadId,
        disable_notification: true,
      });
      for (const mid of ids) {
        await copyMessage(config.groupId, ticket.userId, mid, { message_thread_id: threadId });
      }
    }
  }

  return getTicket(ticket.id);
}

/** Сообщение клиента — в тему. Текст помечаем 👤, чтобы отличать от оператора. */
export async function relayClientToTopic(ticket: Ticket, msg: TgMessage): Promise<boolean> {
  if (!config.groupId || !ticket.threadId) return false;
  const thread = ticket.threadId;

  if (msg.text && msg.text.length <= 3900) {
    const r = await sendMessage(config.groupId, `👤 ${escapeHtml(msg.text)}`, {
      parse_mode: 'HTML',
      message_thread_id: thread,
    });
    return r.ok;
  }

  const caption = msg.caption ? `👤 ${escapeHtml(msg.caption)}` : '👤 (вложение)';
  let r = await copyMessage(config.groupId, ticket.userId, msg.message_id, {
    message_thread_id: thread,
    caption,
    parse_mode: 'HTML',
  });
  if (!r.ok) {
    r = await copyMessage(config.groupId, ticket.userId, msg.message_id, {
      message_thread_id: thread,
    });
  }
  return r.ok;
}

/** Имя темы отражает состояние: 🔴 ждёт, 🟢 отвечен, ✅ закрыт. */
export async function syncTopicName(ticket: Ticket): Promise<void> {
  if (!config.groupId || !ticket.threadId) return;
  await editForumTopic(config.groupId, ticket.threadId, topicName(ticket));
}

export async function closeTopic(ticket: Ticket): Promise<void> {
  if (!config.groupId || !ticket.threadId) return;
  await syncTopicName(ticket);
  await closeForumTopic(config.groupId, ticket.threadId);
}

export async function reopenTopic(ticket: Ticket): Promise<void> {
  if (!config.groupId || !ticket.threadId) return;
  await reopenForumTopic(config.groupId, ticket.threadId);
  await syncTopicName(ticket);
}

/** Перерисовать закреплённую карточку в теме. */
export async function refreshTopicCard(ticket: Ticket): Promise<void> {
  if (!config.groupId || !ticket.threadId || !ticket.headerMsgId) return;
  const card = await buildTicketCard(ticket);
  await editMessageText(config.groupId, ticket.headerMsgId, card.text, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: card.keyboard },
  });
}

/** Служебная строка в тему (что отправили клиенту шаблоном и т.п.). */
export async function noteInTopic(ticket: Ticket, text: string): Promise<void> {
  if (!config.groupId || !ticket.threadId) return;
  await sendMessage(config.groupId, text, {
    parse_mode: 'HTML',
    message_thread_id: ticket.threadId,
    disable_notification: true,
  });
}
