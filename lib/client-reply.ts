// lib/client-reply.ts
//
// A short thank-you or "ok" from the client is not a question for the operator.
//
// ── Why ─────────────────────────────────────────────────
// Audit 14.09.2026 (BS-1): 11 of the 12 tickets marked "waiting" had «спасибо»
// as the client's last message. The operator answered, the person said thanks,
// and the ticket went back to 🔴, got a personal ping two hours later and a line
// in the digest. The signal turned into noise and real waiting tickets got lost.
//
// ── Why so strict ───────────────────────────────────────
// A mistake one way costs an extra ping; the other way it swallows a complaint.
// So the test is narrow: EVERY word must come from a short vocabulary of thanks,
// agreement and "it works", at least one of them must not be a filler, there is
// no question mark and the message is short. «Спасибо, но не работает» fails on
// «но» and «не», which are not in the vocabulary at all. Anything we are not
// sure about counts as a question, exactly as before.
//
// Emoji follow the same rule: an allowlist, not a denylist. EVERY pictograph in
// the message, alone, next to words or as a sticker's emoji, must be a clearly
// positive one (👍 🙏 ❤️ ✅ 🙂 …). A denylist missed 🆘, ⏳, 😔, 🤦‍♂️ and the rest
// of the thousands of emoji, and each miss swallowed a complaint.
//
// «Да», «нет», «ага» are left out on purpose: they answer an operator's question
// («у вас iPhone?»), and after them the operator has to continue.

import type { TgMessage } from './types';

/** Longer than this is a story, not a thank-you. */
const MAX_CHARS = 80;

/** More words than this is a story, not a thank-you. */
const MAX_WORDS = 8;

/**
 * Words that close a conversation on their own: thanks, agreement, "it helped".
 * Compared after lower-casing and replacing ё with е.
 */
const CLOSING_CORE: ReadonlySet<string> = new Set([
  // thanks
  'спасибо', 'спасибочки', 'спасиб', 'спс', 'пасиб', 'пасибо', 'благодарю', 'благодарим', 'сенкс',
  // agreement, "understood"
  'ок', 'окей', 'оке', 'хорошо', 'ладно', 'понял', 'поняла', 'поняли', 'понятно', 'ясно', 'принято',
  'договорились',
  // "it works"
  'работает', 'работают', 'заработало', 'заработал', 'заработала', 'заработали', 'помогло', 'помогли',
  'помог', 'помогла', 'получилось', 'вышло', 'норм', 'нормально', 'отлично', 'супер', 'класс', 'круто',
  'решено', 'разобрался', 'разобралась', 'подключилось', 'подключился', 'подключилась', 'лучшие',
  'молодцы', 'удачи',
  // english
  'thanks', 'thank', 'thx', 'ty', 'tysm', 'ok', 'okay', 'great', 'perfect', 'awesome', 'cool', 'nice',
  'works', 'working', 'worked', 'good', 'fixed', 'solved', 'helped', 'got', 'understood', 'appreciate',
  'appreciated', 'cheers', 'fine', 'alright',
]);

/**
 * Fillers: allowed next to a CLOSING_CORE word but closing nothing by
 * themselves. «Вам», «теперь», "it" alone are fragments, not thanks.
 */
const CLOSING_FILLER: ReadonlySet<string> = new Set([
  'большое', 'огромное', 'огромнейшее', 'вам', 'тебе', 'вы', 'всем', 'еще', 'раз', 'все', 'теперь', 'уже',
  'хорошего', 'дня', 'вечера',
  'you', 'so', 'very', 'much', 'a', 'lot', 'now', 'it', 'all',
]);

/**
 * Emoji modifiers and joiners: skin tones, VS15/VS16, ZWJ. Removed before the
 * allowlist check, so 👍🏻 is compared as 👍, ❤️ as ❤ and 🤦‍♂️ as 🤦 + ♂.
 */
const EMOJI_JOINERS = /[‍︎️\u{1F3FB}-\u{1F3FF}]/gu;

