// lib/quick-answer-gate.ts
//
// The Mini App allowlist as the bot reads it: the members of
// `support:miniapp:users`, cached per instance.
//
// The decision is pure and lives in lib/quick-answer.ts; this module only
// fetches what it decides on. Two constraints shape it.
//
// Latency. The FAQ menu is drawn on /start, /menu and every section tap. One
// SMEMBERS per instance per TTL, shared by updates that arrive while it is in
// flight, is the whole cost; every other update reads module memory.
//
// Failure. A read that errors, times out or returns something other than a
// list counts as an empty set: everyone but the owner gets the in-chat
// callback, and the menu itself is never at risk. That verdict is cached for
// the same TTL, so an outage costs one log line and one bounded read per
// instance per TTL, not one per update. Serving the last good read instead
// would keep a set open that may already have been rolled back with SREM.
//
// No lib/config.ts import: config throws without the bot's secrets, and the
// cache has to be unit-tested. `createQuickAnswerGate` takes the reader and the
// clock; `quickAnswerGate` below is the instance the bot uses.

import { Redis } from '@upstash/redis';
import { QUICK_ANSWER_WEBAPP_USERS_KEY } from './quick-answer';

/**
 * How long one read of the set is trusted, ms.
 *
 * SADD and SREM reach the bot within a minute on every warm instance, and a
 * cold instance reads the set on its first menu anyway.
 */
export const QUICK_ANSWER_GATE_TTL_MS = 60_000;

/**
 * How long a menu waits for the set, ms.
 *
 * Upstash answers in tens of milliseconds; a read hanging past this is an
 * outage, and the person gets the in-chat callback instead of waiting for it.
 */
export const QUICK_ANSWER_GATE_READ_TIMEOUT_MS = 1_500;

/** `redis`: the set was read. `unavailable`: it was not, and counts as empty. */
export type QuickAnswerGateSource = 'redis' | 'unavailable';

export interface QuickAnswerGateSnapshot {
  /** The set's members as read — frozen, empty when `source` is `unavailable`. */
  readonly members: readonly unknown[];
  readonly source: QuickAnswerGateSource;
  /** When the read finished, by the gate's clock, ms. */
  readonly loadedAt: number;
}

export interface QuickAnswerGateOptions {
  /** Returns the set's members. May reject or throw; both fail closed. */
  readonly read: () => Promise<unknown>;
  /** Clock in ms. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Defaults to `QUICK_ANSWER_GATE_TTL_MS`. */
  readonly ttlMs?: number;
  /** Defaults to `QUICK_ANSWER_GATE_READ_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /** Defaults to `console.error`. */
  readonly logError?: (message: string, err: unknown) => void;
}

export interface QuickAnswerGate {
  readonly ttlMs: number;
  /** The current snapshot, reading the set at most once per TTL. Never rejects. */
  load(): Promise<QuickAnswerGateSnapshot>;
}

const NO_MEMBERS: readonly unknown[] = Object.freeze([]);

function positiveMs(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`createQuickAnswerGate: ${name} must be a positive integer of ms, got ${String(value)}`);
  }
  return value;
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

function defaultLogError(message: string, err: unknown): void {
  console.error(message, err);
}

export function createQuickAnswerGate(options: QuickAnswerGateOptions): QuickAnswerGate {
  if (options === null || typeof options !== 'object' || typeof options.read !== 'function') {
    throw new TypeError('createQuickAnswerGate: read must be a function');
  }
  const now = options.now ?? Date.now;
  if (typeof now !== 'function') throw new TypeError('createQuickAnswerGate: now must be a function');
  const logError = options.logError ?? defaultLogError;
  if (typeof logError !== 'function') throw new TypeError('createQuickAnswerGate: logError must be a function');
  const ttlMs = positiveMs('ttlMs', options.ttlMs, QUICK_ANSWER_GATE_TTL_MS);
  const timeoutMs = positiveMs('timeoutMs', options.timeoutMs, QUICK_ANSWER_GATE_READ_TIMEOUT_MS);
  const read = options.read;

  let cached: QuickAnswerGateSnapshot | null = null;
  let inflight: Promise<QuickAnswerGateSnapshot> | null = null;

  /** A clock that went backwards expires the cache rather than freezing it. */
  const isFresh = (snapshot: QuickAnswerGateSnapshot, at: number): boolean => {
    const age = at - snapshot.loadedAt;
    return age >= 0 && age < ttlMs;
  };

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
      try {
        logError(
          `[support][quick-answer] ${QUICK_ANSWER_WEBAPP_USERS_KEY} read failed; the Mini App stays closed to all but the owner for ${ttlMs} ms:`,
          err,
        );
      } catch {
        // A logger that throws must not cost the person their menu.
      }
    }
    const snapshot: QuickAnswerGateSnapshot = Object.freeze({ members, source, loadedAt: now() });
    cached = snapshot;
    return snapshot;
  }

  return Object.freeze({
    ttlMs,
    load(): Promise<QuickAnswerGateSnapshot> {
      if (cached !== null && isFresh(cached, now())) return Promise.resolve(cached);
      if (inflight === null) {
        inflight = refresh().finally(() => {
          inflight = null;
        });
      }
      return inflight;
    },
  });
}

const redis = Redis.fromEnv();

/** The bot's gate: the site's set, read through Upstash. */
export const quickAnswerGate: QuickAnswerGate = createQuickAnswerGate({
  read: () => redis.smembers(QUICK_ANSWER_WEBAPP_USERS_KEY),
});
