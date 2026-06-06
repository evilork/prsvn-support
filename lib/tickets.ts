// lib/tickets.ts
import { Redis } from '@upstash/redis';
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

export async function touchTicket(
  ticketId: number,
  lastUserMsgId?: number,
) {
  const t = await getTicket(ticketId);
  if (!t) return;
  t.updatedAt = Date.now();
  t.messagesCount += 1;
  if (lastUserMsgId) t.lastUserMsgId = lastUserMsgId;
  await Promise.all([
    saveTicket(t),
    redis.zadd(K.openZSet, { score: t.updatedAt, member: String(ticketId) }),
  ]);
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
): Promise<{ tickets: Ticket[]; total: number }> {
  const zset = status === 'open' ? K.openZSet : K.closedZSet;
  const total = await redis.zcard(zset);
  if (total === 0) return { tickets: [], total: 0 };

  const start = page * config.pageSize;
  const stop = start + config.pageSize - 1;
  // ZREVRANGE: newest first
  const ids = await redis.zrange<string[]>(zset, start, stop, { rev: true });
  if (!ids || ids.length === 0) return { tickets: [], total };

  const tickets: Ticket[] = [];
  for (const id of ids) {
    const t = await getTicket(parseInt(id, 10));
    if (t) tickets.push(t);
  }
  return { tickets, total };
}

export async function countTickets(status: 'open' | 'closed'): Promise<number> {
  const zset = status === 'open' ? K.openZSet : K.closedZSet;
  return redis.zcard(zset);
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
