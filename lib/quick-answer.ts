// lib/quick-answer.ts
//
// The "⚡ Быстрый ответ" button in the FAQ menu: in-chat assistant or Mini App.
//
// Everyone gets the in-chat assistant, exactly as before: callback `ai`,
// handled in lib/handler.ts. People on the allowlist below get the same
// ProxysAI as a Telegram Mini App instead — `${SITE_URL}/tg/support`, the
// dashboard's chat running inside Telegram.
//
// Only the menu button. "⚡ Спросить ещё" under an in-chat answer stays the
// `ai:more` callback for everyone: that conversation has the in-chat mode on,
// the Mini App cannot turn it off, and an escalation there would send the
// person back to a chat where the assistant still intercepts their messages
// (see `aiReplyKeyboard` in lib/handler.ts).
//
// Pure on purpose: no config, no Redis, no network. lib/config.ts throws on
// import without the bot's secrets, and this gate is what has to be tested.

import { OWNER_USER_ID } from './owner';
import type { InlineKeyboard, InlineKeyboardButton } from './types';

/**
 * Who gets the Mini App instead of the in-chat assistant.
 *
 * Only the owner, per the project rule: a new screen is shown to him first and
 * opened to everyone only after his explicit go-ahead. A constant rather than
 * an env var or a Redis list, for two reasons. A gate that silently opens when
 * a variable is lost is not a gate. And the Mini App depends on a separate
 * frontend deploy — the site must serve /tg/support and accept initData signed
 * by THIS bot's token — which has to be verified in Telegram before anyone
 * else sees the button, so widening the list is meant to be a reviewed code
 * change.
 */
export const QUICK_ANSWER_WEBAPP_USER_IDS: readonly number[] = Object.freeze([OWNER_USER_ID]);

/** The Mini App route on the site. */
export const QUICK_ANSWER_WEBAPP_PATH = '/tg/support';

/** The menu button's label, the same for both kinds. */
export const QUICK_ANSWER_LABEL = '⚡ Быстрый ответ';

/** The in-chat callback the bot has always used for the menu button. */
export const QUICK_ANSWER_CALLBACK = 'ai';

/**
 * The Mini App URL for a site base URL, or null when Telegram would not take it.
 *
 * Null is not cosmetic. An unusable web_app URL makes Telegram reject the WHOLE
 * message, so a bad SITE_URL would cost the person the entire FAQ menu, not
 * just one button. Hence: https only (Telegram's own requirement), a real host,
 * no credentials, no query or fragment to glue the path onto. A path prefix is
 * kept, the same way lib/ai.ts appends its API path to SITE_URL.
 */
export function quickAnswerWebAppUrl(siteUrl: string): string | null {
  if (typeof siteUrl !== 'string') return null;
  const raw = siteUrl.trim();
  if (!raw || /[\s?#]/.test(raw)) return null;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname) return null;
  if (parsed.username || parsed.password) return null;

  const prefix = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${prefix}${QUICK_ANSWER_WEBAPP_PATH}`;
}

/**
 * Whether this person, in this chat, is given the Mini App.
 *
 * A web_app inline button is valid only in a private chat with the bot; in a
 * group or a forum topic Telegram rejects the whole message. A private chat's
 * id equals the user's id, so the operator group, its topics and anyone else's
 * chat never match.
 */
export function quickAnswerOpensWebApp(userId: number, chatId: number): boolean {
  if (!Number.isSafeInteger(userId) || userId <= 0) return false;
  if (chatId !== userId) return false;
  return QUICK_ANSWER_WEBAPP_USER_IDS.includes(userId);
}

export interface QuickAnswerTarget {
  /** Who will press the button. */
  readonly userId: number;
  /** The chat the keyboard is sent to. */
  readonly chatId: number;
  /** The site base URL, `config.siteUrl`. */
  readonly siteUrl: string;
}

/**
 * The menu button itself.
 *
 * Label and callback data for everyone outside the gate are byte-for-byte the
 * ones the bot used before, so their messages and the callback handler do not
 * change. The owner gets the same label opening the Mini App; if the URL is
 * unusable he silently gets the in-chat assistant rather than a broken menu.
 */
export function quickAnswerButton(target: QuickAnswerTarget): InlineKeyboardButton {
  if (quickAnswerOpensWebApp(target.userId, target.chatId)) {
    const url = quickAnswerWebAppUrl(target.siteUrl);
    if (url !== null) return { text: QUICK_ANSWER_LABEL, web_app: { url } };
  }
  return { text: QUICK_ANSWER_LABEL, callback_data: QUICK_ANSWER_CALLBACK };
}

/** Whether any button of this keyboard opens a Mini App. */
export function keyboardOpensWebApp(keyboard: InlineKeyboard): boolean {
  return keyboard.some((row) => row.some((button) => button.web_app !== undefined));
}

/** The part of a Telegram API response the retry decision reads. */
export interface SendOutcome {
  readonly ok: boolean;
  readonly error_code?: number;
}

/**
 * The keyboard to resend after Telegram refused one with a web_app button, or
 * null when there is nothing to retry.
 *
 * Retried only on a 400 — Telegram rejecting the message itself, which is what
 * an unacceptable web_app button produces. Not on success, not on a keyboard
 * without web_app (the failure has another cause and the same keyboard would
 * fail again), not on 403/429 and not on a network failure (no error_code):
 * there the first message may have arrived, and a duplicate menu is worse.
 *
 * In the copy the Mini App button becomes the in-chat callback with the same
 * label; any other web_app button is dropped, together with a row it leaves
 * empty. Everything else is kept in place.
 */
export function quickAnswerCallbackRetry(
  keyboard: InlineKeyboard,
  outcome: SendOutcome,
): InlineKeyboard | null {
  if (outcome.ok || outcome.error_code !== 400) return null;
  if (!keyboardOpensWebApp(keyboard)) return null;

  const rows: InlineKeyboard = [];
  for (const row of keyboard) {
    const kept: InlineKeyboardButton[] = [];
    for (const button of row) {
      if (button.web_app === undefined) {
        kept.push({ ...button });
      } else if (button.text === QUICK_ANSWER_LABEL) {
        kept.push({ text: QUICK_ANSWER_LABEL, callback_data: QUICK_ANSWER_CALLBACK });
      }
    }
    if (kept.length > 0) rows.push(kept);
  }
  return rows;
}
