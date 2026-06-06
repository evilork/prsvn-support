// lib/handler.ts
import {
  actionBanFromTicket,
  actionCloseTicket,
  actionReopenTicket,
  renderAdminMenu,
  renderList,
  renderTicketCard,
  showAdminMenu,
} from './admin';
import { config, isAdmin } from './config';
import {
  buildFaqKeyboard,
  CLIENT_CONTACT_HINT,
  CLIENT_WELCOME,
  findNode,
  type FaqNode,
} from './faq';
import {
  answerCallbackQuery,
  copyMessage,
  editMessageText,
  sendMessage,
} from './telegram';
import {
  addTicketMsg,
  checkRateLimit,
  createTicket,
  getActiveTicketForUser,
  getTicket,
  getTicketMsgs,
  isBanned,
  mapAdminMsgToTicket,
  ticketFromAdminMsg,
  touchTicket,
} from './tickets';
import type { TgCallbackQuery, TgMessage, TgUser, Update } from './types';

const RATE_LIMIT_MSG = 'Слишком много сообщений. Подождите минуту.';
const BANNED_MSG = 'Вы заблокированы в поддержке.';
const GENERIC_ERROR = 'Временная ошибка. Попробуйте позже.';
const NO_ADMINS_CONFIGURED =
  'Поддержка временно недоступна. Пожалуйста, попробуйте позже.';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function stripEmoji(s: string): string {
  return s.replace(/^[^\w\dА-Яа-я]+\s*/u, '');
}

// ════════════════════════════════════════════════════════════════════
// Dispatcher
// ════════════════════════════════════════════════════════════════════

export async function handleUpdate(update: Update): Promise<void> {
  if (update.callback_query) {
    await handleCallback(update.callback_query);
    return;
  }

  const msg = update.message;
  if (!msg || msg.from?.is_bot || msg.chat.type !== 'private') return;

  const fromId = msg.from?.id;
  if (!fromId) return;

  if (isAdmin(fromId)) {
    await handleAdminMessage(msg);
  } else {
    await handleClientMessage(msg);
  }
}

// ════════════════════════════════════════════════════════════════════
// Client (private chat, not admin)
// ════════════════════════════════════════════════════════════════════

async function handleClientMessage(msg: TgMessage): Promise<void> {
  const user = msg.from!;

  if (await isBanned(user.id)) {
    await sendMessage(user.id, BANNED_MSG);
    return;
  }

  const text = (msg.text || '').trim();
  if (text === '/start' || text === '/help' || text === '/menu') {
    await showClientMenu(user.id);
    return;
  }

  if (config.adminUserIds.length === 0) {
    await sendMessage(user.id, NO_ADMINS_CONFIGURED);
    return;
  }

  if (!(await checkRateLimit(user.id, config.rateLimitPerMinute))) {
    await sendMessage(user.id, RATE_LIMIT_MSG);
    return;
  }

  await forwardClientToAdmins(user, msg);
}

async function showClientMenu(userId: number) {
  const root = findNode('menu')!;
  await sendMessage(userId, CLIENT_WELCOME, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buildFaqKeyboard(root) },
  });
}

