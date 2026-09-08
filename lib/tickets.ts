// lib/tickets.ts
import { Redis } from '@upstash/redis';
import { disableAiMode } from './ai';
import { config } from './config';
import type { TgUser } from './types';

const redis = Redis.fromEnv();

export interface Ticket {
  id: number;
  userId: number;
  firstName: string;
  lastName?: string;
  username?: string;
  status: 'open' | 'closed';
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
  messagesCount: number;
  lastUserMsgId?: number; // original message_id of last client msg in the client chat (for re-copy)
  /** Тема в группе оператора, если тикет вынесен в тему. */
  threadId?: number;
  /** Закреплённая карточка в теме — её редактируем при обновлении. */
  headerMsgId?: number;
  /** Когда клиент писал в последний раз. */
  lastClientAt?: number;
  /** Когда оператор отвечал в последний раз. */
  lastOperatorAt?: number;
}

const K = {
  counter: 'support:ticket:counter',
  ticket: (id: number) => `support:ticket:${id}`,
  userActive: (userId: number) => `support:user:${userId}:active`,
  openZSet: 'support:tickets:open',
  closedZSet: 'support:tickets:closed',
  banned: (userId: number) => `support:banned:${userId}`,
  rate: (userId: number) => `support:rate:${userId}`,
  adminMsg: (messageId: number) => `support:adminmsg:${messageId}`,
  ticketMsgs: (id: number) => `support:ticket:${id}:msgs`,
  thread: (threadId: number) => `support:thread:${threadId}`,
  tplLock: (id: number, key: string) => `support:tpl-lock:${id}:${key}`,
  update: (updateId: number) => `support:upd:${updateId}`,
};

async function saveTicket(t: Ticket) {
  await redis.set(K.ticket(t.id), t, { ex: config.ticketDataTtlSec });
}

export async function getTicket(id: number): Promise<Ticket | null> {
  return (await redis.get<Ticket>(K.ticket(id))) ?? null;
}

export async function getActiveTicketForUser(
  userId: number,
): Promise<Ticket | null> {
  const id = await redis.get<number>(K.userActive(userId));
  if (!id) return null;
  const t = await getTicket(id);
  return t && t.status === 'open' ? t : null;
}

export async function createTicket(user: TgUser): Promise<Ticket> {
  const id = await redis.incr(K.counter);
  const now = Date.now();
  const t: Ticket = {
    id,
    userId: user.id,
    firstName: user.first_name,
    lastName: user.last_name,
    username: user.username,
    status: 'open',
    createdAt: now,
    updatedAt: now,
    messagesCount: 0,
  };
  await Promise.all([
    saveTicket(t),
    redis.set(K.userActive(user.id), id, { ex: config.ticketDataTtlSec }),
    redis.zadd(K.openZSet, { score: now, member: String(id) }),
  ]);
  return t;
}

/** Клиент написал: счётчик, время, последнее сообщение. */
export async function touchTicket(
  ticketId: number,
  lastUserMsgId?: number,
): Promise<Ticket | null> {
  const t = await getTicket(ticketId);
  if (!t) return null;
  t.updatedAt = Date.now();
  t.lastClientAt = t.updatedAt;
  t.messagesCount += 1;
  if (lastUserMsgId) t.lastUserMsgId = lastUserMsgId;
  await Promise.all([
    saveTicket(t),
    redis.zadd(K.openZSet, { score: t.updatedAt, member: String(ticketId) }),
  ]);
  return t;
}

/**
 * Оператор ответил: с этого момента тикет не «ждёт ответа».
 *
 * Здесь же гаснет режим быстрого ответа. Живой диалог всегда главнее
 * помощника: без этого следующая реплика человека — «сделал, не помогло» —
 * доставалась бы модели, оператор оставался бы с тикетом, где клиент будто бы
 * промолчал, и через неделю тишины такой тикет уехал бы в массовое закрытие.
 * Место выбрано одно на все пути ответа: и Reply в личке, и сообщение в теме,
 * и отправка шаблона проходят через эту функцию.
 */
