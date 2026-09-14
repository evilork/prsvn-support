// lib/tickets.ts
import { Redis } from '@upstash/redis';
import { disableAiMode } from './ai';
import { config } from './config';
import { maskSubscriptionLinks } from './redact';
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
  /**
   * С какого момента тикет ждёт ответа НЕПРЕРЫВНО.
   *
   * Не то же самое, что `lastClientAt`: человек, написавший четыре сообщения
   * подряд за час, ждёт с первого, а не с последнего. Считая по последнему, мы
   * обнуляли бы ожидание каждым его «ну что там?» — то есть ровно у самых
   * настойчивых, у тех, кто и попадает в разбор с «Поддержка Ваша говно».
   * Ставится при переходе «отвечен → ждёт», снимается ответом оператора.
   */
  waitingSince?: number;
  /**
   * Последняя реплика клиента текстом (обрезана).
   *
   * Нужна крону тихих тикетов: чтобы помощник ответил вместо молчания, ему
   * нужен сам вопрос, а в тикете до сих пор лежал только `message_id`.
   * Вложения сюда не попадают — по ним отвечать вслепую нечего.
   */
  lastClientText?: string;
  /** Когда помощник ответил вместо молчания. Ставится один раз на тикет. */
  autoAnsweredAt?: number;
  /**
   * Клиент заблокировал бота: ответ оператора доставить невозможно.
   *
   * Флаг нужен ИМЕННО в тикете, а не только в журнале: до 10.09.2026
   * недоставленный ответ просто терялся — оператор видел «⚠️ Не доставлено» и
   * шёл дальше, а человек оставался с тишиной и был уверен, что ему не
   * ответили. Снимается первым же сообщением клиента.
   */
  blocked?: boolean;
  /**
   * Ответы оператора, которые не доехали. Дошлём, когда человек напишет снова.
   *
   * Храним не текст, а ССЫЛКУ на сообщение оператора (чат и номер): ответ
   * бывает картинкой или пересланным сообщением, и текстовая копия потеряла бы
   * ровно то, ради чего его прислали. Копирование по ссылке — тот же путь,
   * которым ответ шёл в первый раз.
   */
  pendingOperator?: { chatId: number; messageId: number; at: number }[];
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
  text?: string,
): Promise<Ticket | null> {
  const t = await getTicket(ticketId);
  if (!t) return null;
  // Отметку начала ожидания ставим на переходе «отвечен → ждёт» И тогда, когда
  // её ещё нет. Второе условие — не перестраховка: без него отметка не
  // появлялась НИКОГДА у тикета, на который оператор ещё ни разу не отвечал.
  // `isWaiting` у свежесозданного тикета уже true (`lastClientAt ?? updatedAt`
  // больше нуля), поэтому «только на переходе» означало «только со второго
  // круга», а до первого ответа оператора счётчик падал на запасной путь
  // `lastClientAt` — то есть обнулялся каждым «ну что там?» ровно у самых
  // настойчивых, у тех, ради кого всё и делалось.
  if (!t.waitingSince || !isWaiting(t)) t.waitingSince = Date.now();
  t.updatedAt = Date.now();
  t.lastClientAt = t.updatedAt;
  t.messagesCount += 1;
  if (lastUserMsgId) t.lastUserMsgId = lastUserMsgId;
  // Больше 600 знаков помощнику не нужно, а тикет лежит полгода.
  // Mask subscription links BEFORE storing: this text goes to the operator's
  // ping and to the model, and the link is the access itself (audit BS-7, see
  // lib/redact.ts).
  if (typeof text === 'string' && text.trim()) {
    const masked = maskSubscriptionLinks(text.trim()).slice(0, 600);
    if (masked) t.lastClientText = masked;
  }
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
  // Ожидание закончилось — и вместе с ним право крона напоминать про этот
  // тикет. Право ответить помощником тоже: `autoAnsweredAt` не сбрасываем,
  // один автоответ на тикет и есть потолок.
  t.waitingSince = undefined;
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
  // Ожидание отсчитывается ЗАНОВО. Тикет мог пролежать закрытым неделю, и
  // старая отметка означала бы «ждёт 168 часов» в ту же секунду: дайджест
  // получил бы его первым, а автоответ не получил бы вовсе — тот отсекает
  // старше 12 часов. Закрытый тикет никого не заставлял ждать.
  if (t.lastClientAt && t.lastClientAt > (t.lastOperatorAt ?? 0)) t.waitingSince = now;
  else t.waitingSince = undefined;
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

// ─── тикеты, которые ждут ответа ───────────────────────────
//
// До 10.09.2026 «ждёт ответа» жило ровно в двух местах: значке 🔴 в имени темы
// и в счётчике на панели админа. Оба читаются, только когда оператор сам придёт
// и посмотрит. Механизма, который НАПОМНИТ, не было ни одного — в vercel.json
// бота не было ни строчки про кроны. На конец разбираемой выгрузки без ответа
// висели 14 тикетов, трое ждали больше суток.

/** Сколько тикетов разбирает один проход крона. */
const WAITING_SCAN_LIMIT = 300;

export interface WaitingTicket {
  ticket: Ticket;
  /** Сколько ждёт, мс. */
  waitedMs: number;
}

/**
 * Открытые тикеты, ждущие ответа оператора дольше `minMs`.
 *
 * Читаем ZSET открытых пачкой, а не по одному: у крона на всё меньше минуты, а
 * одно обращение к базе из Вирджинии во Франкфурт стоит около ста миллисекунд.
 *
 * Старые тикеты без `waitingSince` (заведены до этой правки) считаем ждущими с
 * `lastClientAt`: это ровно прежнее поведение `isWaiting`, только с числом.
 *
 * Возвращает от старых к новым — в том же порядке они и нужны оператору.
 */
export async function listWaitingTickets(
  minMs: number,
  now = Date.now(),
  limit = WAITING_SCAN_LIMIT,
): Promise<WaitingTicket[]> {
  const ids = await redis.zrange<string[]>(K.openZSet, 0, now, {
    byScore: true,
    offset: 0,
    count: limit,
  });
  if (!ids || ids.length === 0) return [];

  const raws = await redis.mget<(Ticket | null)[]>(
    ...ids.map((id) => K.ticket(parseInt(String(id), 10))),
  );

  const out: WaitingTicket[] = [];
  for (const t of raws || []) {
    if (!t || !isWaiting(t)) continue;
    // Заблокировавшего бота пропускаем целиком. Ему физически нельзя ничего
    // доставить: автоответ ушёл бы в пустоту и сжёг единственную попытку на
    // тикет, а в дайджесте он стоял бы вечно — «#223 — 19 ч», «#223 — 31 ч» —
    // про человека, которому нечего написать. Признак снимается его же первым
    // сообщением (`takeUndelivered`), и тикет вернётся в список сам.
    if (t.blocked) continue;
    const since = t.waitingSince ?? t.lastClientAt ?? t.updatedAt;
    const waitedMs = now - since;
    if (waitedMs >= minMs) out.push({ ticket: t, waitedMs });
  }
  out.sort((a, b) => b.waitedMs - a.waitedMs);
  return out;
}

/**
 * Пометить, что помощник ответил вместо молчания. `false` — уже отвечал.
 *
 * Проверка и отметка одним чтением-записью того же тикета: крон ходит раз в
 * четверть часа, и два прохода подряд не должны дать человеку два автоответа.
 */
export async function claimAutoAnswer(ticketId: number, now = Date.now()): Promise<boolean> {
  const t = await getTicket(ticketId);
  if (!t || t.status !== 'open' || t.autoAnsweredAt) return false;
  t.autoAnsweredAt = now;
  await saveTicket(t);
  return true;
}

/**
 * Вернуть отметку: помощник так и не сказал человеку ни слова.
 *
 * Нужна там, где неудача ВРЕМЕННАЯ и повтор через четверть часа осмыслен:
 * ручка сайта ответила 429 по суточному или минутному лимиту, Telegram не
 * принял сообщение. Без отката единственная попытка на тикет сгорала на
 * стороннем отказе, и человек не получал ничего уже никогда.
 *
 * Отказ самой модели откатывать НЕ надо: он повторится и стоит денег.
 */
export async function releaseAutoAnswer(ticketId: number): Promise<void> {
  const t = await getTicket(ticketId);
  if (!t || !t.autoAnsweredAt) return;
  t.autoAnsweredAt = undefined;
  await saveTicket(t);
}

/**
 * Персональный пинг оператору по одному тикету — не чаще раза в `hours`.
 *
 * Замок ПО ТИКЕТУ, в отличие от дайджеста: тот держит один глобальный ключ, и
 * тикет, перешагнувший порог через десять минут после рассылки, ждал бы
 * следующей почти полные сутки. Здесь каждый тикет со своим сроком.
 *
 * Сбой базы — молчим: лишний пинг каждые пятнадцать минут про один и тот же
 * тикет приучил бы не читать их вовсе.
 */
export async function claimTicketPing(ticketId: number, hours: number): Promise<boolean> {
  try {
    const first = await redis.set(`support:ticketping:${ticketId}`, Date.now(), {
      nx: true,
      ex: Math.max(60, Math.round(hours * 3600)),
    });
    return first !== null;
  } catch (err) {
    console.error('[support] ticket ping claim failed:', err);
    return false;
  }
}

/** Пометить тикет недоставляемым, когда об этом сказал Telegram. */
export async function markBlocked(ticketId: number): Promise<Ticket | null> {
  const t = await getTicket(ticketId);
  if (!t || t.blocked) return t;
  t.blocked = true;
  await saveTicket(t);
  return t;
}

/** Один дайджест на `hours` часов, а не на каждый проход крона. */
export async function claimStaleDigest(hours: number): Promise<boolean> {
  try {
    const first = await redis.set('support:staledigest', Date.now(), {
      nx: true,
      ex: Math.max(1, Math.round(hours * 3600)),
    });
    return first !== null;
  } catch (err) {
    // Сбой базы — молчим: лишний дайджест раз в пятнадцать минут приучил бы
    // не читать его вовсе, а это единственное напоминание, которое у нас есть.
    console.error('[support] digest claim failed:', err);
    return false;
  }
}

// ─── недоставленные ответы оператора ───────────────────────

/** Сколько недоставленных ответов помним на тикет. */
const PENDING_OPERATOR_CAP = 5;

/**
 * Ответ оператора не доехал (человек заблокировал бота) — запомнить и пометить.
 *
 * Раньше такой ответ терялся совсем: оператор видел «⚠️ Не доставлено» и шёл
 * дальше, а человек оставался с тишиной и был уверен, что ему не ответили.
 */
export async function noteUndelivered(
  ticketId: number,
  chatId: number,
  messageId: number,
): Promise<Ticket | null> {
  const t = await getTicket(ticketId);
  if (!t) return null;
  const queue = [...(t.pendingOperator ?? []), { chatId, messageId, at: Date.now() }];
  t.pendingOperator = queue.slice(-PENDING_OPERATOR_CAP);
  t.blocked = true;
  await saveTicket(t);
  return t;
}

/**
 * Забрать накопленные недоставленные ответы и снять признак блокировки.
 *
 * Забираем ДО отправки: повторная доставка одного и того же ответа выглядит
 * как второй ответ на тот же вопрос, а потеря при сбое возвращает нас к
 * прежнему поведению, которое мы и так считаем терпимым.
 */
export async function takeUndelivered(
  ticketId: number,
): Promise<{ chatId: number; messageId: number; at: number }[]> {
  const t = await getTicket(ticketId);
  if (!t) return [];
  const queue = t.pendingOperator ?? [];
  if (queue.length === 0 && !t.blocked) return [];
  t.pendingOperator = undefined;
  t.blocked = false;
  await saveTicket(t);
  return queue;
}
