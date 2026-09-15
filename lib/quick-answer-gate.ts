// lib/quick-answer-gate.ts
//
// What the Mini App decision reads, cached per instance: the members of
// `support:miniapp:users`, and whether a Telegram user reaches an account on
// the site.
//
// The decision is pure and lives in lib/quick-answer.ts; this module only
// fetches what it decides on. Two constraints shape it.
//
// Latency. The FAQ menu is drawn on /start, /menu and every section tap. One
// SMEMBERS per instance per TTL, shared by updates that arrive while it is in
// flight, is the whole cost of the set; every other update reads module
// memory. The account lookup is asked only when `*` alone would open the Mini
// App, and is cached per person the same way.
//
// Failure. A read that errors, times out or returns something unexpected
// counts as "closed": an empty set, no account. Everyone but the owner gets the
// in-chat callback, and the menu itself is never at risk. That verdict is
// cached for the same TTL, so an outage costs one log line and one bounded read
// per instance (per person, for the account) per TTL, not one per update.
// Serving the last good read instead would keep a set open that may already
// have been rolled back with SREM.
//
// No lib/config.ts import: config throws without the bot's secrets, and the
// caches have to be unit-tested. The factories take the reader and the clock;
// `quickAnswerGate` and `quickAnswerAccountCheck` below are the bot's instances.

import { Redis } from '@upstash/redis';
import {
  QUICK_ANSWER_WEBAPP_USERS_KEY,
  quickAnswerWebAppMember,
  summarizeQuickAnswerWebAppMembers,
} from './quick-answer';

/**
 * How long one read is trusted, ms.
 *
 * SADD and SREM reach the bot within a minute on every warm instance, and a
 * cold instance reads the set on its first menu anyway. The same for an
 * account created or linked on the site.
 */
export const QUICK_ANSWER_GATE_TTL_MS = 60_000;

/**
 * How long a menu waits for Redis, ms.
 *
 * Upstash answers in tens of milliseconds; a read hanging past this is an
 * outage, and the person gets the in-chat callback instead of waiting for it.
 */
export const QUICK_ANSWER_GATE_READ_TIMEOUT_MS = 1_500;

/**
 * How many people's account verdicts one instance keeps.
 *
 * A bound, not a tuning knob: a burst of distinct people cannot grow the map
 * past it, the oldest verdict is dropped first, and a dropped one is simply
 * read again. At a few dozen bytes an entry this is well under a megabyte.
 */
export const QUICK_ANSWER_ACCOUNT_CACHE_MAX = 5_000;

/** `redis`: the set was read. `unavailable`: it was not, and counts as empty. */
export type QuickAnswerGateSource = 'redis' | 'unavailable';

export interface QuickAnswerGateSnapshot {
  /** The set's members as read — frozen, empty when `source` is `unavailable`. */
  readonly members: readonly unknown[];
  readonly source: QuickAnswerGateSource;
  /** When the read finished, by the gate's clock, ms. */
  readonly loadedAt: number;
}

/** What both caches take besides their reader. */
export interface QuickAnswerCacheOptions {
  /** Clock in ms. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Defaults to `QUICK_ANSWER_GATE_TTL_MS`. */
  readonly ttlMs?: number;
  /** Defaults to `QUICK_ANSWER_GATE_READ_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /** Defaults to `console.error`. */
  readonly logError?: (message: string, err: unknown) => void;
}

export interface QuickAnswerGateOptions extends QuickAnswerCacheOptions {
  /** Returns the set's members. May reject or throw; both fail closed. */
  readonly read: () => Promise<unknown>;
}

export interface QuickAnswerGate {
  readonly ttlMs: number;
  /** The current snapshot, reading the set at most once per TTL. Never rejects. */
  load(): Promise<QuickAnswerGateSnapshot>;
}

export interface QuickAnswerAccountCheckOptions extends QuickAnswerCacheOptions {
  /**
   * Whether this Telegram user reaches an account on the site. Must resolve
   * `true` or `false`; anything else, a rejection or a throw fails closed.
   */
  readonly read: (userId: number) => Promise<unknown>;
  /** Defaults to `QUICK_ANSWER_ACCOUNT_CACHE_MAX`. */
  readonly maxEntries?: number;
}

export interface QuickAnswerAccountCheck {
  readonly ttlMs: number;
  /**
   * Whether this Telegram user has an account on the site, reading Redis at
   * most once per person per TTL. Never rejects; false when it is not known.
   */
  has(userId: number): Promise<boolean>;
}

const NO_MEMBERS: readonly unknown[] = Object.freeze([]);

interface SettledOptions {
  readonly now: () => number;
  readonly ttlMs: number;
  readonly timeoutMs: number;
  readonly logError: (message: string, err: unknown) => void;
}

