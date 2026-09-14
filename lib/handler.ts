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
  renderTemplatePreview,
  renderTemplates,
  renderTicketCard,
  showAdminMenu,
} from './admin';
import { escapeHtml } from './account';
import { awayNotice, claimAwayNote, clearAway, parseAwayUntil, readAway, setAway } from './away';
import {
  aiModeStartedAt,
  aiTranscript,
  albumCountsAsMessage,
  albumMessages,
  albumWentToOperator,
  askProxysAi,
  claimAttachmentBudget,
  claimAlbum,
  claimAlbumRelay,
  disableAiMode,
  enableAiMode,
  isAiMode,
  markAiHandoff,
  markAlbumToOperator,
  noteAlbumMessage,
  noteMissingAccountOnce,
  splitForTelegram,
  takeAiHandoff,
} from './ai';
import {
  classifyAttachment,
  composeQuestion,
  isReadable,
  loadAttachment,
  UNKNOWN_ATTACHMENT,
  type Attachment,
} from './attachments';
import { isClosingMessage } from './client-reply';
import { aiQuickAnswerEnabled, config, isAdmin } from './config';
import {
  buildFaqKeyboard,
  CLIENT_CONTACT_HINT,
  CLIENT_WELCOME,
  findNode,
  type FaqNode,
} from './faq';
import { ensureTopic, noteInTopic, relayClientToTopic, reopenTopic, syncTopicName } from './forum';
import {
  answerCallbackQuery,
  copyMessage,
  editMessageText,
  sendChatAction,
  sendHtmlOrPlain,
  sendMessage,
  setMessageReaction,
} from './telegram';
import {
  addTicketMsg,
  checkRateLimit,
  claimRateLimitNotice,
  createTicket,
  getActiveTicketForUser,
  getTicket,
  getTicketMsgs,
  isBanned,
  isDuplicateUpdate,
  isWaiting,
  mapAdminMsgToTicket,
  markOperatorReply,
  noteUndelivered,
  reopenTicket,
  setBanned,
  takeUndelivered,
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
  // Повторная доставка — не редкость, а норма: Telegram присылает обновление
  // ещё раз, если ответ на вебхук задержался, а «Быстрый ответ» держит запрос
  // до сорока секунд. Без отсечки один вопрос человека стоил бы двух обращений
  // к модели и двух тикетов у оператора.
  if (await isDuplicateUpdate(update.update_id)) {
    console.warn(`[support] повторная доставка update ${update.update_id} — пропущена`);
    return;
  }

  if (update.callback_query) {
    await handleCallback(update.callback_query);
    return;
  }

  const msg = update.message;
  if (!msg || msg.from?.is_bot) return;
  const fromId = msg.from?.id;
  if (!fromId) return;

  if (msg.chat.type === 'private') {
    if (isAdmin(fromId) && !(await adminSpeaksAsClient(msg, fromId))) await handleAdminMessage(msg);
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

/**
 * Вести ли админа по КЛИЕНТСКОЙ ветке.
 *
 * Владелец бота — он же единственный админ, и запор «сначала владельцу» без
 * этой оговорки бил бы мимо: его свободный текст всегда уходил в разбор команд
 * оператора, а «Быстрый ответ» проверить на себе было нечем. Условия строгие,
 * чтобы работа оператора не пострадала:
 *   • режим помощника у него включён (кнопкой или командой /ai);
 *   • сообщение не Reply — Reply это ответ клиенту, и его перехватывать нельзя;
 *   • сообщение не команда — /start, /find, /close остаются админскими.
 */
async function adminSpeaksAsClient(msg: TgMessage, fromId: number): Promise<boolean> {
  if (!aiQuickAnswerEnabled(fromId)) return false;
  if (msg.reply_to_message) return false;
  if ((msg.text || '').trim().startsWith('/')) return false;
  return isAiMode(fromId);
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

  // Пачка считается за ОДНО обращение: см. `albumCountsAsMessage`. Без этого
  // альбом из десяти снимков съедал весь минутный запас, и следующее сообщение
  // человека — то самое, которое мы сами же просили прислать отдельно, —
  // получало отказ.
  const countsAgainstLimit =
    !msg.media_group_id || (await albumCountsAsMessage(user.id, msg.media_group_id));
  if (countsAgainstLimit && !(await checkRateLimit(user.id, config.rateLimitPerMinute))) {
    // Говорим об этом один раз за окно, а не на каждое лишнее сообщение.
    if (await claimRateLimitNotice(user.id)) await sendMessage(user.id, RATE_LIMIT_MSG);
    return;
  }

  if (await shouldAnswerWithAi(user.id)) {
    // Человек снова пишет — значит бота он разблокировал, и сохранённый ответ
    // оператора обязан доехать НЕЗАВИСИМО от того, куда пойдёт это сообщение.
    // До 10.09.2026 досылка жила только в `forwardClientToAdmins`, то есть на
    // пути «уезжает оператору»: разблокировав бота и нажав «⚡ Быстрый ответ»,
    // человек общался с помощником, ответ оператора так и лежал в очереди, а
    // тема оставалась 🚫 — оператор считал его недоступным.
    await flushUndeliveredFor(user.id);

    // Отметку времени берём ДО того, как что-нибудь погасит режим: по ней
    // выдержка разговора отделяет сказанное здесь от сказанного в кабинете.
    const startedAt = await aiModeStartedAt(user.id);

    // Вложение разбирает отдельная ветка: с 08.09.2026 помощник читает
    // скриншоты, кадры видео и текстовые файлы сам. Проверяем ДО текста —
    // подпись к вложению приходит в `caption`, а не в `text`, и «текста нет»
    // здесь давно не значило «нечего разбирать».
    const attachment = classifyAttachment(msg);
    if (attachment || !text) {
      // Ни вложения, ни текста: местоположение, контакт, опрос. Разбирать
      // нечего, но и терять нельзя — общий путь отказа.
      await runAttachmentAnswer(
        user,
        msg,
        attachment ?? { kind: 'unsupported', what: UNKNOWN_ATTACHMENT },
        startedAt,
      );
      return;
    }
    await runQuickAnswer(user, msg, text, startedAt);
    return;
  }

  const ticket = await forwardClientToAdmins(user, msg);

  // Человек нажал «Связаться со специалистом» после разговора с помощником, и
  // тикета в тот момент ещё не было. Теперь есть — кладём в него разговор,
  // иначе оператор начнёт с «расскажите, что у вас случилось» у человека,
  // который только что всё рассказал.
  const handoff = await takeAiHandoff(user.id);
  if (handoff !== null) {
    await attachAiTranscript(ticket, user.id, {
      reason: 'человек попросил живого оператора после разговора с помощником',
      fromModel: false,
      startedAt: handoff,
    });
  }
}

/**
 * Отвечать ли этому сообщению помощником, а не тикетом.
 *
 * Решает ТОЛЬКО режим. До 08.09.2026 открытый тикет, ждущий оператора, был
 * главнее: считалось, что продолжение жалобы, уже лежащей у человека, нельзя
 * проглотить помощником. На живом выкате это оказалось хуже проблемы, которую
 * лечило: владелец нажал «Быстрый ответ», написал вопрос и не получил ничего —
 * сообщение молча уехало оператору, а окно помощника осталось пустым.
 *
 * Нажатие кнопки — это явно высказанный выбор, и спорить с ним нельзя: экран
 * называется «Быстрый ответ», и в нём отвечает помощник.
 *
 * Три вещи держат это безопасным. Ответ оператора САМ гасит режим (см.
 * `markOperatorReply`), поэтому живой диалог помощник не перехватывает.
 * Режим живёт двадцать минут и не переживает паузу. И сам помощник передаёт
 * человека оператору, когда тот просит живого человека или когда советы не
 * помогли.
 */
async function shouldAnswerWithAi(userId: number): Promise<boolean> {
  if (!aiQuickAnswerEnabled(userId)) return false;
  return await isAiMode(userId);
}

async function showClientMenu(userId: number) {
  const root = findNode('menu')!;
  await sendMessage(userId, CLIENT_WELCOME, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buildFaqKeyboard(root, { ai: aiQuickAnswerEnabled(userId) }) },
  });
}

