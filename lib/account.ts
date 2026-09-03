// lib/account.ts
//
// Что оператор видит о клиенте, не задавая вопросов.
//
// Бот поддержки живёт в той же базе, что и кабинет с основным ботом, поэтому
// баланс, устройства, платежи и следы обращений за подпиской доступны ему
// напрямую. До этого оператор спрашивал у человека почту, шёл в админ-панель
// основного бота и искал вручную — на каждый тикет.
//
// Здесь только чтение. Формула остатка скопирована из
// `frontend/src/lib/balance-math.ts` (там она единственная и правильная);
// менять её там — менять и здесь.

import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

const DEVICE_MONTHLY_COST = 100;
const DEVICE_DAILY_COST = DEVICE_MONTHLY_COST / 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_SUB_MS = 24 * 60 * 60 * 1000;
const ADDRESS_CHANGE_WINDOW_MS = 48 * 60 * 60 * 1000;

interface AccountRecord {
  paidUntil?: number;
  createdAt?: number;
  balance?: number;
  balanceUpdatedAt?: number;
}

interface ProfileRecord {
  uuid: string;
  createdAt?: number;
  deviceType?: string;
  name?: string;
  plan?: string;
  proUntil?: number;
  proAutoRenew?: boolean;
}

interface UserRecord {
  email?: string;
  authMethod?: string;
  telegramId?: string | number;
}

interface PaymentRecord {
  amountRub: number;
  provider: string;
  paidAt: number;
  bonus?: number;
}

interface InboundEntry {
  label?: string;
  address?: string;
  port?: number;
  enabled?: boolean;
  protocol?: string;
}

export interface DeviceInfo {
  name: string;
  type: string;
  pro: boolean;
  proUntil: number;
  autoRenew: boolean;
  app: string | null;
  lastFetchAt: number | null;
}

export interface AccountPanel {
  found: boolean;
  accountId: string;
  email?: string;
  balance: number;
  dailyRate: number;
  daysRemaining: number | null;
  paidUntil: number;
  devices: DeviceInfo[];
  proCount: number;
  payments: PaymentRecord[];
  /** Вердикты в порядке важности: первый — главный. */
  verdicts: string[];
}

function parse<T>(raw: unknown): T | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
  return raw as T;
}

function isProPaid(p: ProfileRecord, now: number): boolean {
  return p.plan === 'pro' && (Number(p.proUntil) || 0) > now;
}

function billableDeviceDays(profiles: ProfileRecord[], since: number, now: number): number {
  let days = 0;
  for (const p of profiles) {
    if (isProPaid(p, now)) continue;
    const proEnded = Number(p.proUntil) || 0;
    let from = since;
    if (proEnded > from && proEnded < now) from = proEnded;
    const born = Number(p.createdAt) || 0;
    if (born > from) from = born;
    if (from < now) days += (now - from) / DAY_MS;
  }
  return days;
}

function computeBalance(account: AccountRecord, profiles: ProfileRecord[], now: number): number {
  if (!account.balance || account.balance <= 0) return 0;
  const since = account.balanceUpdatedAt || account.createdAt || now;
  const consumed = billableDeviceDays(profiles, since, now) * DEVICE_DAILY_COST;
  if (consumed <= 0) return account.balance;
  return Math.max(0, Math.round((account.balance - consumed) * 100) / 100);
}

const DEVICE_NAMES: Record<string, string> = {
  android: 'Android',
  iphone: 'iPhone',
  iphone_ru: 'iPhone',
  mac: 'Mac',
  mac_ru: 'Mac',
  windows: 'Windows',
  linux: 'Linux',
  tv: 'Телевизор',
};

/** Имя устройства так же, как в кабинете: своё имя или тип с номером. */
function deviceName(profiles: ProfileRecord[], index: number): string {
  const p = profiles[index];
  if (p.name) return p.name;
  const base = DEVICE_NAMES[p.deviceType || ''] || 'Устройство';
  const auto = profiles.filter((x) => !x.name);
  const same = auto.filter((x) => (DEVICE_NAMES[x.deviceType || ''] || 'Устройство') === base);
  if (same.length <= 1) return base;
  const seq = auto.slice(0, auto.indexOf(p)).filter((x) => (DEVICE_NAMES[x.deviceType || ''] || 'Устройство') === base).length + 1;
  return `${base} ${seq}`;
}

/**
 * «Happ/2.8.0/Windows/2604081205607» → «Happ 2.8.0 Windows».
 *
 * Первое слово заголовка — приложение, версия и платформа через косую черту;
 * номер сборки и хвост про движок никому не нужны.
 */
export function shortApp(ua: string | null | undefined): string | null {
  if (!ua) return null;
  const head = ua.trim().split(/\s+/)[0] || '';
  const parts = head.split('/').filter(Boolean);
  if (parts.length === 0) return ua.slice(0, 30);
  const name = parts[0].replace(/Next$/i, '');
  const version = parts[1] && /^\d/.test(parts[1]) ? parts[1] : '';
  let os = parts[2] || '';
  if (/^\d+$/.test(os)) os = '';
  const m = ua.match(/\((android|ios|windows|macos|linux)\)/i);
  if (!os && m) os = m[1];
  return [name, version, os.replace(/^ios$/i, 'iOS')].filter(Boolean).join(' ');
}