async function forwardClientToAdmins(user: TgUser, msg: TgMessage) {
  // Get or create ticket
  let ticket = await getActiveTicketForUser(user.id);
  let isNew = false;
  if (!ticket) {
    ticket = await createTicket(user);
    isNew = true;
  }

  const usernamePart = user.username ? ` @${escapeHtml(user.username)}` : '';
  const fullName =
    escapeHtml(user.first_name) +
    (user.last_name ? ' ' + escapeHtml(user.last_name) : '');

  for (const adminId of config.adminUserIds) {
    // Header (only on new ticket or every 10th message — saves chat clutter)
    if (isNew || ticket.messagesCount === 0 || ticket.messagesCount % 10 === 0) {
      const header = [
        `🎫 <b>Тикет #${ticket.id}</b>${isNew ? ' (новый)' : ''}`,
        `👤 ${fullName}${usernamePart} • <code>${user.id}</code>`,
      ].join('\n');
      const headerRes = await sendMessage(adminId, header, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: 'Открыть тикет', callback_data: `t:${ticket.id}` }]],
        },
      });
      if (headerRes.ok && headerRes.result) {
        await mapAdminMsgToTicket(headerRes.result.message_id, ticket.id);
      }
    }

    const sig = `👤 ${fullName}${usernamePart} • <code>${user.id}</code> • #${ticket.id}`;
    const asText = !!msg.text && msg.text.length <= 3900;
    let relayed: Awaited<ReturnType<typeof sendMessage>>;
    let needSeparateSig = false;
    if (asText) {
      relayed = await sendMessage(
        adminId,
        `${escapeHtml(msg.text!)}

${sig}`,
        { parse_mode: 'HTML' },
      );
    } else {
      const cap = msg.caption
        ? `${escapeHtml(msg.caption)}

${sig}`
        : sig;
      relayed = await copyMessage(adminId, user.id, msg.message_id, {
        caption: cap,
        parse_mode: 'HTML',
      });
      if (!relayed.ok) {
        relayed = await copyMessage(adminId, user.id, msg.message_id);
        needSeparateSig = true;
      }
    }
    if (relayed.ok && relayed.result) {
      await mapAdminMsgToTicket(relayed.result.message_id, ticket.id);
      await touchTicket(ticket.id, msg.message_id);
      await addTicketMsg(ticket.id, msg.message_id);
      if (needSeparateSig) {
        const sr = await sendMessage(adminId, sig, { parse_mode: 'HTML' });
        if (sr.ok && sr.result) await mapAdminMsgToTicket(sr.result.message_id, ticket.id);
      }
    } else {
      console.warn('[support] relay to admin failed:', relayed.description);
    }
  }
}

// ════════════════════════════════════════════════════════════════════
// Admin (private chat, admin user)
// ════════════════════════════════════════════════════════════════════

async function handleAdminMessage(msg: TgMessage): Promise<void> {
  const text = (msg.text || '').trim();

  if (text === '/start' || text === '/menu' || text === '/help') {
    await showAdminMenu(msg.chat.id);
    return;
  }

  // Reply on a client message — send to client
  if (msg.reply_to_message) {
    const repliedId = msg.reply_to_message.message_id;
    const ticketId = await ticketFromAdminMsg(repliedId);
    if (!ticketId) {
      await sendMessage(
        msg.chat.id,
        '⚠️ Не нашёл тикет для этого сообщения. Возможно, оно слишком старое.',
      );
      return;
    }

    const ticket = await getTicket(ticketId);
    if (!ticket) {
      await sendMessage(msg.chat.id, '⚠️ Тикет удалён или не существует.');
      return;
    }

    // If ticket is closed, auto-reopen
    if (ticket.status === 'closed') {
      const { reopenTicket } = await import('./tickets');
      await reopenTicket(ticketId);
    }

    const res = await copyMessage(ticket.userId, msg.chat.id, msg.message_id);
    if (res.ok) {
      await sendMessage(msg.chat.id, `✓ Ответ отправлен в тикет #${ticketId}`);
    } else {
      await sendMessage(
        msg.chat.id,
        `⚠️ Не удалось отправить: ${escapeHtml(res.description || '')}`,
        { parse_mode: 'HTML' },
      );
    }
    return;
  }

  // Any other message in admin chat — show menu hint
  await sendMessage(
    msg.chat.id,
    'Чтобы ответить клиенту — сделайте Reply на его сообщение в этом чате.\nОткрыть меню — /start',
  );
}

// ════════════════════════════════════════════════════════════════════
// Callback queries
// ════════════════════════════════════════════════════════════════════

async function handleCallback(cb: TgCallbackQuery): Promise<void> {
  const data = cb.data || '';
  const user = cb.from;
  const msg = cb.message;
  if (!msg) {
    await answerCallbackQuery(cb.id);
    return;
  }

  // Admin-only callbacks
  if (isAdmin(user.id)) {
    await handleAdminCallback(cb, data);
    return;
  }

  // Client callbacks
  if (await isBanned(user.id)) {
    await answerCallbackQuery(cb.id, BANNED_MSG, true);
    return;
  }

  if (data === 'contact') {
    await answerCallbackQuery(cb.id);
    await sendMessage(user.id, CLIENT_CONTACT_HINT, { parse_mode: 'HTML' });
    return;
  }

  if (data.startsWith('faq:')) {
    const nodeId = data.slice(4);
    const node = findNode(nodeId);
    if (!node) {
      await answerCallbackQuery(cb.id, 'Раздел не найден', true);
      return;
    }
    await answerCallbackQuery(cb.id);
    await renderFaqNode(user.id, msg.message_id, node);
    return;
  }

  await answerCallbackQuery(cb.id);
}

