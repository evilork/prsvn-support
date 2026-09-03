// lib/admin.ts
//
// Панель оператора: меню со списком «кто ждёт», списки, карточка тикета,
// шаблоны и действия. Карточка сама — в card.ts, тема в группе — в forum.ts.

import { escapeHtml, fmtAgo, loadAccountPanel, loadAccountPanelById, renderAccountPanel } from './account';
import { buildTicketCard, clientLabel, templatesKeyboard } from './card';
import { config } from './config';
import { closeTopic, refreshTopicCard, reopenTopic, topicUrl } from './forum';
import { editMessageText, sendMessage } from './telegram';
import { findTemplate } from './templates';
import {
  closeTicket,
  countTickets,
  getTicket,
  isWaiting,
  listTickets,
  markOperatorReply,
  reopenTicket,
  setBanned,
  type Ticket,
} from './tickets';
import type { InlineKeyboard } from './types';

/** Показать или отредактировать: сначала пробуем править, не вышло — шлём. */
async function show(
  chatId: number,
  messageId: number | null,
  text: string,
  keyboard: InlineKeyboard,
  threadId?: number,
) {
  if (messageId) {
    const res = await editMessageText(chatId, messageId, text, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard },
    });
    if (res.ok) return;
  }
  await sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard },
    message_thread_id: threadId,
  });
}

function ticketButton(t: Ticket): InlineKeyboard[number][number] {
  const mark = isWaiting(t) ? '🔴' : t.status === 'closed' ? '✅' : '🟢';
  const label = `${mark} #${t.id} · ${(t.firstName + (t.lastName ? ' ' + t.lastName : '')).trim().slice(0, 18)} · ${fmtAgo(t.updatedAt)}`;
  if (config.forumMode && t.threadId) return { text: label, url: topicUrl(t.threadId) };
  return { text: label, callback_data: `t:${t.id}` };
}

// ─── Меню ──────────────────────────────────────────────────

export async function adminMenu(): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const [open, closed, recent] = await Promise.all([
    countTickets('open'),
    countTickets('closed'),
    listTickets('open', 0, 8),
  ]);
  const waiting = recent.tickets.filter(isWaiting).length;

  const lines = [
    '<b>Поддержка ProxysVPN — панель оператора</b>',
    '',
    `📂 Открытых: <b>${open}</b> · 🔴 ждут ответа: <b>${waiting}</b> · ✅ закрытых: ${closed}`,
    '',
    config.forumMode
      ? 'Тикеты — в темах группы. Пишите в тему как в обычный чат, бот доставит клиенту. /find — найти аккаунт.'
      : 'Чтобы ответить клиенту — сделайте Reply на его сообщение. /find — найти аккаунт по ID или почте.',
  ];

  const keyboard: InlineKeyboard = recent.tickets.map((t) => [ticketButton(t)]);
  keyboard.push([
    { text: `📂 Все открытые (${open})`, callback_data: 'ao:0' },
    { text: `✅ Закрытые (${closed})`, callback_data: 'ac:0' },
  ]);
  return { text: lines.join('\n'), keyboard };
}

export async function showAdminMenu(chatId: number, threadId?: number) {
  const { text, keyboard } = await adminMenu();
  await show(chatId, null, text, keyboard, threadId);
}

export async function renderAdminMenu(chatId: number, messageId: number) {
  const { text, keyboard } = await adminMenu();
  await show(chatId, messageId, text, keyboard);
}

// ─── Списки ────────────────────────────────────────────────

export async function renderList(
  chatId: number,
  messageId: number,
  status: 'open' | 'closed',
  page: number,
) {
  const { tickets, total } = await listTickets(status, page);
  const pages = Math.max(1, Math.ceil(total / config.pageSize));
  const safePage = Math.min(Math.max(0, page), pages - 1);

  const title = status === 'open' ? '📂 Открытые тикеты' : '✅ Закрытые тикеты';
  const text =
    total === 0
      ? `<b>${title}</b>\n\nПусто.`
      : `<b>${title}</b>\n\nСтраница ${safePage + 1} из ${pages} · всего ${total}`;

  const rows: InlineKeyboard = tickets.map((t) => [ticketButton(t)]);
  const navRow: InlineKeyboard[number] = [];
  const prefix = status === 'open' ? 'ao' : 'ac';
  if (safePage > 0) navRow.push({ text: '◀️', callback_data: `${prefix}:${safePage - 1}` });
  if (safePage < pages - 1) navRow.push({ text: '▶️', callback_data: `${prefix}:${safePage + 1}` });
  if (navRow.length > 0) rows.push(navRow);
  rows.push([{ text: '⬅️ В меню', callback_data: 'am' }]);

  await show(chatId, messageId, text, rows);
}

