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

export function sendMessage(
  chatId: number,
  text: string,
  opts: {
    reply_markup?: { inline_keyboard: InlineKeyboard };
    parse_mode?: 'HTML';
    disable_web_page_preview?: boolean;
  } = {},
) {
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
  opts: { caption?: string; parse_mode?: 'HTML' } = {},
) {
  return call<{ message_id: number }>('copyMessage', {
    chat_id: toChatId,
    from_chat_id: fromChatId,
    message_id: messageId,
    ...opts,
  });
}