/**
 * `opts.awaitOperator` — the message arrives through an explicit hand-off (the
 * assistant escalated or failed), so the ticket waits whatever the text says.
 */
async function forwardClientToAdmins(
  user: TgUser,
  msg: TgMessage,
  opts: { awaitOperator?: boolean } = {},
): Promise<Ticket> {
  let ticket = await getActiveTicketForUser(user.id);
  let isNew = false;
  if (!ticket) {
    ticket = await createTicket(user);
    isNew = true;
  }
  const wasWaiting = isWaiting(ticket);

  // Текст едет в тикет: без него крону тихих тикетов нечего спросить у
  // помощника — в записи до сих пор лежал только номер сообщения. Подпись к
  // вложению (`caption`) годится ровно так же, как обычный текст.
  // A short thank-you after the operator's reply is relayed like any other
  // message but does not put the ticket back into "waiting": no 🔴, no ping, no
  // digest line (audit BS-1, lib/client-reply.ts). A hand-off always waits.
  const closing = opts.awaitOperator !== true && isClosingMessage(msg);
  const touched = await touchTicket(ticket.id, msg.message_id, msg.text || msg.caption, { closing });
  await addTicketMsg(ticket.id, msg.message_id);
  const fresh = touched ?? ticket;

  // Человек снова пишет — значит бота он разблокировал. Досылаем то, что не
  // доехало, ДО пересылки его сообщения оператору: иначе он читает вопрос
  // «получилось?» раньше ответа, на который тот вопрос ссылается.
  await flushUndelivered(fresh);

  if (config.forumMode) {
    const delivered = await relayViaForum(fresh, msg, isNew, wasWaiting);
    if (delivered) {
      await noteAwayOnce(user.id, fresh.id);
      return fresh;
    }
    console.warn('[support] forum relay failed, falling back to private chats');
  }

  await relayViaPrivate(fresh, user, msg, isNew);
  await noteAwayOnce(user.id, fresh.id);
  return fresh;
}

/**
 * Досла́ть ответы оператора, которые в прошлый раз не доехали.
 *
 * ЗАЧЕМ. До 10.09.2026 недоставленный ответ («bot was blocked by the user»)
 * просто исчезал: оператор видел «⚠️ Не доставлено» и шёл дальше, человек
 * оставался с тишиной. Когда он разблокировал бота и написал снова, оператор
 * начинал заново — а ответ так и лежал ненаписанным.
 *
 * Своя неудача ничего не ломает: сообщение клиента уедет оператору в любом
 * случае, а очередь мы уже забрали — повторный ответ на тот же вопрос хуже,
 * чем один потерянный.
 */
async function flushUndelivered(ticket: Ticket): Promise<void> {
  // Дешёвая отсечка: у подавляющего большинства тикетов очередь пуста, а
  // `takeUndelivered` — это чтение и запись тикета на КАЖДОЕ сообщение
  // клиента. Тикет здесь всегда свежий (только что прочитан), поэтому
  // проверка по полям равнозначна обращению к базе.
  if (!ticket.blocked && !ticket.pendingOperator?.length) return;
  try {
    const queue = await takeUndelivered(ticket.id);
    if (queue.length === 0) return;
    await sendMessage(
      ticket.userId,
      queue.length === 1
        ? 'Наш ответ не доходил до вас — вот он:'
        : `Наши ответы не доходили до вас (${queue.length}) — вот они:`,
    );
    for (const item of queue) {
      await copyMessage(ticket.userId, item.chatId, item.messageId);
    }
    const fresh = (await getTicket(ticket.id)) ?? ticket;
    await syncTopicName(fresh);
    await noteInTopic(fresh, '📬 Клиент вернулся — недоставленные ответы досланы.');
  } catch (err) {
    console.error('[support] дослать недоставленное не удалось:', err);
  }
}

