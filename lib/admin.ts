// lib/admin.ts
import { config } from './config';
import { editMessageText, sendMessage } from './telegram';
import {
  closeTicket,
  countTickets,
  getTicket,
  listTickets,
  reopenTicket,
  setBanned,
  type Ticket,
} from './tickets';
import type { InlineKeyboard } from './types';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtDate(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  // UTC+3 (Moscow / Crimea) — adjust if Anthropic infra runs UTC
  const local = new Date(ts + 3 * 60 * 60 * 1000);
  return `${pad(local.getUTCDate())}.${pad(local.getUTCMonth() + 1)} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
  void d;
}

function ticketLabel(t: Ticket): string {
  const name = t.firstName + (t.lastName ? ' ' + t.lastName : '');
  const trimmed = name.length > 20 ? name.slice(0, 19) + '…' : name;
  return `#${t.id} • ${trimmed} • ${fmtDate(t.updatedAt)}`;
}

// ─── Main admin menu ───────────────────────────────────────

export async function adminMenu(): Promise<{
  text: string;
  keyboard: InlineKeyboard;
}> {
  const [open, closed] = await Promise.all([
    countTickets('open'),
    countTickets('closed'),
  ]);
  const text = [
    '<b>Поддержка ProxysVPN — панель оператора</b>',
    '',
    `📂 Открытых тикетов: <b>${open}</b>`,
    `✅ Закрытых: <b>${closed}</b>`,
    '',
    'Чтобы ответить клиенту — сделайте Reply на любое его сообщение в этом чате.',
  ].join('\n');

  const keyboard: InlineKeyboard = [
    [{ text: `📂 Открытые (${open})`, callback_data: 'ao:0' }],
    [{ text: `✅ Закрытые (${closed})`, callback_data: 'ac:0' }],
  ];
  return { text, keyboard };
}

export async function showAdminMenu(adminChatId: number) {
  const { text, keyboard } = await adminMenu();
  await sendMessage(adminChatId, text, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard },
  });
}

export async function renderAdminMenu(adminChatId: number, messageId: number) {
  const { text, keyboard } = await adminMenu();
  const res = await editMessageText(adminChatId, messageId, text, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard },
  });
  if (!res.ok) {
    await sendMessage(adminChatId, text, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard },
    });
  }
}

// ─── Tickets list (paginated) ──────────────────────────────

export async function renderList(
  adminChatId: number,
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
      : `<b>${title}</b>\n\nСтраница ${safePage + 1} из ${pages} • всего ${total}`;

  const rows: InlineKeyboard = tickets.map((t) => [
    { text: ticketLabel(t), callback_data: `t:${t.id}` },
  ]);

  const navRow: InlineKeyboard[number] = [];
  const prefix = status === 'open' ? 'ao' : 'ac';
  if (safePage > 0) navRow.push({ text: '◀️', callback_data: `${prefix}:${safePage - 1}` });
  if (safePage < pages - 1) navRow.push({ text: '▶️', callback_data: `${prefix}:${safePage + 1}` });
  if (navRow.length > 0) rows.push(navRow);

  rows.push([{ text: '⬅️ В меню', callback_data: 'am' }]);

  const res = await editMessageText(adminChatId, messageId, text, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: rows },
  });
  if (!res.ok) {
    await sendMessage(adminChatId, text, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: rows },
    });
  }
}

// ─── Single ticket card ────────────────────────────────────

export async function renderTicketCard(
  adminChatId: number,
  messageId: number,
  ticketId: number,
) {
  const t = await getTicket(ticketId);
  if (!t) {
    await editMessageText(adminChatId, messageId, 'Тикет не найден.', {
      reply_markup: { inline_keyboard: [[{ text: '⬅️ В меню', callback_data: 'am' }]] },
    });
    return;
  }

  const name = escapeHtml(t.firstName) + (t.lastName ? ' ' + escapeHtml(t.lastName) : '');
  const usernamePart = t.username ? ` (@${escapeHtml(t.username)})` : '';
  const statusBadge = t.status === 'open' ? '🟢 Открыт' : '🔴 Закрыт';

  const text = [
    `<b>🎫 Тикет #${t.id}</b>`,
    '',
    `👤 ${name}${usernamePart}`,
    `🆔 <code>${t.userId}</code>`,
    `📅 Создан: ${fmtDate(t.createdAt)}`,
    `🔄 Обновлён: ${fmtDate(t.updatedAt)}`,
    `📨 Сообщений: ${t.messagesCount}`,
    `📊 ${statusBadge}`,
    '',
    'Чтобы ответить — Reply на любое сообщение клиента в этом чате.',
  ].join('\n');

  const rows: InlineKeyboard = [];

  if (t.lastUserMsgId) {
    rows.push([
      { text: '💬 Показать последнее сообщение', callback_data: `tl:${t.id}` },
    ]);
  }

  if (t.status === 'open') {
    rows.push([{ text: '✅ Закрыть тикет', callback_data: `tc:${t.id}` }]);
  } else {
    rows.push([{ text: '🔓 Открыть заново', callback_data: `tr:${t.id}` }]);
  }

  rows.push([{ text: '🚫 Заблокировать клиента', callback_data: `tb:${t.id}` }]);

  const backList = t.status === 'open' ? 'ao:0' : 'ac:0';
  rows.push([
    { text: '⬅️ К списку', callback_data: backList },
    { text: '🏠 В меню', callback_data: 'am' },
  ]);

  const res = await editMessageText(adminChatId, messageId, text, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: rows },
  });
  if (!res.ok) {
    await sendMessage(adminChatId, text, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: rows },
    });
  }
}

// ─── Actions invoked from ticket card ──────────────────────

export async function actionCloseTicket(
  adminChatId: number,
  messageId: number,
  ticketId: number,
) {
  await closeTicket(ticketId);
  await renderTicketCard(adminChatId, messageId, ticketId);
}

export async function actionReopenTicket(
  adminChatId: number,
  messageId: number,
  ticketId: number,
) {
  await reopenTicket(ticketId);
  await renderTicketCard(adminChatId, messageId, ticketId);
}

export async function actionBanFromTicket(
  adminChatId: number,
  messageId: number,
  ticketId: number,
) {
  const t = await getTicket(ticketId);
  if (!t) return;
  await setBanned(t.userId, true);
  await sendMessage(adminChatId, `🚫 Клиент <code>${t.userId}</code> заблокирован.`, {
    parse_mode: 'HTML',
  });
  await renderTicketCard(adminChatId, messageId, ticketId);
}
