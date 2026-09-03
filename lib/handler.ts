// lib/handler.ts
//
// Диспетчер обновлений Telegram.
//
// Два режима оператора (см. config.forumMode):
//   • личка — как раньше: сообщения клиентов приходят оператору в личный чат,
//     ответ — Reply на сообщение клиента;
//   • группа с темами — тикет = тема, оператор пишет в тему, бот относит
//     клиенту. Личка при этом остаётся запасным каналом на случай, если тему
//     создать не удалось.

import {
  actionBanFromTicket,
  actionCloseStale,
  actionCloseTicket,
  actionRefreshCard,
  actionReopenTicket,
  actionSendTemplate,
  actionUnbanFromTicket,
  findAccountText,
  renderAdminMenu,
  renderList,
  renderStaleConfirm,
  renderTemplates,
  renderTicketCard,
  showAdminMenu,
} from './admin';
import { escapeHtml } from './account';
import { config, isAdmin } from './config';
import {
  buildFaqKeyboard,
  CLIENT_CONTACT_HINT,
  CLIENT_WELCOME,
  findNode,
  type FaqNode,
} from './faq';
import { ensureTopic, relayClientToTopic, reopenTopic, syncTopicName } from './forum';
import {
  answerCallbackQuery,
  copyMessage,
  editMessageText,
  sendMessage,
  setMessageReaction,
} from './telegram';
import {
  addTicketMsg,
  checkRateLimit,
  createTicket,
  getActiveTicketForUser,
  getTicket,
  getTicketMsgs,
  isBanned,
  isWaiting,
  mapAdminMsgToTicket,
  markOperatorReply,
  reopenTicket,
  setBanned,
  ticketFromAdminMsg,
  ticketFromThread,
  touchTicket,
  type Ticket,
} from './tickets';
import type { TgCallbackQuery, TgMessage, TgUser, Update } from './types';

const RATE_LIMIT_MSG = 'Слишком много сообщений. Подождите минуту.';
const BANNED_MSG = 'Вы заблокированы в поддержке.';
const NO_ADMINS_CONFIGURED =
  'Поддержка временно недоступна. Пожалуйста, попробуйте позже.';

function stripEmoji(s: string): string {
  return s.replace(/^[^\w\dА-Яа-я]+\s*/u, '');
}

/** Служебное сообщение Telegram о теме — не переписка. */
function isServiceMessage(msg: TgMessage): boolean {
  return !!(msg.forum_topic_created || msg.forum_topic_closed || msg.forum_topic_reopened || msg.pinned_message);
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
  if (!msg || msg.from?.is_bot) return;
  const fromId = msg.from?.id;
  if (!fromId) return;

  if (msg.chat.type === 'private') {
    if (isAdmin(fromId)) await handleAdminMessage(msg);
    else await handleClientMessage(msg);
    return;
  }

  if (msg.chat.type === 'supergroup' || msg.chat.type === 'group') {
    if (!isAdmin(fromId)) return;
    if (config.groupId !== null && msg.chat.id === config.groupId) {
      await handleGroupMessage(msg);
      return;
    }
    // Бот в чужой или ещё не настроенной группе: единственное, что он тут
    // делает, — называет её идентификатор для SUPPORT_GROUP_ID.
    const text = (msg.text || '').trim();
    if (/^\/id(@\w+)?$/.test(text) || /^\/start(@\w+)?$/.test(text)) {
      await sendMessage(msg.chat.id, setupHint(msg.chat.id, !!msg.chat.is_forum), {
        parse_mode: 'HTML',
        message_thread_id: msg.message_thread_id,
      });
    }
  }
}

function setupHint(chatId: number, isForum: boolean): string {
  return [
    `Идентификатор этой группы: <code>${chatId}</code>`,
    '',
    'Чтобы вести тикеты здесь:',
    isForum ? '✅ темы включены' : '1) включите «Темы» в настройках группы;',
    '2) сделайте бота администратором с правами «Управление темами» и «Закрепление сообщений»;',
    `3) добавьте переменную SUPPORT_GROUP_ID=${chatId} в Vercel и переразверните бота.`,
  ].join('\n');
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
  let ticket = await getActiveTicketForUser(user.id);
  let isNew = false;
  if (!ticket) {
    ticket = await createTicket(user);
    isNew = true;
  }
  const wasWaiting = isWaiting(ticket);

  const touched = await touchTicket(ticket.id, msg.message_id);
  await addTicketMsg(ticket.id, msg.message_id);
  const fresh = touched ?? ticket;

  if (config.forumMode) {
    const delivered = await relayViaForum(fresh, msg, isNew, wasWaiting);
    if (delivered) return;
    console.warn('[support] forum relay failed, falling back to private chats');
  }

  await relayViaPrivate(fresh, user, msg, isNew);
}