/**
 * То же самое, когда тикета на руках нет — путь быстрого ответа.
 *
 * Одно чтение активного тикета, и только оно: сам `flushUndelivered` дальше
 * отсекается по полям и в обычном случае в базу больше не ходит.
 */
async function flushUndeliveredFor(userId: number): Promise<void> {
  try {
    const t = await getActiveTicketForUser(userId);
    if (t) await flushUndelivered(t);
  } catch (err) {
    console.error('[support] дослать недоставленное не удалось:', err);
  }
}

/**
 * Сказать человеку, что живого ответа сегодня не будет.
 *
 * Стоит ЗДЕСЬ, а не у каждой кнопки, потому что сюда сходятся все пути к
 * оператору: и «Связаться со специалистом», и передача от помощника, и наша
 * поломка, и вложение, которого помощник не читает. Приписка у каждой кнопки
 * означала бы четыре копии одного текста и один забытый путь.
 *
 * Своя ошибка ничего не ломает: тикет уже доставлен, приписка — вежливость.
 */
async function noteAwayOnce(userId: number, ticketId: number): Promise<void> {
  try {
    const away = await readAway();
    if (!away) return;
    if (!(await claimAwayNote(ticketId))) return;
    await sendMessage(userId, awayNotice(away).trimStart(), { parse_mode: 'HTML' });
  } catch (err) {
    console.error('[support][away] приписка не ушла:', err);
  }
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
  } else if (!wasWaiting && isWaiting(t)) {
    // Был отвечен — снова ждёт: имя темы должно это показать.
    // A closing remark leaves it answered: the 🟢 name stays, no rename call.
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
// Быстрый ответ (ProxysAI)
// ════════════════════════════════════════════════════════════════════
//
// Помощник тот же, что в кабинете на сайте: правила, состояние аккаунта и
// переписка общие, бот только приносит вопрос и уносит ответ (см. lib/ai.ts).
// Здесь — только поведение в чате: когда включать режим, что показывать и
// когда отдавать разговор живому человеку.

// Про аккаунт сказано УСЛОВНО, и это не осторожность ради осторожности.
// Аккаунт ищется по alias:tg_<id>, а человек, заведённый по почте и не
// привязавший телеграм, здесь обычное дело — ему безусловное «я вижу ваш
// баланс» ломается первым же ответом «аккаунта по этому Telegram у нас нет».
// Проверить до приглашения нечем: договор с ручкой не знает вопроса «есть ли
// аккаунт», а звать модель ради этого — платить за пустой запрос.
const AI_GREETING = [
  '<b>⚡ Быстрый ответ</b>',
  '',
  'Спрашивайте своими словами — отвечу за несколько секунд.',
  '',
  'Если ваш кабинет привязан к этому Telegram, я вижу баланс, устройства, тариф и последние платежи и не буду переспрашивать очевидное. Помогаю с подключением, «не работает», оплатой и настройками приложений.',
  '',
  'Нужен живой человек — просто скажите об этом, передам оператору вместе с нашим разговором.',
].join('\n');

const AI_MORE_HINT = 'Слушаю. Напишите вопрос следующим сообщением.';

/**
 * Приписка после ответа, когда кабинета под этим телеграмом не нашлось.
 *
 * Показывается один раз за разговор: человеку важно узнать, что помощник
 * отвечает не про его аккаунт, но повторять это под каждым ответом — значит
 * превратить полезное предупреждение в шум.
 */
const AI_NO_ACCOUNT_NOTE = [
  'ℹ️ Кабинета, привязанного к этому Telegram, я не вижу — про ваш баланс, устройства и платежи ответить не могу.',
  '',
  'Если вопрос именно про аккаунт, напишите оператору кнопкой ниже: он найдёт вас по почте.',
].join('\n');

/**
 * Отказ по вложению, которое помощник ДЕЙСТВИТЕЛЬНО не читает.
 *
 * До 08.09.2026 такой строкой отвечали на любое вложение вообще: «быстрый
 * ответ читает только текст». Про скриншоты это было неправдой уже тогда —
 * модель видит картинки и видит их в кабинете, — и стоило это дорого: человек,
 * приславший фотографию экрана вместо описания (а в поддержке так делает
 * почти каждый), получал отказ и уезжал к живому оператору с вопросом, на
 * который помощник ответил бы сам.
 *
 * Теперь строка узкая и называет причину: голосовое, аудио, стикер, формат
 * картинки, который поставщик модели не откроет. Причина обязательна — «я не
 * могу» без «чего именно» человек читает как «бот сломался».
 */
const aiCantRead = (what: string, hint?: string) =>
  [`${what}. Передаю ваше сообщение оператору: он посмотрит и ответит здесь же.`, hint ?? '']
    .filter((s) => s !== '')
    .join('\n\n');

/**
 * Скачать или прочитать не вышло.
 *
 * Отдельно от `aiCantRead`: там мы чего-то не умеем, здесь — не смогли. Для
 * человека разница в том, стоит ли пробовать ещё раз, поэтому и слова разные.
 * Общее одно: сообщение не теряется ни в том, ни в другом случае.
 */
const aiAttachmentFailed = (reason: string, hint?: string) =>
  [
    `${reason}. Чтобы вы не остались без ответа, передаю сообщение оператору — он посмотрит и ответит здесь же.`,
    hint ?? '',
  ]
    .filter((s) => s !== '')
    .join('\n\n');

/**
 * Про пачку говорим в том же ответе, которым отвечаем на снимок из неё.
 *
 * Разбирается ровно одно сообщение альбома (почему — см. `claimAlbum` в
 * lib/ai.ts), и промолчать об этом нельзя: человек прислал четыре экрана и
 * вправе знать, что смотрели один. «Один снимок», а не «первый», — намеренно:
 * обновления альбома приходят параллельно, и какое из них выиграет гонку, мы
 * не знаем.
 */
const AI_ALBUM_NOTE =
  'Из присланной пачки я разобрал один снимок, остальные не смотрел. Если важен другой — пришлите его отдельным сообщением.';

/**
 * Та же оговорка, но когда пачка уехала оператору.
 *
 * Здесь она про другое: снимки не «не смотрели», а переданы все до одного. Не
 * сказать этого — значит оставить человека гадать, дошли ли остальные, а
 * прежняя формулировка про «разобрал один» тут прямо неверна.
 */
const AI_ALBUM_TO_OPERATOR = 'Все снимки из пачки переданы оператору целиком.';

/**
 * Суточный запас на разбор вложений у этого человека кончился.
 *
 * Про текст говорим отдельно и первым делом: помощник продолжает отвечать, и
 * человек, приславший десятый скриншот, чаще всего может просто описать беду
 * словами. Отказ без такого выхода читается как «бот сломался».
 */
const AI_ATTACH_LIMIT = [
  'На сегодня разбор присланных файлов и скриншотов исчерпан.',
  '',
  'Опишите, пожалуйста, что происходит, словами — на текст я отвечаю как обычно. Если нужен живой человек, нажмите кнопку ниже.',
].join('\n');

/** То же, но упёрлись мы, а не он: причину называем честно. */
const AI_ATTACH_BUSY = [
  'Разбор файлов и скриншотов сейчас перегружен — это на нашей стороне.',
  '',
  'Опишите, пожалуйста, беду словами: на текст я отвечаю как обычно. Или нажмите кнопку ниже, ответит живой человек.',
].join('\n');

const AI_FAILED_HINT =
  'Быстрый ответ сейчас недоступен — это на нашей стороне. Ваше сообщение не потерялось: передаю его оператору, он ответит здесь же.';

const AI_ESCALATED_HINT =
  'Здесь нужен живой человек — передаю разговор оператору вместе с тем, что мы уже разобрали. Он ответит здесь же.';

const CONTACT_BUTTON = { text: '🆘 Связаться со специалистом', callback_data: 'contact' } as const;
const MENU_BUTTON = { text: '🏠 В меню', callback_data: 'faq:menu' } as const;

/**
 * Клавиатура под ответом помощника.
 *
 * Кнопки оператора здесь намеренно НЕТ: это окно разговора с помощником, и
 * ссылка на живого человека под каждым его ответом читается как «я не
 * справился». Выход к оператору никуда не делся: об этом достаточно попросить
 * словами, помощник передаёт сам, а «В меню» возвращает туда, где кнопка
 * оператора стоит постоянно. Под ОТКАЗОМ помощника кнопка остаётся — там она
 * единственный путь дальше, см. `aiFallbackKeyboard`.
 */
function aiReplyKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '⚡ Спросить ещё', callback_data: 'ai:more' }],
      [MENU_BUTTON],
    ],
  };
}