const PANEL_HUMAN: Record<string, string> = {
  de: 'Германия',
  nl2: 'Амстердам',
  uk: 'Британия',
  lon: 'Британия',
  us: 'США',
  fr: 'Франция',
};

async function resolveAccountId(tgId: number): Promise<string> {
  const candidate = `tg_${tgId}`;
  const aliased = await redis.get<string>(`alias:${candidate}`).catch(() => null);
  return typeof aliased === 'string' && aliased ? aliased : candidate;
}

export async function loadAccountPanel(tgId: number): Promise<AccountPanel> {
  return loadAccountPanelById(await resolveAccountId(tgId));
}

export async function loadAccountPanelById(accountId: string): Promise<AccountPanel> {
  const now = Date.now();
  const empty: AccountPanel = {
    found: false,
    accountId,
    balance: 0,
    dailyRate: 0,
    daysRemaining: null,
    paidUntil: 0,
    devices: [],
    proCount: 0,
    payments: [],
    verdicts: [],
  };

  const [accountRaw, profilesRaw, userRaw, desyncRaw, quotaRaw, changeRaw, paymentsRaw] =
    await Promise.all([
      redis.get(`account:${accountId}`),
      redis.get(`profiles:${accountId}`),
      redis.get(`user:${accountId}`),
      redis.get(`desync:${accountId}`),
      redis.get(`usquota:${accountId}`),
      redis.get('registry:last_change'),
      redis.zrange(`payhist:${accountId}`, 0, 2, { rev: true }).catch(() => [] as unknown[]),
    ]);

  const account = parse<AccountRecord>(accountRaw);
  if (!account) return empty;
  const profiles = (parse<ProfileRecord[]>(profilesRaw) ?? []).filter((p) => p && p.uuid);
  const user = parse<UserRecord>(userRaw);

  const [seenRaw, uaRaw] = profiles.length
    ? await Promise.all([
        redis.mget<(number | string | null)[]>(...profiles.map((p) => `sub_seen:${p.uuid}`)).catch(() => []),
        redis.mget<(string | null)[]>(...profiles.map((p) => `sub_ua:${p.uuid}`)).catch(() => []),
      ])
    : [[], []];

  const devices: DeviceInfo[] = profiles.map((p, i) => {
    const seen = Number(seenRaw?.[i]);
    return {
      name: deviceName(profiles, i),
      type: p.deviceType || '',
      pro: isProPaid(p, now),
      proUntil: Number(p.proUntil) || 0,
      autoRenew: p.proAutoRenew !== false,
      app: shortApp(typeof uaRaw?.[i] === 'string' ? uaRaw[i] : null),
      lastFetchAt: Number.isFinite(seen) && seen > 0 ? seen : null,
    };
  });

  const balance = computeBalance(account, profiles, now);
  const billable = profiles.filter((p) => !isProPaid(p, now)).length;
  const dailyRate = Math.round(billable * DEVICE_DAILY_COST * 100) / 100;
  const daysRemaining = dailyRate > 0 ? Math.floor(balance / dailyRate) : null;
  const proCount = devices.filter((d) => d.pro).length;
  const allPrepaid = profiles.length > 0 && proCount === profiles.length;

  const payments = ((paymentsRaw as unknown[]) || [])
    .map((r) => parse<PaymentRecord>(r))
    .filter((r): r is PaymentRecord => !!r && typeof r.amountRub === 'number');

  // ── вердикты: одна главная причина, как в самодиагностике кабинета ──
  const verdicts: string[] = [];

  if (profiles.length === 0) {
    verdicts.push('❌ Устройств нет — подписки у человека ещё нет');
  }
  if (profiles.length > 0 && balance <= 0 && !allPrepaid) {
    verdicts.push('❌ Нет средств: базовые устройства получают заглушку «Пополните баланс»');
  } else if (!allPrepaid && (account.paidUntil || 0) > 0 && (account.paidUntil || 0) < now) {
    verdicts.push('❌ Срок подписки истёк');
  }

  const desync = parse<{ failed?: { panel?: string }[] }>(desyncRaw);
  const missing = [...new Set((desync?.failed || []).map((f) => f.panel).filter(Boolean) as string[])];
  if (missing.length > 0) {
    verdicts.push(`⚠️ Не заведён на серверах: ${missing.map((m) => PANEL_HUMAN[m] || m).join(', ')} — кнопка «Починить» в кабинете или боте`);
  }

  const lastFetch = devices.reduce<number | null>(
    (acc, d) => (d.lastFetchAt && (!acc || d.lastFetchAt > acc) ? d.lastFetchAt : acc),
    null,
  );
  const change = parse<{ at?: number; label?: string }>(changeRaw);
  if (change?.at && profiles.length > 0) {
    if (lastFetch !== null && lastFetch < change.at) {
      verdicts.push(`⚠️ Адрес сервера менялся${change.label ? ` (${change.label})` : ''}, а приложение подписку с тех пор не забирало — в клиенте старый список`);
    } else if (now - change.at < ADDRESS_CHANGE_WINDOW_MS) {
      verdicts.push(`ℹ️ Адрес сервера менялся ${Math.round((now - change.at) / 3600000)} ч назад${change.label ? ` (${change.label})` : ''}`);
    }
  }
  if (profiles.length > 0 && lastFetch !== null && now - lastFetch > STALE_SUB_MS) {
    verdicts.push(`⚠️ Подписку не обновляли ${Math.round((now - lastFetch) / 3600000)} ч`);
  }

  // Узлы, которые мониторинг считает недоступными из России.
  try {
    const [regRaw, proRegRaw] = await Promise.all([
      redis.get('inbounds:registry'),
      proCount > 0 ? redis.get('inbounds:registry:pro') : Promise.resolve(null),
    ]);
    const entries = [...(parse<InboundEntry[]>(regRaw) ?? []), ...(parse<InboundEntry[]>(proRegRaw) ?? [])]
      .filter((e) => e && e.enabled !== false && e.address);
    if (entries.length > 0) {
      const states = await redis.mget<(string | null)[]>(
        ...entries.map((e) => `nodehealth:${e.address}:${e.port ?? 443}`),
      );
      const down = entries.filter((_, i) => states?.[i] === 'down').map((e) => e.label || e.address!);
      if (down.length > 0) verdicts.push(`🔴 Сейчас недоступны из России: ${down.join(', ')}`);
    }
  } catch {
    // Мониторинг не прочитался — не выдумываем.
  }

  const quota = parse<{ blocked?: boolean; periodStart?: number }>(quotaRaw);
  if (quota?.blocked) {
    const reset = new Date((Number(quota.periodStart) || 0) + 30 * DAY_MS);
    verdicts.push(`🇺🇸 Лимит США исчерпан, сброс ${fmtDate(reset.getTime())}`);
  }

  if (verdicts.length === 0) verdicts.push('✅ С нашей стороны всё в порядке');

  return {
    found: true,
    accountId,
    email: user?.email,
    balance,
    dailyRate,
    daysRemaining,
    paidUntil: Number(account.paidUntil) || 0,
    devices,
    proCount,
    payments,
    verdicts,
  };
}

