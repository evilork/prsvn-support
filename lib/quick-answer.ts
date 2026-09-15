// lib/quick-answer.ts
//
// The "⚡ Быстрый ответ" button in the FAQ menu: in-chat assistant or Mini App.
//
// Outside the gate the button is the in-chat assistant, exactly as before:
// callback `ai`, handled in lib/handler.ts. Inside it the same ProxysAI opens
// as a Telegram Mini App instead — `${SITE_URL}/tg/support`, the dashboard's
// chat running inside Telegram. The gate is the site's own switch, the Redis
// set `support:miniapp:users`, so one SADD or SREM opens or closes the Mini
// App on both surfaces at once.
//
// Only the menu button. "⚡ Спросить ещё" under an in-chat answer stays the
// `ai:more` callback for everyone: that conversation has the in-chat mode on,
// the Mini App cannot turn it off, and an escalation there would send the
// person back to a chat where the assistant still intercepts their messages
// (see `aiReplyKeyboard` in lib/handler.ts).
//
// Pure on purpose: no config, no Redis, no network. The set's members come in
// as an argument (lib/quick-answer-gate.ts reads them, cached and failing
// closed); lib/config.ts throws on import without the bot's secrets, and this
// gate is what has to be tested.

import { OWNER_USER_ID } from './owner';
import type { InlineKeyboard, InlineKeyboardButton } from './types';

/** The Mini App route on the site. */
export const QUICK_ANSWER_WEBAPP_PATH = '/tg/support';

/** The menu button's label, the same for both kinds. */
export const QUICK_ANSWER_LABEL = '⚡ Быстрый ответ';

/** The in-chat callback the bot has always used for the menu button. */
export const QUICK_ANSWER_CALLBACK = 'ai';

/**
 * The Redis set that opens the Mini App, shared with the site.
 *
 * The dashboard's support button reads the same key
 * (src/lib/support-miniapp-access.ts on the frontend), so one switch controls
 * both surfaces, without a deploy of either:
 *
 *   SADD support:miniapp:users tg_<telegram id>   one more person
 *   SADD support:miniapp:users "*"                everyone
 *   SREM support:miniapp:users "*"                back to the list
 */
export const QUICK_ANSWER_WEBAPP_USERS_KEY = 'support:miniapp:users';

/** Set member that opens the Mini App to everyone. */
export const QUICK_ANSWER_WEBAPP_EVERYONE = '*';

/** A well-formed per-person member: the site's account id for a Telegram user. */
const WEBAPP_MEMBER_RE = /^tg_[1-9]\d*$/;

/**
 * The set member that opens the Mini App to one Telegram user, or null for an
 * id that no Telegram user can have.
 *
 * `tg_<id>` is how the site names accounts created through Telegram, and the
 * site checks exactly that string; a bare id in the set opens nothing on
 * either side.
 */
export function quickAnswerWebAppMember(userId: number): string | null {
  if (!Number.isSafeInteger(userId) || userId <= 0) return null;
  return `tg_${userId}`;
}

export interface QuickAnswerWebAppMembersSummary {
  /** `*` is in the set. */
  readonly everyone: boolean;
  /** Well-formed `tg_<id>` members. */
  readonly users: number;
  /** Anything else — a bare id, a typo, a non-string — which opens nothing. */
  readonly ignored: number;
}

/**
 * What the set holds, as counts only.
 *
 * For diagnostics: an `ignored` above zero is the usual reason someone added
 * to the set still sees the old button (`SADD … 6944217115` without `tg_`).
 * No ids are returned. O(n) in the size of the set.
 */
export function summarizeQuickAnswerWebAppMembers(
  members: readonly unknown[],
): QuickAnswerWebAppMembersSummary {
  let everyone = false;
  let users = 0;
  let ignored = 0;
  if (!Array.isArray(members)) return { everyone, users, ignored };

  for (const member of members) {
    if (member === QUICK_ANSWER_WEBAPP_EVERYONE) {
      everyone = true;
    } else if (
      typeof member === 'string' &&
      WEBAPP_MEMBER_RE.test(member) &&
      Number.isSafeInteger(Number(member.slice(3)))
    ) {
      users += 1;
    } else {
      ignored += 1;
    }
  }
  return { everyone, users, ignored };
}

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
 * `members` is what `support:miniapp:users` holds — the site's set, the one
 * its dashboard button reads — or an empty list when it could not be read:
 *
 * - the owner always, whatever the set holds and whether it was read at all:
 *   the gate must not lock out the person checking it, and a new screen is
 *   his to look at first;
 * - `*` in the set opens it to everyone;
 * - `tg_<id>` opens it to that person;
 * - anyone else keeps the in-chat callback.
 *
 * A web_app inline button is valid only in a private chat with the bot; in a
 * group or a forum topic Telegram rejects the whole message. A private chat's
 * id equals the user's id, so the operator group, its topics and anyone else's
 * chat never match — not for the owner, not with `*` in the set.
 *
 * O(n) in the size of the set.
 */
export function quickAnswerOpensWebApp(
  userId: number,
  chatId: number,
  members: readonly unknown[],
): boolean {
  const own = quickAnswerWebAppMember(userId);
  if (own === null) return false;
  if (chatId !== userId) return false;
  if (userId === OWNER_USER_ID) return true;
  if (!Array.isArray(members)) return false;
  return members.includes(QUICK_ANSWER_WEBAPP_EVERYONE) || members.includes(own);
}

export interface QuickAnswerTarget {
  /** Who will press the button. */
  readonly userId: number;
  /** The chat the keyboard is sent to. */
  readonly chatId: number;
  /** The site base URL, `config.siteUrl`. */
  readonly siteUrl: string;
  /**
   * The members of `support:miniapp:users` as lib/quick-answer-gate.ts read
   * them; empty when the read failed.
   */
  readonly webAppMembers: readonly unknown[];
}

/**
 * The menu button itself.
 *
 * Label and callback data for everyone outside the gate are byte-for-byte the
 * ones the bot used before, so their messages and the callback handler do not
 * change. People inside it get the same label opening the Mini App; if the URL
 * is unusable they silently get the in-chat assistant rather than a broken
 * menu.
 */
export function quickAnswerButton(target: QuickAnswerTarget): InlineKeyboardButton {
  if (quickAnswerOpensWebApp(target.userId, target.chatId, target.webAppMembers)) {
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