/** Приглашение в режим помощника. */
async function sendAiGreeting(userId: number): Promise<void> {
  await sendMessage(userId, AI_GREETING, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
  });
}

/** Клавиатура под отказом: помощник не смог — остаётся человек. */
function aiFallbackKeyboard() {
  return { inline_keyboard: [[CONTACT_BUTTON], [MENU_BUTTON]] };
}

/** Как часто повторять «печатает…», пока ждём модель. */
const TYPING_REFRESH_MS = 4000;

/**
 * Держать «печатает…» всё время ожидания.
 *
 * Telegram гасит признак через пять секунд, а модель с размышлением думает
 * десятки: одного вызова хватает ровно на то, чтобы человек решил, что бот
 * завис, и начал писать «ау?». Повтор стоит одного дешёвого запроса в четыре
 * секунды и снимается в `finally` — иначе он пережил бы сам ответ.
 */
function keepTyping(chatId: number): { stop: () => void } {
  void sendChatAction(chatId);
  const timer: ReturnType<typeof setInterval> = setInterval(() => {
    void sendChatAction(chatId);
  }, TYPING_REFRESH_MS);
  return { stop: () => clearInterval(timer) };
}

/**
 * Разобрать вложение помощником.
 *
 * Исходы, и ни один из них не молчит:
 *   • это реплика, а не вопрос (стикер, кость) — отвечаем сами, БЕЗ тикета и
 *     без гашения режима;
 *   • помощник этого не умеет (голосовое, чужой формат картинки) — говорим что
 *     именно, называем выход и отдаём оператору;
 *   • суточный запас на вложения выбран — говорим об этом, зовём описать беду
 *     словами и оператора НЕ трогаем;
 *   • не скачалось или не прочиталось — говорим об этом и отдаём оператору;
 *   • разобрали — обычный ответ помощника, и РЕЖИМ ОСТАЁТСЯ ВКЛЮЧЁННЫМ.
 *
 * Последнее — суть правки. Раньше вложение гасило режим, то есть следующее
 * сообщение человека уезжало оператору, даже если это была обычная текстовая
 * реплика по тому же вопросу.
 *
 * Про пачку: замок берётся ПЕРВЫМ делом, до всех проверок, и любой путь к
 * оператору уносит туда ВСЕ её сообщения — см. `claimAlbum` в lib/ai.ts.
 */
