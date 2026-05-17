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

export const config = {
  botToken: required('SUPPORT_BOT_TOKEN'),
  webhookSecret: required('SUPPORT_BOT_WEBHOOK_SECRET'),
  adminUserIds: parseAdminIds(),

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