export async function markOperatorReply(ticketId: number): Promise<Ticket | null> {
  const t = await getTicket(ticketId);
  if (!t) return null;
  await disableAiMode(t.userId);
  t.lastOperatorAt = Date.now();
  t.updatedAt = t.lastOperatorAt;
  await Promise.all([
    saveTicket(t),
    // Ответ оператора — тоже активность: иначе тикет, где последним писал
    // оператор, через неделю попал бы под массовое закрытие «тихих».
    t.status === 'open'
      ? redis.zadd(K.openZSet, { score: t.updatedAt, member: String(ticketId) })
      : Promise.resolve(null),
  ]);
  return t;
}

// ─── тихие тикеты ──────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/** Открытые тикеты без активности дольше `days` дней. Счёт по оценке в ZSET. */
export async function countStaleOpen(days: number, now = Date.now()): Promise<number> {
  return redis.zcount(K.openZSet, 0, now - days * DAY_MS);
}

export async function listStaleOpenIds(days: number, now = Date.now(), limit = 500): Promise<number[]> {
  const ids = await redis.zrange<string[]>(K.openZSet, 0, now - days * DAY_MS, {
    byScore: true,
    offset: 0,
    count: limit,
  });
  return (ids || []).map((x) => parseInt(String(x), 10)).filter((n) => Number.isFinite(n));
}

/** Ждёт ли тикет ответа оператора. Старые тикеты без отметок считаем ждущими. */
export function isWaiting(t: Ticket): boolean {
  if (t.status !== 'open') return false;
  const client = t.lastClientAt ?? t.updatedAt;
  return client > (t.lastOperatorAt ?? 0);
}

export async function closeTicket(ticketId: number) {
  const t = await getTicket(ticketId);
  if (!t) return null;
  const now = Date.now();
  t.status = 'closed';
  t.closedAt = now;
  t.updatedAt = now;
  await Promise.all([
    saveTicket(t),
    redis.zrem(K.openZSet, String(ticketId)),
    redis.zadd(K.closedZSet, { score: now, member: String(ticketId) }),
    redis.del(K.userActive(t.userId)),
  ]);
  return t;
}

export async function reopenTicket(ticketId: number) {
  const t = await getTicket(ticketId);
  if (!t) return null;
  const now = Date.now();
  t.status = 'open';
  t.updatedAt = now;
  t.closedAt = undefined;
  await Promise.all([
    saveTicket(t),
    redis.zrem(K.closedZSet, String(ticketId)),
    redis.zadd(K.openZSet, { score: now, member: String(ticketId) }),
    redis.set(K.userActive(t.userId), ticketId, { ex: config.ticketDataTtlSec }),
  ]);
  return t;
}

export async function listTickets(
  status: 'open' | 'closed',
  page: number,
  pageSize: number = config.pageSize,
): Promise<{ tickets: Ticket[]; total: number }> {
  const zset = status === 'open' ? K.openZSet : K.closedZSet;
  const total = await redis.zcard(zset);
  if (total === 0) return { tickets: [], total: 0 };

  const start = page * pageSize;
  const stop = start + pageSize - 1;
  // ZREVRANGE: newest first
  const ids = await redis.zrange<string[]>(zset, start, stop, { rev: true });
  if (!ids || ids.length === 0) return { tickets: [], total };

  // Одним обращением, а не по одному на тикет: панель открывается на каждый
  // /start, и десять последовательных чтений давали заметную паузу.
  const raws = await redis.mget<(Ticket | null)[]>(
    ...ids.map((id) => K.ticket(parseInt(id, 10))),
  );
  const tickets: Ticket[] = [];
  (raws || []).forEach((t) => {
    if (t) tickets.push(t);
  });
  return { tickets, total };
}

export async function countTickets(status: 'open' | 'closed'): Promise<number> {
  const zset = status === 'open' ? K.openZSet : K.closedZSet;
  return redis.zcard(zset);
}

// ─── темы в группе ─────────────────────────────────────────

export async function setTicketThread(
  ticketId: number,
  threadId: number,
  headerMsgId?: number,
): Promise<void> {
  const t = await getTicket(ticketId);
  if (!t) return;
  t.threadId = threadId;
  if (headerMsgId) t.headerMsgId = headerMsgId;
  await Promise.all([
    saveTicket(t),
    redis.set(K.thread(threadId), ticketId, { ex: config.ticketDataTtlSec }),
  ]);
}

export async function ticketFromThread(threadId: number): Promise<number | null> {
  return (await redis.get<number>(K.thread(threadId))) ?? null;
}

// ─── ban list ──────────────────────────────────────────────