async function runAttachmentAnswer(
  user: TgUser,
  msg: TgMessage,
  attach: Attachment,
  startedAt: number | null,
): Promise<void> {
  const album = msg.media_group_id ?? null;

  if (album) {
    // Записываем себя ПЕРВЫМ делом, до всякой проверки: победитель гонки
    // прочитает этот список, если разбор кончится передачей оператору. Порядок
    // «сначала запись, потом замок» и закрывает гонку — см. рассказ у
    // `claimAlbum` в lib/ai.ts.
    await noteAlbumMessage(user.id, album, msg.message_id);

    if (!(await claimAlbum(user.id, album))) {
      // Разбирает другое сообщение этой пачки. Молча выйти можно ТОЛЬКО пока
      // разбор идёт: если он уже кончился оператором, это сообщение обязано
      // доехать туда же, иначе оператор получит один файл из пяти.
      if (await albumWentToOperator(user.id, album)) {
        await relayAlbumLeftover(user, msg, album);
      }
      return;
    }
  }

  if (attach.kind === 'smalltalk') {
    // Стикер и кость — реплика, а не вопрос. Ни тикета, ни гашения режима:
    // человек сказал «спасибо», и отвечать на это живым оператором значит
    // выключить помощника ровно перед следующим настоящим вопросом.
    await sendMessage(user.id, attach.reply, { reply_markup: aiReplyKeyboard() });
    await enableAiMode(user.id);
    return;
  }

  // Замок пачки взят ВЫШЕ этой проверки: на пачку должен приходиться один
  // исход, какой бы он ни был. Раньше проверка стояла выше замка, и три PDF
  // одной пачкой давали три отказа «передаю оператору», три гашения режима и
  // три выдержки разговора в одной теме тикета.
  if (!isReadable(attach)) {
    await handOffToOperator(user, msg, startedAt, {
      toHuman: aiCantRead(attach.what, attach.hint),
      reason: `помощник не читает такое вложение (${attach.what.toLowerCase()})`,
    });
    return;
  }

  // Разрешение спрашиваем ДО скачивания. Лимиты ручки сайта считают обращения
  // к модели и про мегабайты, которые мы тянем из Telegram и заливаем в свой же
  // вебхук, ничего не знают: сообщение, отбитое там суточной квотой, всё равно
  // стоило нам полного скачивания.
  const budget = await claimAttachmentBudget(user.id);
  if (budget !== null) {
    // Режим НЕ гасим и оператору не пересылаем — по той же причине, что и при
    // лимите ручки: пересланный поток просто переезжает на живого человека.
    // Кнопка рядом, решает он сам.
    await sendMessage(user.id, budget === 'user' ? AI_ATTACH_LIMIT : AI_ATTACH_BUSY, {
      reply_markup: aiFallbackKeyboard(),
    });
    return;
  }

  // «Печатает…» держим и на скачивании: файл едет секунды, и без признака
  // чат выглядит так, будто сообщение не дошло.
  const typing = keepTyping(user.id);
  let loaded: Awaited<ReturnType<typeof loadAttachment>>;
  try {
    loaded = await loadAttachment(attach);
  } finally {
    typing.stop();
  }

  if (!loaded.ok) {
    await handOffToOperator(user, msg, startedAt, {
      toHuman: aiAttachmentFailed(loaded.reason, loaded.hint),
      reason: `быстрый ответ не смог разобрать вложение (${loaded.reason.toLowerCase()})`,
    });
    return;
  }

  // Подпись к вложению и есть вопрос; подписи нет — вопрос подставляет
  // `composeQuestion`, там же собираются оговорка про кадр, про обрезанный файл
  // и человеческий вид реплики для ленты кабинета.
  const composed = composeQuestion(attach, msg.caption || '', loaded);
  const notes = [composed.note, album ? AI_ALBUM_NOTE : null].filter(
    (n): n is string => n !== null,
  );

  await runQuickAnswer(user, msg, composed.question, startedAt, {
    image: loaded.image,
    display: composed.display ?? undefined,
    note: notes.length > 0 ? notes.join('\n\n') : undefined,
    album,
  });
}

/**
 * Досдать оператору сообщение пачки, опоздавшее к передаче.
 *
 * Оно пришло уже после того, как разбор кончился оператором, поэтому идёт
 * обычным путём пересылки — без обращения к модели и без своего отказа
 * человеку: слова про передачу он уже прочитал, повторять их на каждый снимок
 * незачем.
 */
async function relayAlbumLeftover(user: TgUser, msg: TgMessage, album: string): Promise<void> {
  if (!(await claimAlbumRelay(user.id, album, msg.message_id))) return;
  await forwardClientToAdmins(user, msg);
}

/**
 * Отдать оператору ОСТАЛЬНЫЕ сообщения пачки.
 *
 * Зовётся на каждом пути к оператору, сразу после того, как поставлена метка
 * «пачка ушла оператору». Сообщений в списке может ещё не быть — их обновления
 * просто не дошли; такие доложат себя сами, увидев метку.
 *
 * Настоящего сообщения у нас нет, есть только его номер, поэтому собираем
 * заглушку: и в теме группы, и в личке оператора вложение доставляется
 * `copyMessage` по номеру, а текста у сообщения с картинкой всё равно нет.
 */
async function relayAlbumRest(user: TgUser, album: string, exceptId: number): Promise<void> {
  const ids = await albumMessages(user.id, album);
  for (const id of ids) {
    if (id === exceptId) continue;
    if (!(await claimAlbumRelay(user.id, album, id))) continue;
    await forwardClientToAdmins(user, {
      message_id: id,
      from: user,
      chat: { id: user.id, type: 'private' },
      date: Math.floor(Date.now() / 1000),
    });
  }
}

