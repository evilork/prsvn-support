// lib/away.ts
//
// Объявление «оператор в отъезде».
//
// ── Зачем ────────────────────────────────────────────────
// Человек, нажавший «Связаться со специалистом», ждёт живого ответа и не
// знает, что ждать придётся трое суток. Молчание он читает как «меня
// игнорируют», а не как «оператор в дороге», и уходит с этим ощущением
// раньше, чем оператор вообще увидит вопрос.
//
// ── Почему в базе, а не в переменной окружения ───────────
// Переменные Vercel применяются только НОВОЙ сборкой. Снять объявление из
// поездки означало бы открыть панель, поправить значение и дождаться выката —
// последнее, чем занимаются в дороге. Здесь же оператор шлёт боту одну
// команду с телефона, и объявление гаснет в ту же секунду.
//
// ── Что тикетам от этого ─────────────────────────────────
// Ничего. Тикеты создаются, сообщения доставляются оператору как обычно.
// Объявление — это приписка человеку, а не глушилка: пропавший вопрос был бы
// хуже вопроса, на который ответили с задержкой.

import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

const KEY = 'support:away';

/** Приписку в один тикет кладём один раз: повтор под каждым сообщением — шум. */
const NOTED = (ticketId: number) => `support:awaynote:${ticketId}`;
const NOTED_TTL_SEC = 60 * 60 * 24 * 14;

export interface Away {
  /** Когда оператор снова на связи, мс. */
  readonly until: number;
  /** С какого момента его нет, мс. Нужен только для текста. */
  readonly since: number;
}

const MSK = 'Europe/Moscow';

function parse(raw: unknown): Away | null {
  const v = typeof raw === 'string' ? safeJson(raw) : raw;
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const until = Number(o.until);
  const since = Number(o.since);
  if (!Number.isSafeInteger(until) || until <= 0) return null;
  return { until, since: Number.isSafeInteger(since) && since > 0 ? since : until };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Действующее объявление или null.
 *
 * Просроченное объявление считается снятым и НЕ удаляется: удаление на пути
 * чтения означало бы запись в базу на каждое сообщение клиента, а выигрыш —
 * один лишний ключ размером в полсотни байт.
 *
 * Сбой чтения базы — это null, то есть «объявления нет». Ошибиться здесь можно
 * в две стороны, и цена разная: лишняя приписка безобидна, а вот приписка,
 * показанная из-за сбоя ПОСЛЕ возвращения оператора, врала бы человеку. Точно
 * так же врала бы её пропажа, но это возвращает нас к сегодняшнему поведению,
 * которое мы и так считаем терпимым.
 */
export async function readAway(now = Date.now()): Promise<Away | null> {
  try {
    const away = parse(await redis.get(KEY));
    return away && away.until > now ? away : null;
  } catch (err) {
    console.error('[support][away] чтение не удалось:', err);
    return null;
  }
}

export async function setAway(until: number, since = Date.now()): Promise<void> {
  await redis.set(KEY, JSON.stringify({ until, since }), {
    // Живёт ровно до конца отъезда плюс сутки: даже забытое, оно погаснет само.
    ex: Math.max(60, Math.ceil((until - Date.now()) / 1000) + 86_400),
  });
}

export async function clearAway(): Promise<void> {
  await redis.del(KEY);
}

/** Пометить, что этому тикету приписку уже показывали. Возвращает true, если это первый раз. */
export async function claimAwayNote(ticketId: number): Promise<boolean> {
  try {
    const res = await redis.set(NOTED(ticketId), 1, { nx: true, ex: NOTED_TTL_SEC });
    return res !== null;
  } catch (err) {
    // Сбой базы толкуем в пользу показа: человек, увидевший приписку дважды,
    // потерял меньше, чем человек, не увидевший её ни разу.
    console.error('[support][away] отметка тикета не удалась:', err);
    return true;
  }
}

function fmt(ts: number, withTime: boolean): string {
  const d = new Date(ts);
  const day = d.toLocaleDateString('ru-RU', { timeZone: MSK, day: 'numeric', month: 'long' });
  if (!withTime) return day;
  const time = d.toLocaleTimeString('ru-RU', { timeZone: MSK, hour: '2-digit', minute: '2-digit' });
  return `${day}, ${time} МСК`;
}

/**
 * Текст объявления.
 *
 * Три вещи по порядку важности: живого человека не будет и до какого числа;
 * что делать прямо сейчас; что сообщение не пропадёт. Последнее — не
 * вежливость, а ответ на настоящий страх человека: он боится не задержки, а
 * того, что его вопрос никто не увидит.
 */
export function awayNotice(away: Away): string {
  return [
    '',
    `⏳ <b>Оператор в дороге</b> с ${fmt(away.since, true)} и вернётся ${fmt(away.until, false)}.`,
    'Раньше живого ответа не будет.',
    '',
    'Прямо сейчас может помочь ProxysAI — кнопка «⚡ Быстрый ответ». Он отвечает за несколько секунд, читает скриншоты и видит ваш баланс, устройства и платежи.',
    '',
    'Если вопрос всё-таки для человека — пишите здесь. Сообщение сохранится, оператор разберёт его сразу по возвращении.',
  ].join('\n');
}

/**
 * Разбор даты из команды оператора: «11.09 16:30», «11.09», «2026-09-11 16:30».
 *
 * Год не спрашиваем: отъезд задают на ближайшие дни, и «11.09» без года — это
 * то, как человек напишет с телефона. Если названная дата уже прошла, значит
 * имелся в виду следующий год.
 */
export function parseAwayUntil(input: string, now = Date.now()): number | null {
  const s = input.trim();
  const m =
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(s) ??
    /^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?(?:\s+(\d{1,2}):(\d{2}))?$/.exec(s);
  if (!m) return null;

  let year: number;
  let month: number;
  let day: number;
  let hour: number;
  let minute: number;

  if (s.includes('-')) {
    year = Number(m[1]);
    month = Number(m[2]);
    day = Number(m[3]);
    hour = Number(m[4] ?? 23);
    minute = Number(m[5] ?? 59);
  } else {
    day = Number(m[1]);
    month = Number(m[2]);
    year = m[3] ? Number(m[3]) : new Date(now).getUTCFullYear();
    hour = Number(m[4] ?? 23);
    minute = Number(m[5] ?? 59);
  }

  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;

  // МСК — это UTC+3 круглый год, перевода часов в России нет с 2014-го.
  const build = (y: number) => Date.UTC(y, month - 1, day, hour - 3, minute, 0, 0);
  let ts = build(year);
  if (ts <= now && !m[3] && !s.includes('-')) ts = build(year + 1);
  return Number.isFinite(ts) ? ts : null;
}