// ─── Карточка ──────────────────────────────────────────────

export async function renderTicketCard(
  chatId: number,
  messageId: number | null,
  ticketId: number,
  threadId?: number,
) {
  const t = await getTicket(ticketId);
  if (!t) {
    await show(chatId, messageId, 'Тикет не найден.', [[{ text: '⬅️ В меню', callback_data: 'am' }]], threadId);
    return;
  }
  const card = await buildTicketCard(t);
  await show(chatId, messageId, card.text, card.keyboard, threadId);
}

export async function renderTemplates(chatId: number, messageId: number, ticketId: number) {
  const t = await getTicket(ticketId);
  if (!t) {
    await show(chatId, messageId, 'Тикет не найден.', [[{ text: '⬅️ В меню', callback_data: 'am' }]]);
    return;
  }
  const text = `📋 <b>Шаблон для #${t.id}</b> · ${clientLabel(t, false)}\n\nНажмите — текст сразу уйдёт клиенту.`;
  await show(chatId, messageId, text, templatesKeyboard(ticketId));
}

/** Отправить шаблон клиенту. Возвращает текст для всплывашки. */
export async function actionSendTemplate(ticketId: number, key: string): Promise<string> {
  const [t, tpl] = [await getTicket(ticketId), findTemplate(key)];
  if (!t) return 'Тикет не найден';
  if (!tpl) return 'Шаблон не найден';
  const res = await sendMessage(t.userId, tpl.text);
  if (!res.ok) return `Не отправлено: ${res.description || 'ошибка'}`;
  const fresh = (await markOperatorReply(ticketId)) ?? t;
  if (t.status === 'closed') await reopenTicket(ticketId);
  if (config.forumMode) {
    const { noteInTopic, syncTopicName } = await import('./forum');
    await noteInTopic(fresh, `✉️ Шаблон «${escapeHtml(tpl.title)}» отправлен клиенту:\n<i>${escapeHtml(tpl.text)}</i>`);
    await syncTopicName(fresh);
  }
  return `Отправлено: ${tpl.title}`;
}

// ─── Действия ──────────────────────────────────────────────

export async function actionCloseTicket(chatId: number, messageId: number, ticketId: number) {
  const t = await closeTicket(ticketId);
  if (t) await closeTopic(t);
  await renderTicketCard(chatId, messageId, ticketId);
}

export async function actionReopenTicket(chatId: number, messageId: number, ticketId: number) {
  const t = await reopenTicket(ticketId);
  if (t) await reopenTopic(t);
  await renderTicketCard(chatId, messageId, ticketId);
}

export async function actionBanFromTicket(chatId: number, messageId: number, ticketId: number) {
  const t = await getTicket(ticketId);
  if (!t) return;
  await setBanned(t.userId, true);
  await renderTicketCard(chatId, messageId, ticketId);
}

export async function actionUnbanFromTicket(chatId: number, messageId: number, ticketId: number) {
  const t = await getTicket(ticketId);
  if (!t) return;
  await setBanned(t.userId, false);
  await renderTicketCard(chatId, messageId, ticketId);
}

/** Обновить карточку и там, где она закреплена в теме. */
export async function actionRefreshCard(chatId: number, messageId: number, ticketId: number) {
  const t = await getTicket(ticketId);
  if (t && config.forumMode && t.headerMsgId && t.headerMsgId !== messageId) {
    await refreshTopicCard(t);
  }
  await renderTicketCard(chatId, messageId, ticketId);
}

// ─── Поиск аккаунта ────────────────────────────────────────

/**
 * /find 6123153890 · /find user@mail.ru · /find em_user@mail.ru · /find tg_…
 *
 * По имени в Telegram искать нельзя: указателя «имя → аккаунт» в базе нет.
 */
export async function findAccountText(query: string): Promise<string> {
  const q = query.trim();
  if (!q) return 'Укажите ID Telegram, почту или идентификатор аккаунта: /find 6123153890';
  let panel;
  if (/^\d{5,}$/.test(q)) panel = await loadAccountPanel(Number(q));
  else if (/^(tg_|em_)/.test(q)) panel = await loadAccountPanelById(q);
  else if (q.includes('@') && q.includes('.')) panel = await loadAccountPanelById(`em_${q.toLowerCase()}`);
  else return 'По имени искать нельзя — нужен ID Telegram (цифры), почта или tg_…/em_….';
  return `🔎 <b>${escapeHtml(q)}</b> → <code>${escapeHtml(panel.accountId)}</code>\n\n${renderAccountPanel(panel)}`;
}