/**
 * Отдать разговор оператору, ничего не потеряв.
 *
 * Единственный путь к оператору из ветки помощника — и у неудачи скачивания, и
 * у сбоя ручки, и у ESCALATE от модели. Порядок здесь не оформление, а суть:
 *
 *  1. пометить пачку как ушедшую оператору — ДО пересылки, чтобы сообщение
 *     альбома, пришедшее в эту же секунду, увидело метку и пошло туда же;
 *  2. погасить режим — ДО пересылки, иначе следующее сообщение человека уедет
 *     помощнику мимо только что заведённого тикета;
 *  3. сказать человеку словами;
 *  4. переслать это сообщение и ОСТАЛЬНЫЕ сообщения пачки;
 *  5. положить в тикет разговор, чтобы оператор не начинал с «расскажите, что
 *     у вас случилось» у человека, который только что всё рассказал.
 *
 * Шаг 4 появился 08.09.2026. До него оператору уезжало ровно одно сообщение
 * пачки: остальные к этому моменту были погашены голым `return`, а человеку
 * трижды пообещали передачу. Оператор открывал тикет с одним снимком из трёх и
 * не знал, что было ещё два.
 */
async function handOffToOperator(
  user: TgUser,
  msg: TgMessage,
  startedAt: number | null,
  opts: { toHuman: string; reason: string; fromModel?: boolean; album?: string | null },
): Promise<void> {
  const album = opts.album ?? msg.media_group_id ?? null;
  if (album) await markAlbumToOperator(user.id, album);
  await disableAiMode(user.id);
  await sendMessage(user.id, album ? `${opts.toHuman}\n\n${AI_ALBUM_TO_OPERATOR}` : opts.toHuman);

  const ticket = await forwardClientToAdmins(user, msg, { awaitOperator: true });
  if (album) await relayAlbumRest(user, album, msg.message_id);

  await attachAiTranscript(ticket, user.id, {
    reason: opts.reason,
    fromModel: opts.fromModel === true,
    startedAt,
  });
}


/**
 * Ответить помощником.
 *
 * Любая беда на стороне помощника заканчивается либо внятным отказом, либо
 * оператором — но никогда молчанием: человек, чьё сообщение пропало без следа,
 * второй раз не напишет.
 *
 * `opts.image` — картинка к вопросу (скриншот или кадр из видео).
 * `opts.display` — как ту же реплику показать человеку в ленте кабинета и
 * оператору в выдержке: служебная обвязка вопроса писалась для модели, а не для
 * чтения человеком (см. `Composed.display` в lib/attachments.ts).
 * `opts.note` — наша оговорка, которую человек должен прочитать ВМЕСТЕ с
 * ответом: что смотрели кадр, а не запись; что из пачки разобран один снимок.
 * Она идёт перед ответом, а не после, потому что меняет то, как этот ответ
 * читать.
 * `opts.album` — пачка, из которой пришло сообщение: на пути к оператору
 * остальные её сообщения обязаны уехать туда же.
 */
async function runQuickAnswer(
  user: TgUser,
  msg: TgMessage,
  text: string,
  startedAt: number | null,
  opts: { image?: string; display?: string; note?: string; album?: string | null } = {},
): Promise<void> {
  const typing = keepTyping(user.id);
  let res: Awaited<ReturnType<typeof askProxysAi>>;
  try {
    res = await askProxysAi(user.id, text, { image: opts.image, display: opts.display });
  } finally {
    typing.stop();
  }

  if (!res.ok) {
    if (res.kind === 'limited') {
      // Лимит — не поломка, а следствие потока сообщений от самого человека.
      // Пересылать такое оператору автоматически нельзя: поток просто переедет
      // на живого человека. Режим при этом НЕ гасим — погасив, мы отправили бы
      // оператору следующее же сообщение, то есть сделали ровно то, чего этой
      // веткой избегаем. Кнопка рядом, решает он сам.
      await sendMessage(
        user.id,
        `${res.message}\n\nВаш вопрос не сохранён: если он срочный, напишите его оператору кнопкой ниже.`,
        { reply_markup: aiFallbackKeyboard() },
      );
      return;
    }

    // Наша поломка. Сообщение человека уже написано, и терять его из-за нашей
    // неудачи нельзя — отдаём оператору обычным путём, вместе с разговором и
    // вместе с остальными сообщениями пачки.
    await handOffToOperator(user, msg, startedAt, {
      toHuman: AI_FAILED_HINT,
      reason: 'быстрый ответ не сработал на нашей стороне',
      album: opts.album,
    });
    return;
  }

  const { answer } = res;

  if (answer.escalate) {
    await handOffToOperator(user, msg, startedAt, {
      toHuman: AI_ESCALATED_HINT,
      reason: answer.escalate,
      fromModel: true,
      album: opts.album,
    });
    return;
  }

  // Оговорка склеивается с ответом ДО нарезки, а не шлётся отдельным
  // сообщением: обычный ответ так и остаётся одним сообщением, а если вместе
  // они не влезут — нарежет `splitForTelegram` по границам абзацев.
  const chunks = splitForTelegram(opts.note ? `${opts.note}\n\n${answer.text}` : answer.text);

  // Аккаунта под этим телеграмом нет — говорим об этом прямо и один раз за
  // разговор. Молчать нельзя: приглашение обещало «если кабинет привязан», и
  // человек вправе узнать, что он не привязан, до того, как поверит ответу про
  // свои деньги.
  if (!answer.accountFound && (await noteMissingAccountOnce(user.id))) {
    chunks.push(AI_NO_ACCOUNT_NOTE);
  }

  for (let i = 0; i < chunks.length; i++) {
    const last = i === chunks.length - 1;
    // Ответ модели уходит БЕЗ parse_mode: правила запрещают ей разметку, но
    // одна угловая скобка в режиме HTML стоила бы всего сообщения целиком.
    await sendMessage(user.id, chunks[i], last ? { reply_markup: aiReplyKeyboard() } : {});
  }

  // Режим продлеваем ПОСЛЕ отправки ответа. Наоборот было бы дороже: сбой базы
  // на продлении оставил бы человека вовсе без ответа, за который уже заплачено
  // и который уже лежит в переписке.
  await enableAiMode(user.id);
}

