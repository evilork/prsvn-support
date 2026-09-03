// lib/config.ts

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function parseAdminIds(): number[] {
  const raw = process.env.SUPPORT_ADMIN_USER_IDS || '';
  return raw
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/**
 * Группа с темами, куда бот выносит тикеты.
 *
 * Пусто — прежний режим: всё в личке оператора, ответ через Reply. Задано —
 * каждый тикет получает свою тему в этой группе, оператор пишет в тему как в
 * обычный чат, бот относит написанное клиенту. Идентификатор группы бот сам
 * подсказывает командой /id, когда его туда добавили.
 */
function parseGroupId(): number | null {
  const raw = (process.env.SUPPORT_GROUP_ID || '').trim();
  return /^-?\d+$/.test(raw) ? Number(raw) : null;
}

const groupId = parseGroupId();

export const config = {
  botToken: required('SUPPORT_BOT_TOKEN'),
  webhookSecret: required('SUPPORT_BOT_WEBHOOK_SECRET'),
  adminUserIds: parseAdminIds(),
  groupId,
  forumMode: groupId !== null,

  rateLimitPerMinute: 10,
  pageSize: 10,
  ticketDataTtlSec: 60 * 60 * 24 * 180,

  siteUrl: process.env.SITE_URL || 'https://proxysvpn.com',
  dashboardUrl: process.env.DASHBOARD_URL || 'https://proxysvpn.com/dashboard',
  guideUrl: process.env.GUIDE_URL || 'https://proxysvpn.com/guide',
  mainBotUrl: process.env.MAIN_BOT_URL || 'https://t.me/proxysvpn_bot',
} as const;

export function isAdmin(userId: number): boolean {
  return config.adminUserIds.includes(userId);
}
