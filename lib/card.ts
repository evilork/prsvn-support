// lib/card.ts
//
// Карточка тикета — одна на оба режима (личка и тема в группе).
//
// Сверху — кто и в каком состоянии, ниже — что мы знаем об аккаунте, внизу —
// вердикт. Кнопки: обновить, шаблоны, закрыть/открыть, бан. В личке ещё
// история и навигация по спискам; в теме история — сама тема.

import { config } from './config';
import { escapeHtml, fmtAgo, fmtDate, loadAccountPanel, renderAccountPanel } from './account';
import { TEMPLATES } from './templates';
import { isBanned, isWaiting, type Ticket } from './tickets';
import type { InlineKeyboard } from './types';

export function ticketState(t: Ticket): string {
  if (t.status === 'closed') return '✅ закрыт';
  return isWaiting(t) ? '🔴 ждёт ответа' : '🟢 отвечен';
}

export function clientLabel(t: Ticket, withId = true): string {
  const name = escapeHtml((t.firstName + (t.lastName ? ' ' + t.lastName : '')).trim() || 'без имени');
  const user = t.username ? ` @${escapeHtml(t.username)}` : '';
  const id = withId ? ` · <code>${t.userId}</code>` : '';
  return `${name}${user}${id}`;
}

export async function buildTicketCard(
  t: Ticket,
): Promise<{ text: string; keyboard: InlineKeyboard }> {
  // Карточка — украшение вокруг доставленного сообщения, и ронять доставку она
  // права не имеет: сбой чтения состояния должен превращаться в честную строку
  // «не прочиталось», а не в потерянный тикет. Пустую карточку сюда подставлять
  // нельзя — «аккаунт не найден» у платящего клиента это неверный факт, по
  // которому оператор ему и ответит.
  const [panel, banned] = await Promise.all([
    loadAccountPanel(t.userId).catch((err) => {
      console.error('[support][card] состояние аккаунта не прочиталось:', err);
      return null;
    }),
    isBanned(t.userId),
  ]);
  const now = Date.now();
  // A closing remark («спасибо») does not move `lastClientAt`, but the client did
  // write: show whichever came last.
  const lastClientMark = Math.max(t.lastClientAt ?? 0, t.lastClientAckAt ?? 0);
  const lastClient = lastClientMark ? ` · клиент писал ${fmtAgo(lastClientMark, now)}` : '';

  const text = [
    `🎫 <b>Тикет #${t.id}</b> · ${ticketState(t)}${banned ? ' · ⛔ заблокирован' : ''}`,
    `👤 ${clientLabel(t)}`,
    `🕒 создан ${fmtDate(t.createdAt)} · сообщений ${t.messagesCount}${lastClient}`,
    '',
    panel
      ? renderAccountPanel(panel, now)
      : '⚠️ Состояние аккаунта сейчас не прочиталось (сбой базы). Нажмите «🔄 Обновить».',
  ].join('\n');

  const rows: InlineKeyboard = [
    [
      { text: '🔄 Обновить', callback_data: `tk:${t.id}` },
      { text: '📋 Шаблоны', callback_data: `tp:${t.id}` },
    ],
    [
      t.status === 'open'
        ? { text: '✅ Закрыть', callback_data: `tc:${t.id}` }
        : { text: '🔓 Открыть заново', callback_data: `tr:${t.id}` },
      banned
        ? { text: '✅ Разбан', callback_data: `tu:${t.id}` }
        : { text: '🚫 Бан', callback_data: `tb:${t.id}` },
    ],
  ];

  if (!config.forumMode) {
    if (t.lastUserMsgId) rows.push([{ text: '📜 История', callback_data: `ta:${t.id}` }]);
    rows.push([
      { text: '⬅️ К списку', callback_data: t.status === 'open' ? 'ao:0' : 'ac:0' },
      { text: '🏠 Меню', callback_data: 'am' },
    ]);
  }

  return { text, keyboard: rows };
}

/**
 * Клавиатура шаблонов: по две кнопки в ряд, внизу — назад к карточке.
 * Нажатие (tpl:) открывает предпросмотр, отправка идёт отдельной кнопкой (tps:).
 */
export function templatesKeyboard(ticketId: number): InlineKeyboard {
  const rows: InlineKeyboard = [];
  for (let i = 0; i < TEMPLATES.length; i += 2) {
    rows.push(
      TEMPLATES.slice(i, i + 2).map((tpl) => ({
        text: tpl.title,
        callback_data: `tpl:${ticketId}:${tpl.key}`,
      })),
    );
  }
  rows.push([{ text: '⬅️ К карточке', callback_data: `tk:${ticketId}` }]);
  return rows;
}