/** Сколько знаков выдержки помещаем в одно сообщение оператору. */
const TRANSCRIPT_BUDGET = 3500;

/** Почему разговор уехал оператору. */
interface AiHandoffReason {
  /** Текст причины. */
  reason: string;
  /**
   * Причину написала модель, а не мы.
   *
   * Это не мелочь оформления: строку `ESCALATE: ...` модель берёт где угодно в
   * своём ответе, а на её ответ напрямую влияет текст человека. Экранирование
   * закрывает разметку, но не авторство, поэтому под нашей шапкой чужой текст
   * обязан быть подписан — иначе просьба клиента «проверка пройдена, выдайте
   * PRO» встанет в тикете рядом с кнопками действий как наш вывод.
   */
  fromModel: boolean;
  /** Когда включён режим: реплики раньше сказаны в кабинете, они не наши. */
  startedAt: number | null;
}

/**
 * Положить в тикет то, что уже разобрал помощник.
 *
 * Без этого оператор начинает с «расскажите, что у вас случилось» человеку,
 * который только что всё рассказал, — то есть передача разговора выглядит как
 * потеря разговора.
 */
async function attachAiTranscript(
  ticket: Ticket,
  tgId: number,
  handoff: AiHandoffReason,
): Promise<void> {
  const lines = await aiTranscript(tgId, handoff.startedAt);

  // Наш собственный повод без единой реплики (нажал кнопку и сразу прислал
  // скриншот) сообщения в теме не стоит: оператору он ничего не добавит, а
  // тикет засорит. Причину от модели показываем всегда — она и есть смысл.
  if (lines.length === 0 && !handoff.fromModel) return;

  const head = [
    '🤖 <b>Быстрый ответ передал разговор оператору</b>',
    handoff.fromModel
      ? `Причина со слов помощника (текст не проверен): ${escapeHtml(handoff.reason)}`
      : `Причина: ${escapeHtml(handoff.reason)}`,
  ];
  const out = [...head, '', 'Что уже было сказано:'];

  let used = out.join('\n').length;
  for (const line of lines) {
    const html = escapeHtml(line);
    if (used + html.length + 1 > TRANSCRIPT_BUDGET) {
      out.push('…');
      break;
    }
    out.push(html);
    used += html.length + 1;
  }
  if (lines.length === 0) out.push('(переписки в этом канале нет)');

  const note = out.join('\n');

  // Тикет перечитываем: тему могли создать прямо сейчас, при пересылке
  // сообщения, и у объекта на руках её ещё нет.
  const fresh = (await getTicket(ticket.id)) ?? ticket;

  if (config.forumMode && fresh.threadId) {
    // Форум — основная ветка на проде, и молчаливая потеря выдержки здесь
    // стоила бы ровно того, ради чего выдержка делается. `noteInTopic` шлёт с
    // откатом на обычный текст.
    await noteInTopic(fresh, note);
    return;
  }
  for (const adminId of config.adminUserIds) {
    const sent = await sendHtmlOrPlain(adminId, note);
    if (sent.ok && sent.result) await mapAdminMsgToTicket(sent.result.message_id, fresh.id);
  }
}

// ════════════════════════════════════════════════════════════════════
// Operator reply → client (общее для лички и темы)
// ════════════════════════════════════════════════════════════════════

/**
 * Человек заблокировал бота (или удалил чат).
 *
 * Отличать это от прочих отказов Telegram обязательно: «bot was blocked» —
 * состояние, которое пройдёт само, когда человек вернётся, и ответ надо
 * сохранить. Всё остальное (слишком длинное сообщение, битая разметка) —
 * наша поломка здесь и сейчас, и складывать её в очередь незачем.
 */
function isBlockedByUser(description?: string): boolean {
  const d = (description || '').toLowerCase();
  return (
    d.includes('bot was blocked') ||
    d.includes('user is deactivated') ||
    d.includes('chat not found') ||
    d.includes('bot can\'t initiate conversation')
  );
}