/** Тема в группе: создать при необходимости, положить сообщение, обновить имя. */
async function relayViaForum(
  ticket: Ticket,
  msg: TgMessage,
  isNew: boolean,
  wasWaiting: boolean,
): Promise<boolean> {
  let t: Ticket | null = ticket;
  if (!t.threadId) {
    t = await ensureTopic(ticket, { migrate: !isNew });
    if (!t || !t.threadId) return false;
  } else if (!wasWaiting) {
    // Был отвечен — снова ждёт: имя темы должно это показать.
    await syncTopicName(t);
  }
  return relayClientToTopic(t, msg);
}

/** Прежний режим: личка каждого оператора. */
async function relayViaPrivate(ticket: Ticket, user: TgUser, msg: TgMessage, isNew: boolean) {
  const usernamePart = user.username ? ` @${escapeHtml(user.username)}` : '';
  const fullName =
    escapeHtml(user.first_name) + (user.last_name ? ' ' + escapeHtml(user.last_name) : '');

  for (const adminId of config.adminUserIds) {
    // Карточка — на новый тикет и каждое десятое сообщение, чтобы не засорять.
    if (isNew || ticket.messagesCount % 10 === 1) {
      await renderTicketCard(adminId, null, ticket.id);
    }

    const sig = `#${ticket.id} · ${fullName}${usernamePart} · <code>${user.id}</code>`;
    const asText = !!msg.text && msg.text.length <= 3900;
    let relayed: Awaited<ReturnType<typeof sendMessage>>;
    let needSeparateSig = false;
    if (asText) {
      relayed = await sendMessage(adminId, `${escapeHtml(msg.text!)}\n\n${sig}`, { parse_mode: 'HTML' });
    } else {
      const cap = msg.caption ? `${escapeHtml(msg.caption)}\n\n${sig}` : sig;
      relayed = await copyMessage(adminId, user.id, msg.message_id, { caption: cap, parse_mode: 'HTML' });
      if (!relayed.ok) {
        relayed = await copyMessage(adminId, user.id, msg.message_id);
        needSeparateSig = true;
      }
    }
    if (relayed.ok && relayed.result) {
      await mapAdminMsgToTicket(relayed.result.message_id, ticket.id);
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
// Operator reply → client (общее для лички и темы)
// ════════════════════════════════════════════════════════════════════

/**
 * Отнести сообщение оператора клиенту. Успех помечаем реакцией 👌 на самом
 * сообщении; если реакции в чате запрещены — короткой строкой.
 */
async function deliverOperatorMessage(ticket: Ticket, msg: TgMessage): Promise<boolean> {
  let t = ticket;
  if (t.status === 'closed') {
    const reopened = await reopenTicket(t.id);
    if (reopened) {
      t = reopened;
      await reopenTopic(t);
    }
  }

  const res = await copyMessage(t.userId, msg.chat.id, msg.message_id);
  if (!res.ok) {
    await sendMessage(msg.chat.id, `⚠️ Не доставлено: ${escapeHtml(res.description || 'ошибка')}`, {
      parse_mode: 'HTML',
      message_thread_id: msg.message_thread_id,
    });
    return false;
  }

  const wasWaiting = isWaiting(t);
  const fresh = (await markOperatorReply(t.id)) ?? t;
  const reacted = await setMessageReaction(msg.chat.id, msg.message_id);
  if (!reacted.ok) {
    await sendMessage(msg.chat.id, `✓ #${t.id}`, { message_thread_id: msg.message_thread_id, disable_notification: true });
  }
  if (wasWaiting) await syncTopicName(fresh);
  return true;
}

// ════════════════════════════════════════════════════════════════════
// Admin (private chat)
// ════════════════════════════════════════════════════════════════════

async function handleAdminMessage(msg: TgMessage): Promise<void> {
  const text = (msg.text || '').trim();

  if (text === '/start' || text === '/menu' || text === '/help') {
    await showAdminMenu(msg.chat.id);
    return;
  }
  if (/^\/id/.test(text)) {
    await sendMessage(msg.chat.id, `Ваш ID: <code>${msg.from!.id}</code>`, { parse_mode: 'HTML' });
    return;
  }
  if (/^\/find\b/.test(text)) {
    await sendMessage(msg.chat.id, await findAccountText(text.replace(/^\/find\s*/, '')), { parse_mode: 'HTML' });
    return;
  }
  const cmd = text.match(/^\/(close|reopen|card|ban|unban)\s+#?(\d+)$/);
  if (cmd) {
    await runTicketCommand(cmd[1], parseInt(cmd[2], 10), msg.chat.id, undefined);
    return;
  }

  // Reply на сообщение клиента — отправить клиенту
  if (msg.reply_to_message) {
    const ticketId = await ticketFromAdminMsg(msg.reply_to_message.message_id);
    if (!ticketId) {
      await sendMessage(msg.chat.id, '⚠️ Не нашёл тикет для этого сообщения. Откройте тикет из меню /start и ответьте на его карточку или сообщение клиента.');
      return;
    }
    const ticket = await getTicket(ticketId);
    if (!ticket) {
      await sendMessage(msg.chat.id, '⚠️ Тикет удалён или не существует.');
      return;
    }
    await deliverOperatorMessage(ticket, msg);
    return;
  }

  await sendMessage(
    msg.chat.id,
    config.forumMode
      ? 'Тикеты ведутся в темах группы. Здесь: /start — панель, /find — найти аккаунт.'
      : 'Чтобы ответить клиенту — сделайте Reply на его сообщение.\n/start — панель, /find — найти аккаунт, /close 12 — закрыть тикет.',
  );
}

// ════════════════════════════════════════════════════════════════════
// Operator group (forum topics)
// ════════════════════════════════════════════════════════════════════

async function handleGroupMessage(msg: TgMessage): Promise<void> {
  if (isServiceMessage(msg)) return;
  const text = (msg.text || '').trim();
  const threadId = msg.message_thread_id;

  // «General» — панель и поиск.
  const ticketId = threadId ? await ticketFromThread(threadId) : null;
  if (!ticketId) {
    if (/^\/(start|menu|help)(@\w+)?$/.test(text)) {
      await showAdminMenu(msg.chat.id, threadId);
    } else if (/^\/id(@\w+)?$/.test(text)) {
      await sendMessage(msg.chat.id, `Группа: <code>${msg.chat.id}</code>, тема: <code>${threadId ?? '—'}</code>`, {
        parse_mode: 'HTML',
        message_thread_id: threadId,
      });
    } else if (/^\/find\b/.test(text)) {
      await sendMessage(msg.chat.id, await findAccountText(text.replace(/^\/find\S*\s*/, '')), {
        parse_mode: 'HTML',
        message_thread_id: threadId,
      });
    } else if (threadId && text) {
      await sendMessage(msg.chat.id, 'Эта тема не привязана к тикету — клиенту ничего не ушло.', {
        message_thread_id: threadId,
        disable_notification: true,
      });
    }
    return;
  }

  const ticket = await getTicket(ticketId);
  if (!ticket) {
    await sendMessage(msg.chat.id, 'Тикет этой темы не найден в базе.', { message_thread_id: threadId });
    return;
  }

  const cmd = text.match(/^\/(close|reopen|card|ban|unban|tpl)(@\w+)?$/);
  if (cmd) {
    await runTicketCommand(cmd[1], ticket.id, msg.chat.id, threadId);
    return;
  }

  await deliverOperatorMessage(ticket, msg);
}

/** Команды над тикетом — из лички с номером или из темы без него. */
async function runTicketCommand(cmd: string, ticketId: number, chatId: number, threadId?: number) {
  const t = await getTicket(ticketId);
  if (!t) {
    await sendMessage(chatId, `Тикет #${ticketId} не найден.`, { message_thread_id: threadId });
    return;
  }
  switch (cmd) {
    case 'close': {
      const { closeTicket } = await import('./tickets');
      const closed = await closeTicket(ticketId);
      if (closed) {
        const { closeTopic } = await import('./forum');
        await closeTopic(closed);
      }
      await sendMessage(chatId, `✅ Тикет #${ticketId} закрыт.`, { message_thread_id: threadId, disable_notification: true });
      return;
    }
    case 'reopen': {
      const reopened = await reopenTicket(ticketId);
      if (reopened) await reopenTopic(reopened);
      await sendMessage(chatId, `🔓 Тикет #${ticketId} открыт заново.`, { message_thread_id: threadId, disable_notification: true });
      return;
    }
    case 'ban':
    case 'unban': {
      await setBanned(t.userId, cmd === 'ban');
      await sendMessage(chatId, cmd === 'ban' ? `🚫 Клиент заблокирован в поддержке.` : `✅ Клиент разблокирован.`, {
        message_thread_id: threadId,
        disable_notification: true,
      });
      return;
    }
    case 'tpl': {
      const { renderTemplates } = await import('./admin');
      const sent = await sendMessage(chatId, '📋 Шаблоны…', { message_thread_id: threadId, disable_notification: true });
      if (sent.ok && sent.result) await renderTemplates(chatId, sent.result.message_id, ticketId);
      return;
    }
    default:
      await renderTicketCard(chatId, null, ticketId, threadId);
  }
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

  if (isAdmin(user.id)) {
    await handleAdminCallback(cb, data);
    return;
  }

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
    const node = findNode(data.slice(4));
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
  const threadId = cb.message!.message_thread_id;
  const [kind, a, b] = data.split(':');
  const id = parseInt(a || '', 10);

  switch (kind) {
    case 'am':
      await answerCallbackQuery(cb.id);
      await renderAdminMenu(chatId, messageId);
      return;
    case 'ao':
    case 'ac':
      await answerCallbackQuery(cb.id);
      await renderList(chatId, messageId, kind === 'ao' ? 'open' : 'closed', parseInt(a || '0', 10) || 0);
      return;
    case 'tz':
      await answerCallbackQuery(cb.id);
      await renderStaleConfirm(chatId, messageId, id || 7);
      return;
    case 'tzy':
      await answerCallbackQuery(cb.id, 'Закрываю…');
      await actionCloseStale(chatId, messageId, id || 7);
      return;
    case 't':
      await answerCallbackQuery(cb.id);
      await renderTicketCard(chatId, messageId, id, threadId);
      return;
    case 'tk':
      await answerCallbackQuery(cb.id, 'Обновляю…');
      await actionRefreshCard(chatId, messageId, id);
      return;
    case 'tp':
      await answerCallbackQuery(cb.id);
      await renderTemplates(chatId, messageId, id);
      return;
    case 'tpl': {
      const note = await actionSendTemplate(id, b || '');
      await answerCallbackQuery(cb.id, note, !note.startsWith('Отправлено'));
      await renderTicketCard(chatId, messageId, id, threadId);
      return;
    }
    case 'tc':
      await answerCallbackQuery(cb.id, 'Закрыт');
      await actionCloseTicket(chatId, messageId, id);
      return;
    case 'tr':
      await answerCallbackQuery(cb.id, 'Открыт заново');
      await actionReopenTicket(chatId, messageId, id);
      return;
    case 'tb':
      await answerCallbackQuery(cb.id, 'Заблокирован');
      await actionBanFromTicket(chatId, messageId, id);
      return;
    case 'tu':
      await answerCallbackQuery(cb.id, 'Разблокирован');
      await actionUnbanFromTicket(chatId, messageId, id);
      return;
    case 'ta': {
      // История в личке: копии последних сообщений клиента.
      await answerCallbackQuery(cb.id);
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
      const slice = ids.slice(-20);
      await sendMessage(chatId, `📜 Сообщения тикета #${id} (${slice.length}${ids.length > slice.length ? ` из ${ids.length}` : ''}):`);
      for (const mid of slice) {
        let r = await copyMessage(chatId, t.userId, mid);
        if (!r.ok) r = await copyMessage(chatId, chatId, mid);
        if (r.ok && r.result) await mapAdminMsgToTicket(r.result.message_id, id);
      }
      return;
    }
    default:
      await answerCallbackQuery(cb.id);
  }
}