async function renderFaqNode(chatId: number, messageId: number, node: FaqNode) {
  const text = node.text
    ? `<b>${escapeHtml(stripEmoji(node.title))}</b>\n\n${node.text}`
    : CLIENT_WELCOME;

  const res = await editMessageText(chatId, messageId, text, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buildFaqKeyboard(node) },
  });
  if (!res.ok) {
    await sendMessage(chatId, text, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buildFaqKeyboard(node) },
    });
  }
}

async function handleAdminCallback(cb: TgCallbackQuery, data: string) {
  const chatId = cb.message!.chat.id;
  const messageId = cb.message!.message_id;
  await answerCallbackQuery(cb.id);

  if (data === 'am') {
    await renderAdminMenu(chatId, messageId);
    return;
  }

  if (data.startsWith('ao:') || data.startsWith('ac:')) {
    const [prefix, pageStr] = data.split(':');
    const page = parseInt(pageStr, 10) || 0;
    const status = prefix === 'ao' ? 'open' : 'closed';
    await renderList(chatId, messageId, status, page);
    return;
  }

  if (data.startsWith('t:')) {
    const id = parseInt(data.slice(2), 10);
    await renderTicketCard(chatId, messageId, id);
    return;
  }

  if (data.startsWith('tc:')) {
    const id = parseInt(data.slice(3), 10);
    await actionCloseTicket(chatId, messageId, id);
    return;
  }

  if (data.startsWith('tr:')) {
    const id = parseInt(data.slice(3), 10);
    await actionReopenTicket(chatId, messageId, id);
    return;
  }

  if (data.startsWith('tb:')) {
    const id = parseInt(data.slice(3), 10);
    await actionBanFromTicket(chatId, messageId, id);
    return;
  }

  if (data.startsWith('ta:')) {
    const id = parseInt(data.slice(3), 10);
    const t = await getTicket(id);
    if (!t) {
      await sendMessage(chatId, 'Тикет не найден.');
      return;
    }
    let ids = await getTicketMsgs(id);
    if (ids.length === 0 && t.lastUserMsgId) ids = [t.lastUserMsgId];
    if (ids.length === 0) {
      await sendMessage(chatId, 'Сообщений в тикете нет.');
      return;
    }
    const MAX = 20;
    const slice = ids.slice(-MAX);
    const more = ids.length > slice.length ? ` из ${ids.length}` : '';
    await sendMessage(
      chatId,
      `📜 Сообщения тикета #${id} (${slice.length}${more}):`,
      { parse_mode: 'HTML' },
    );
    for (const mid of slice) {
      let r = await copyMessage(chatId, t.userId, mid);
      if (!r.ok) r = await copyMessage(chatId, chatId, mid);
      if (r.ok && r.result) {
        await mapAdminMsgToTicket(r.result.message_id, id);
      }
    }
    return;
  }

  if (data.startsWith('tl:')) {
    const id = parseInt(data.slice(3), 10);
    const t = await getTicket(id);
    if (!t || !t.lastUserMsgId) {
      await sendMessage(chatId, 'Последнее сообщение не найдено.');
      return;
    }
    // New tickets: lastUserMsgId is the original id in the client chat
    let res = await copyMessage(chatId, t.userId, t.lastUserMsgId);
    // Legacy tickets: id was the copy in the admin chat — re-copy from here
    if (!res.ok) {
      res = await copyMessage(chatId, chatId, t.lastUserMsgId);
    }
    if (res.ok && res.result) {
      await mapAdminMsgToTicket(res.result.message_id, id);
    } else {
      // Fallback: scroll hint — TG doesn't have deep-link to msg in DM
      await sendMessage(
        chatId,
        `Не удалось показать сообщение. Прокрутите чат к сообщению ID ${t.lastUserMsgId} вручную.`,
      );
    }
    return;
  }
}