/**
 * Отнести сообщение оператора клиенту. Успех помечаем реакцией 👌 на самом
 * сообщении; если реакции в чате запрещены — короткой строкой.
 *
 * Отказ доставки больше не означает потерю ответа: см. `noteUndelivered` и
 * `flushUndelivered`.
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
    const blocked = isBlockedByUser(res.description);
    if (blocked) {
      // Ответ не выбрасываем: он уйдёт первым же сообщением человека, когда
      // тот разблокирует бота. Имя темы при этом становится 🚫 — иначе
      // оператор пишет в неё второй и третий раз, не понимая, почему тишина.
      const marked = await noteUndelivered(t.id, msg.chat.id, msg.message_id);
      if (marked) await syncTopicName(marked);
    }
    await sendMessage(
      msg.chat.id,
      blocked
        ? '🚫 Клиент заблокировал бота. Ответ сохранён и уйдёт ему автоматически, как только он напишет снова.'
        : `⚠️ Не доставлено: ${escapeHtml(res.description || 'ошибка')}`,
      {
        parse_mode: 'HTML',
        message_thread_id: msg.message_thread_id,
      },
    );
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
  // «Быстрый ответ» на себе.
  //
  // Владелец бота — он же единственный админ, и /start показывает ему админ-
  // панель без клиентских кнопок. Без этой команды выкат «сначала владельцу»
  // проверить было бы нечем: кнопка ⚡ живёт в клиентском меню, куда он не
  // попадает. Дальше его свободный текст уводит в помощника
  // `adminSpeaksAsClient`, а /start и Reply остаются работой оператора.
  if (text === '/ai') {
    const id = msg.from!.id;
    if (!aiQuickAnswerEnabled(id)) {
      await sendMessage(
        id,
        'Быстрый ответ недоступен: нет INTERNAL_API_KEY в окружении бота либо вас нет в SUPPORT_AI_USER_IDS.',
      );
      return;
    }
    await enableAiMode(id);
    await sendAiGreeting(id);
    return;
  }
  // Объявление об отъезде: включить, снять, посмотреть.
  //
  // Команда, а не переменная окружения: снимать объявление придётся из
  // поездки, а правка переменной в Vercel требует нового выката.
  if (/^\/away\b/.test(text) || text === '/away') {
    const arg = text.replace(/^\/away\s*/, '').trim();
    if (!arg) {
      const away = await readAway();
      await sendMessage(
        msg.chat.id,
        away
          ? `Объявление включено до ${new Date(away.until).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК.\n\nСнять: <code>/away off</code>`
          : 'Объявления нет.\n\nВключить: <code>/away 11.09 16:30</code>',
        { parse_mode: 'HTML' },
      );
      return;
    }
    if (/^(off|нет|стоп)$/i.test(arg)) {
      await clearAway();
      await sendMessage(msg.chat.id, 'Объявление снято. Клиентам про отъезд больше не пишем.');
      return;
    }
    const until = parseAwayUntil(arg);
    if (until === null) {
      await sendMessage(msg.chat.id, 'Не разобрал дату. Так: <code>/away 11.09 16:30</code> или <code>/away off</code>.', {
        parse_mode: 'HTML',
      });
      return;
    }
    await setAway(until);
    const away = await readAway();
    await sendMessage(
      msg.chat.id,
      away
        ? `Включено. Вот что увидит клиент:\n${awayNotice(away)}`
        : 'Не удалось включить: база не ответила.',
      { parse_mode: 'HTML' },
    );
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

  const aiHint = aiQuickAnswerEnabled(msg.from!.id)
    ? '\n/ai — проверить «Быстрый ответ» на себе.'
    : '';
  await sendMessage(
    msg.chat.id,
    (config.forumMode
      ? 'Тикеты ведутся в темах группы. Здесь: /start — панель, /find — найти аккаунт.'
      : 'Чтобы ответить клиенту — сделайте Reply на его сообщение.\n/start — панель, /find — найти аккаунт, /close 12 — закрыть тикет.') +
      aiHint,
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
      if (sent.ok && sent.result) await renderTemplates(chatId, sent.result.message_id, ticketId, threadId);
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

  // Клиентские кнопки разбираем ДО развилки «админ или клиент»: они живут
  // только в личке клиентского меню, среди админских такого callback_data нет,
  // а владелец бота — сам себе админ, и без этой оговорки нажатие ⚡ у него
  // уходило бы в разбор админских кнопок и молча не делало ничего.
  const clientButton =
    msg.chat.type === 'private' &&
    (data === 'contact' || data === 'ai' || data === 'ai:more' || data.startsWith('faq:'));

  if (isAdmin(user.id) && !clientButton) {
    await handleAdminCallback(cb, data);
    return;
  }

  if (await isBanned(user.id)) {
    await answerCallbackQuery(cb.id, BANNED_MSG, true);
    return;
  }

  if (data === 'contact') {
    await answerCallbackQuery(cb.id);
    // Человек попросил живого — режим выключаем сразу, иначе следующее его
    // сообщение перехватит помощник, которого он только что отверг. Но сначала
    // запоминаем, с какого момента шёл разговор: тикета ещё нет, он появится с
    // ближайшим сообщением, и выдержка разговора должна приехать в него.
    await markAiHandoff(user.id, await aiModeStartedAt(user.id));
    await disableAiMode(user.id);
    // Тикета ещё нет, поэтому отметка «уже показывали» тут не работает: она
    // привязана к тикету. Повтор безобиден — человек сам нажал кнопку и ждёт
    // ответа именно про оператора.
    const away = await readAway();
    await sendMessage(user.id, CLIENT_CONTACT_HINT + (away ? awayNotice(away) : ''), {
      parse_mode: 'HTML',
    });
    return;
  }

  if (data === 'ai' || data === 'ai:more') {
    // Признак проверяем и здесь, а не только при рисовании клавиатуры: кнопка
    // живёт в старом сообщении и переживёт сужение перечня допущенных.
    if (!aiQuickAnswerEnabled(user.id)) {
      await answerCallbackQuery(cb.id, 'Быстрый ответ сейчас недоступен.', true);
      return;
    }
    await answerCallbackQuery(cb.id);
    await enableAiMode(user.id);

    if (data === 'ai:more') {
      await sendMessage(user.id, AI_MORE_HINT);
      return;
    }

    await sendAiGreeting(user.id);
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

  // Клиентское меню всегда живёт в личке, так что chatId здесь — это и есть
  // идентификатор человека, которому решается показать «Быстрый ответ».
  const keyboard = { inline_keyboard: buildFaqKeyboard(node, { ai: aiQuickAnswerEnabled(chatId) }) };

  const res = await editMessageText(chatId, messageId, text, {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });
  if (!res.ok) {
    await sendMessage(chatId, text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
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
      await renderTemplates(chatId, messageId, id, threadId);
      return;
    case 'tpl':
      // Шаблон выбран: показать текст, клиенту пока ничего не уходит.
      await answerCallbackQuery(cb.id);
      await renderTemplatePreview(chatId, messageId, id, b || '', threadId);
      return;
    case 'tps': {
      // Подтверждение из предпросмотра: отправить и вернуться к карточке.
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