/**
 * The only pictographs a closing remark may contain: approval, thanks, joy.
 * Everything else, including 🆘 ⏳ ❗ ‼️ 😔 😐 🙄 🤦 🤷 💔 👀 and ones added to
 * Unicode later, keeps the ticket waiting. Laughter (😂 😅) and winks are left
 * out on purpose: they are just as often sarcasm or embarrassment.
 * Stored without joiners, so a pasted ❤️ with VS16 still matches.
 */
const POSITIVE_EMOJI: ReadonlySet<string> = new Set(
  [
    '👍', '👌', '🙏', '🤝', '🫶', '👏', '💪', '🫡',
    '❤', '♥', '🧡', '💛', '💚', '💙', '💜', '🤍', '💖', '💗', '💕',
    '✅', '✔', '☑', '💯', '🔥', '🎉', '🥳', '✨',
    '🙂', '😊', '☺', '😀', '😃', '😄', '😁', '🥰', '😍', '🤗',
  ].map((e) => e.replace(EMOJI_JOINERS, '')),
);

/** Question marks in any spelling, emoji and the interrobang included. */
const QUESTION_MARK = /[?？¿❓❔⁉‽]/u;

const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

/** Letters, digits, punctuation and spaces: judged by the word check instead. */
const PLAIN_CHAR = /[\p{L}\p{N}\p{P}\s]/u;

/**
 * Check every character outside words and punctuation.
 *
 * `'none'` — no pictographs at all; `'positive'` — only allowlisted ones;
 * `'uncertain'` — any other pictograph or symbol: a non-allowlisted emoji, a
 * flag, a keycap, «+», «<3», a currency sign. We do not guess what those mean.
 * O(n) in the message length, which is capped at MAX_CHARS.
 */
function classifySymbols(text: string): 'none' | 'positive' | 'uncertain' {
  let positive = false;
  for (const ch of text.replace(EMOJI_JOINERS, '')) {
    if (PICTOGRAPHIC.test(ch)) {
      if (!POSITIVE_EMOJI.has(ch)) return 'uncertain';
      positive = true;
    } else if (!PLAIN_CHAR.test(ch)) {
      return 'uncertain';
    }
  }
  return positive ? 'positive' : 'none';
}

/**
 * A short thank-you, "ok", «всё работает», or positive emoji only.
 *
 * `false` for anything uncertain: a question, a negation, a number, a link, any
 * word outside the vocabulary, a long text, any emoji outside the allowlist.
 */
export function isClosingRemark(text: string): boolean {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed === '' || trimmed.length > MAX_CHARS) return false;
  if (QUESTION_MARK.test(trimmed)) return false;

  const symbols = classifySymbols(trimmed);
  if (symbols === 'uncertain') return false;

  const words = trimmed
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== '');

  // Emoji only: 👍, 🙏🙏, ❤️. Without a pictograph («)))», «...») we are not sure.
  if (words.length === 0) return symbols === 'positive';

  if (words.length > MAX_WORDS) return false;
  let hasCore = false;
  for (const w of words) {
    if (CLOSING_CORE.has(w)) hasCore = true;
    else if (!CLOSING_FILLER.has(w)) return false;
  }
  return hasCore;
}

/**
 * The same for a whole message.
 *
 * Plain text and stickers only. A caption on a photo or file is not a thank-you:
 * a screenshot captioned «спасибо» may show the very error being discussed. A
 * sticker is judged by its emoji against the same allowlist: a 👍 sticker
 * closes, a 😿 or 🆘 one does not. A sticker without an emoji is uncertain, so
 * the ticket waits.
 */
export function isClosingMessage(msg: Pick<TgMessage, 'text' | 'caption' | 'sticker'>): boolean {
  if (msg.sticker) {
    const emoji = typeof msg.sticker.emoji === 'string' ? msg.sticker.emoji : '';
    return emoji !== '' && isClosingRemark(emoji);
  }
  if (msg.caption) return false;
  return typeof msg.text === 'string' && isClosingRemark(msg.text);
}