function positiveInteger(factory: string, name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${factory}: ${name} must be a positive integer, got ${String(value)}`);
  }
  return value;
}

function defaultLogError(message: string, err: unknown): void {
  console.error(message, err);
}

/** Validates what both factories share; throws on a programming error. */
function settleOptions(factory: string, options: QuickAnswerCacheOptions & { readonly read?: unknown }): SettledOptions {
  if (options === null || typeof options !== 'object' || typeof options.read !== 'function') {
    throw new TypeError(`${factory}: read must be a function`);
  }
  const now = options.now ?? Date.now;
  if (typeof now !== 'function') throw new TypeError(`${factory}: now must be a function`);
  const logError = options.logError ?? defaultLogError;
  if (typeof logError !== 'function') throw new TypeError(`${factory}: logError must be a function`);
  return {
    now,
    logError,
    ttlMs: positiveInteger(factory, 'ttlMs', options.ttlMs, QUICK_ANSWER_GATE_TTL_MS),
    timeoutMs: positiveInteger(factory, 'timeoutMs', options.timeoutMs, QUICK_ANSWER_GATE_READ_TIMEOUT_MS),
  };
}

/** A logger that throws must not cost the person their menu. */
function safeLog(logError: SettledOptions['logError'], message: string, err: unknown): void {
  try {
    logError(message, err);
  } catch {
    // Nothing left to report it to.
  }
}

/** The reader's result as a promise, whether it rejects or throws synchronously. */
function callRead(read: () => Promise<unknown>): Promise<unknown> {
  try {
    return Promise.resolve(read());
  } catch (err) {
    return Promise.reject(err);
  }
}

function withTimeout<T>(pending: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms);
    pending.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** A clock that went backwards expires an entry rather than freezing it. */
function isFresh(loadedAt: number, at: number, ttlMs: number): boolean {
  const age = at - loadedAt;
  return age >= 0 && age < ttlMs;
}

export function createQuickAnswerGate(options: QuickAnswerGateOptions): QuickAnswerGate {
  const { now, ttlMs, timeoutMs, logError } = settleOptions('createQuickAnswerGate', options);
  const read = options.read;

  let cached: QuickAnswerGateSnapshot | null = null;
  let inflight: Promise<QuickAnswerGateSnapshot> | null = null;

  /** Resolves with the new snapshot in every case; nothing in here may reject. */
  async function refresh(): Promise<QuickAnswerGateSnapshot> {
    let members: readonly unknown[] = NO_MEMBERS;
    let source: QuickAnswerGateSource = 'unavailable';
    try {
      const raw = await withTimeout(callRead(read), timeoutMs);
      if (!Array.isArray(raw)) throw new TypeError(`SMEMBERS returned ${describeValue(raw)}, not a list`);
      members = Object.freeze([...raw]);
      source = 'redis';
    } catch (err) {
      safeLog(
        logError,
        `[support][quick-answer] ${QUICK_ANSWER_WEBAPP_USERS_KEY} read failed; the Mini App stays closed to all but the owner for ${ttlMs} ms:`,
        err,
      );
    }
    const snapshot: QuickAnswerGateSnapshot = Object.freeze({ members, source, loadedAt: now() });
    cached = snapshot;
    return snapshot;
  }

  return Object.freeze({
    ttlMs,
    load(): Promise<QuickAnswerGateSnapshot> {
      if (cached !== null && isFresh(cached.loadedAt, now(), ttlMs)) return Promise.resolve(cached);
      if (inflight === null) {
        inflight = refresh().finally(() => {
          inflight = null;
        });
      }
      return inflight;
    },
  });
}

interface AccountVerdict {
  readonly found: boolean;
  readonly loadedAt: number;
}

/**
 * The per-person twin of `createQuickAnswerGate`: a Map with a TTL and a size
 * bound, one shared read per person while it is in flight. O(1) amortized per
 * call; memory O(maxEntries).
 *
 * Log lines carry no Telegram id, the same rule as the site's support routes.
 */
export function createQuickAnswerAccountCheck(options: QuickAnswerAccountCheckOptions): QuickAnswerAccountCheck {
  const factory = 'createQuickAnswerAccountCheck';
  const { now, ttlMs, timeoutMs, logError } = settleOptions(factory, options);
  const maxEntries = positiveInteger(factory, 'maxEntries', options.maxEntries, QUICK_ANSWER_ACCOUNT_CACHE_MAX);
  const read = options.read;

  // Insertion order is age order: `remember` re-inserts, eviction takes the first key.
  const verdicts = new Map<number, AccountVerdict>();
  const inflight = new Map<number, Promise<boolean>>();

  function remember(userId: number, found: boolean): void {
    verdicts.delete(userId);
    verdicts.set(userId, Object.freeze({ found, loadedAt: now() }));
    while (verdicts.size > maxEntries) {
      const oldest = verdicts.keys().next();
      if (oldest.done === true) break;
      verdicts.delete(oldest.value);
    }
  }

  /** Resolves in every case; nothing in here may reject. */
  async function lookup(userId: number): Promise<boolean> {
    let found = false;
    try {
      const raw = await withTimeout(
        callRead(() => read(userId)),
        timeoutMs,
      );
      if (typeof raw !== 'boolean') throw new TypeError(`account lookup returned ${describeValue(raw)}, not a boolean`);
      found = raw;
    } catch (err) {
      safeLog(
        logError,
        `[support][quick-answer] site account lookup failed; "*" does not open the Mini App to this person for ${ttlMs} ms:`,
        err,
      );
    }
    remember(userId, found);
    return found;
  }

  return Object.freeze({
    ttlMs,
    has(userId: number): Promise<boolean> {
      if (!Number.isSafeInteger(userId) || userId <= 0) return Promise.resolve(false);

      const known = verdicts.get(userId);
      if (known !== undefined) {
        if (isFresh(known.loadedAt, now(), ttlMs)) return Promise.resolve(known.found);
        verdicts.delete(userId);
      }

      const pending = inflight.get(userId);
      if (pending !== undefined) return pending;
      const started = lookup(userId).finally(() => {
        inflight.delete(userId);
      });
      inflight.set(userId, started);
      return started;
    },
  });
}

/**
 * The account id a Telegram user signs in to on the site.
 *
 * `alias:tg_<id>` names the primary account when that Telegram was merged into
 * an email one; without an alias the account id is `tg_<id>` itself. The same
 * rule as `resolveUserId` on the site and `resolveAccountId` in lib/account.ts.
 */
export function siteAccountIdFor(telegramAccountId: string, alias: unknown): string {
  return typeof alias === 'string' && alias ? alias : telegramAccountId;
}

/** What the webhook probe shows about the gate: counts, never member ids. */
export interface QuickAnswerGateReport {
  /** The Redis key the gate reads. */
  readonly key: string;
  /** `unavailable`: the read failed and everyone but the owner gets the callback. */
  readonly source: QuickAnswerGateSource;
  /** `*` is in the set. */
  readonly everyone: boolean;
  /** Well-formed `tg_<id>` members. */
  readonly membersCount: number;
  /** Members that open nothing: a bare id, a typo, a non-string. */
  readonly ignoredMembers: number;
  /** How old the snapshot is, ms; never negative. */
  readonly ageMs: number;
  readonly ttlMs: number;
}

export function describeQuickAnswerGate(
  snapshot: QuickAnswerGateSnapshot,
  at: number,
  ttlMs: number,
): QuickAnswerGateReport {
  const summary = summarizeQuickAnswerWebAppMembers(snapshot.members);
  const age = at - snapshot.loadedAt;
  return {
    key: QUICK_ANSWER_WEBAPP_USERS_KEY,
    source: snapshot.source,
    everyone: summary.everyone,
    membersCount: summary.users,
    ignoredMembers: summary.ignored,
    ageMs: Number.isFinite(age) && age > 0 ? age : 0,
    ttlMs,
  };
}

const redis = Redis.fromEnv();

/** The bot's gate: the site's set, read through Upstash. */
export const quickAnswerGate: QuickAnswerGate = createQuickAnswerGate({
  read: () => redis.smembers(QUICK_ANSWER_WEBAPP_USERS_KEY),
});

/**
 * Whether `account:<id>` exists for the account this Telegram signs in to —
 * what /api/internal/support-ai on the site calls `accountFound`.
 *
 * One pipelined request answers a Telegram-first account or no account at all;
 * a second is made only when an alias points at another account.
 */
async function readSiteAccountExists(userId: number): Promise<boolean> {
  const telegramAccountId = quickAnswerWebAppMember(userId);
  if (telegramAccountId === null) return false;
  const [alias, ownAccount] = await redis
    .pipeline()
    .get<string>(`alias:${telegramAccountId}`)
    .exists(`account:${telegramAccountId}`)
    .exec();
  const accountId = siteAccountIdFor(telegramAccountId, alias);
  if (accountId === telegramAccountId) return ownAccount === 1;
  return (await redis.exists(`account:${accountId}`)) === 1;
}

/** The bot's account check, read through Upstash. */
export const quickAnswerAccountCheck: QuickAnswerAccountCheck = createQuickAnswerAccountCheck({
  read: readSiteAccountExists,
});
