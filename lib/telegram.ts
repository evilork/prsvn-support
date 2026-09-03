// lib/telegram.ts
import { config } from './config';
import type { InlineKeyboard, TgResponse } from './types';

const API = `https://api.telegram.org/bot${config.botToken}`;

async function call<T>(
  method: string,
  params: Record<string, unknown>,
): Promise<TgResponse<T>> {
  try {
    const res = await fetch(`${API}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(8000),
    });
    return (await res.json()) as TgResponse<T>;
  } catch (err) {
    console.error(`[support] tg call ${method} failed:`, err);
    return { ok: false, description: String(err) };
  }
}

export interface SendOpts {
  reply_markup?: { inline_keyboard: InlineKeyboard };
  parse_mode?: 'HTML';
  disable_web_page_preview?: boolean;
  /** Тема в группе с темами. Без неё сообщение уходит в «General». */
  message_thread_id?: number;
  disable_notification?: boolean;
}

export function sendMessage(chatId: number, text: string, opts: SendOpts = {}) {
  return call<{ message_id: number }>('sendMessage', {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...opts,
  });
}

export function editMessageText(
  chatId: number,
  messageId: number,
  text: string,
  opts: {
    reply_markup?: { inline_keyboard: InlineKeyboard };
    parse_mode?: 'HTML';
  } = {},
) {
  return call<unknown>('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    disable_web_page_preview: true,
    ...opts,
  });
}

export function answerCallbackQuery(
  callbackQueryId: string,
  text?: string,
  showAlert = false,
) {
  return call<unknown>('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text,
    show_alert: showAlert,
  });
}

export function copyMessage(
  toChatId: number,
  fromChatId: number,
  messageId: number,
  opts: { caption?: string; parse_mode?: 'HTML'; message_thread_id?: number } = {},
) {
  return call<{ message_id: number }>('copyMessage', {
    chat_id: toChatId,
    from_chat_id: fromChatId,
    message_id: messageId,
    ...opts,
  });
}

export function deleteMessage(chatId: number, messageId: number) {
  return call<unknown>('deleteMessage', {
    chat_id: chatId,
    message_id: messageId,
  });
}

/**
 * Реакция вместо служебного сообщения.
 *
 * «✓ Ответ отправлен» после каждого ответа удваивал число строк в чате
 * оператора. Значок 👌 на самом ответе говорит то же самое и не занимает
 * места. Набор разрешённых реакций у Telegram фиксированный, 👌 в нём есть.
 */
export function setMessageReaction(chatId: number, messageId: number, emoji = '👌') {
  return call<unknown>('setMessageReaction', {
    chat_id: chatId,
    message_id: messageId,
    reaction: [{ type: 'emoji', emoji }],
  });
}

export function pinChatMessage(chatId: number, messageId: number) {
  return call<unknown>('pinChatMessage', {
    chat_id: chatId,
    message_id: messageId,
    disable_notification: true,
  });
}

// ─── Темы в группе ───────────────────────────────────────

export function createForumTopic(chatId: number, name: string, iconColor?: number) {
  return call<{ message_thread_id: number }>('createForumTopic', {
    chat_id: chatId,
    name: name.slice(0, 128),
    ...(iconColor ? { icon_color: iconColor } : {}),
  });
}

export function editForumTopic(chatId: number, threadId: number, name: string) {
  return call<unknown>('editForumTopic', {
    chat_id: chatId,
    message_thread_id: threadId,
    name: name.slice(0, 128),
  });
}

export function closeForumTopic(chatId: number, threadId: number) {
  return call<unknown>('closeForumTopic', { chat_id: chatId, message_thread_id: threadId });
}

export function reopenForumTopic(chatId: number, threadId: number) {
  return call<unknown>('reopenForumTopic', { chat_id: chatId, message_thread_id: threadId });
}

/** Download a Telegram photo/image-document as a base64 data URL (for vision models). */
export async function getFileAsDataUrl(fileId: string): Promise<string | null> {
  const f = await call<{ file_path?: string }>('getFile', { file_id: fileId });
  if (!f.ok || !f.result?.file_path) return null;
  try {
    const res = await fetch(
      `https://api.telegram.org/file/bot${config.botToken}/${f.result.file_path}`,
      { signal: AbortSignal.timeout(20000) },
    );
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 6_000_000) return null;
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}