// ─── отрисовка ─────────────────────────────────────────────

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function fmtDate(ts: number): string {
  const local = new Date(ts + 3 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(local.getUTCDate())}.${pad(local.getUTCMonth() + 1)} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
}

export function fmtAgo(ts: number, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - ts) / 60000));
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} ч назад`;
  return `${Math.round(h / 24)} дн назад`;
}

const PROVIDER_SHORT: Record<string, string> = {
  cashera: 'Cashera',
  yookassa: 'ЮKassa',
  enot: 'Enot',
  cryptobot: 'CryptoBot',
  crypto: 'крипта',
  lava: 'lava.top',
  admin: 'вручную',
};

/** Блок об аккаунте для карточки тикета. HTML для Telegram. */
export function renderAccountPanel(p: AccountPanel, now = Date.now()): string {
  if (!p.found) {
    return `💳 Аккаунт <code>${escapeHtml(p.accountId)}</code> не найден — человек ещё не заходил в основной бот или кабинет`;
  }
  const lines: string[] = [];
  const who = p.email ? ` · ${escapeHtml(p.email)}` : '';
  const lasts = p.daysRemaining === null ? '' : ` · хватит на ${p.daysRemaining} дн`;
  lines.push(
    `💳 Баланс <b>${p.balance.toFixed(2)} ₽</b>${p.dailyRate ? ` · ${p.dailyRate} ₽/день` : ''}${lasts}${who}`,
  );
  if (p.devices.length === 0) {
    lines.push('📱 Устройств нет');
  } else {
    for (const d of p.devices.slice(0, 6)) {
      const plan = d.pro
        ? `PRO до ${fmtDate(d.proUntil).slice(0, 5)}${d.autoRenew ? '' : ' (автопродление выкл)'}`
        : 'базовый';
      const app = d.app ? escapeHtml(d.app) : 'приложение неизвестно';
      const fetched = d.lastFetchAt ? `подписку забирал ${fmtAgo(d.lastFetchAt, now)}` : 'подписку ещё не забирал';
      lines.push(`📱 <b>${escapeHtml(d.name)}</b> · ${plan} · ${app} · ${fetched}`);
    }
    if (p.devices.length > 6) lines.push(`📱 …и ещё ${p.devices.length - 6}`);
  }
  if (p.payments.length > 0) {
    lines.push(
      `💸 ${p.payments
        .map((x) => `${fmtDate(x.paidAt).slice(0, 5)} ${x.amountRub} ₽ ${PROVIDER_SHORT[x.provider] || x.provider}`)
        .join(' · ')}`,
    );
  } else {
    lines.push('💸 Платежей в журнале нет (журнал с середины августа)');
  }
  lines.push('');
  lines.push(...p.verdicts.map((v) => escapeHtml(v).replace(/«Починить»/g, '«Починить»')));
  return lines.join('\n');
}