export async function isBanned(userId: number): Promise<boolean> {
  return (await redis.get(K.banned(userId))) !== null;
}

export async function setBanned(userId: number, banned: boolean) {
  if (banned) await redis.set(K.banned(userId), 1);
  else await redis.del(K.banned(userId));
}

// ─── rate limit ────────────────────────────────────────────

export async function checkRateLimit(
  userId: number,
  limit: number,
): Promise<boolean> {
  const key = K.rate(userId);
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 60);
  return count <= limit;
}

/**
 * Сказать ли человеку про лимит.
 *
 * Один раз за окно, а не на каждое лишнее сообщение. Иначе человек, приславший
 * пачку из десяти снимков, получает подряд десять одинаковых «Слишком много
 * сообщений» — то есть наказание превращается в тот самый поток, от которого
 * лимит и защищает, только в обратную сторону.
 *
 * Сбой базы — говорим: молчание в ответ на сообщение хуже повторной строки.
 */
export async function claimRateLimitNotice(userId: number): Promise<boolean> {
  try {
    const first = await redis.set(`support:ratemsg:${userId}`, 1, { nx: true, ex: 60 });
    return first !== null;
  } catch (err) {
    console.error('[support] rate notice mark failed:', err);
    return true;
  }
}

// ─── повторная доставка обновлений ─────────────────────────

/** Сколько помним обработанные обновления. */
const UPDATE_SEEN_TTL_SEC = 120;

/**
 * Это обновление уже обработано?
 *
 * Telegram повторяет доставку, если ответа на вебхук не дождался, а «Быстрый
 * ответ» держит запрос до сорока секунд — повтор здесь не исключение, а
 * ожидаемое поведение. Без отсечки один вопрос человека означал бы второе
 * обращение к модели (деньги и дневная квота) и второй тикет у оператора.
 *
 * SET NX: ключ ставит тот, кто пришёл первым. Сбой базы решаем в пользу
 * доставки — лучше обработать дважды, чем потерять единственное сообщение.
 */
export async function isDuplicateUpdate(updateId: number): Promise<boolean> {
  if (!Number.isFinite(updateId) || updateId <= 0) return false;
  try {
    const first = await redis.set(K.update(updateId), 1, { nx: true, ex: UPDATE_SEEN_TTL_SEC });
    return first === null;
  } catch (err) {
    console.error('[support] update dedup failed:', err);
    return false;
  }
}

// ─── admin msg ↔ ticket mapping for Reply lookup ──────────

export async function mapAdminMsgToTicket(messageId: number, ticketId: number) {
  await redis.set(K.adminMsg(messageId), ticketId, {
    ex: config.ticketDataTtlSec,
  });
}

export async function ticketFromAdminMsg(
  messageId: number,
): Promise<number | null> {
  return (await redis.get<number>(K.adminMsg(messageId))) ?? null;
}

// ─── per-ticket client message ids (for "show all") ────────

export async function addTicketMsg(ticketId: number, clientMsgId: number) {
  const key = K.ticketMsgs(ticketId);
  await redis.rpush(key, clientMsgId);
  await redis.ltrim(key, -100, -1);
  await redis.expire(key, config.ticketDataTtlSec);
}

export async function getTicketMsgs(ticketId: number): Promise<number[]> {
  const arr = await redis.lrange<number>(K.ticketMsgs(ticketId), 0, -1);
  return (arr || []).map((x) => Number(x)).filter((n) => Number.isFinite(n));
}

// ─── Замок на отправку шаблона ───────────────────────────────

const TEMPLATE_LOCK_TTL_SEC = 10;

/**
 * Пропустить одну отправку шаблона в тикет за TEMPLATE_LOCK_TTL_SEC секунд.
 * Возвращает false, если такая же отправка только что прошла (двойное
 * нажатие кнопки). Ключ снимается сам по TTL; при сбое отправки его снимает
 * releaseTemplateSendLock, чтобы оператор мог повторить сразу.
 */
export async function acquireTemplateSendLock(ticketId: number, key: string): Promise<boolean> {
  const res = await redis.set(K.tplLock(ticketId, key), 1, { nx: true, ex: TEMPLATE_LOCK_TTL_SEC });
  return res === 'OK';
}

export async function releaseTemplateSendLock(ticketId: number, key: string): Promise<void> {
  await redis.del(K.tplLock(ticketId, key));
}
