// app/api/webhook/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { askProxysAi } from '@/lib/ai';
import { handleUpdate } from '@/lib/handler';
import { OWNER_USER_ID } from '@/lib/owner';
import { quickAnswerWebAppUrl } from '@/lib/quick-answer';
import { describeQuickAnswerGate, quickAnswerGate } from '@/lib/quick-answer-gate';
import type { Update } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Массовое закрытие тихих тикетов делает по два обращения к базе на тикет.
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-telegram-bot-api-secret-token');
  if (secret !== config.webhookSecret) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  let update: Update;
  try {
    update = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  try {
    await handleUpdate(update);
  } catch (err) {
    console.error('[support] handler error:', err);
  }

  return NextResponse.json({ ok: true });
}

/**
 * Проверка живости, а под секретом вебхука — ещё и состояние окружения.
 *
 * Появилось 08.09.2026 после часа вслепую: переменная `INTERNAL_API_KEY` была
 * заведена в панели, кнопка «Быстрый ответ» не появлялась, и отличить «не
 * положили в тот проект» от «положили не в то окружение» и от «не совпал
 * идентификатор» было нечем — журналы функции снаружи не читаются, а
 * единственный признак поломки это ОТСУТСТВИЕ кнопки, то есть ничего.
 *
 * Значений секретов здесь нет и быть не может: только признак «задано» и
 * длина, которой хватает, чтобы заметить обрезанную вставку. Перечень
 * допущенных к помощнику показывается целиком — это идентификаторы Telegram,
 * а не секрет, и именно они чаще всего и не совпадают.
 */
export async function GET(req: NextRequest) {
  const secret = req.headers.get('x-telegram-bot-api-secret-token');
  if (secret !== config.webhookSecret) {
    return NextResponse.json({ ok: true, service: 'proxysvpn-support-bot' });
  }

  // Проба всего пути до модели, без единого сообщения в Telegram.
  //
  // Иначе проверить «работает ли помощник» можно только нажав кнопку у себя в
  // чате, а это сообщения живому человеку и невозможность проверить чужой
  // сценарий. Здесь тот же самый вызов, что делает бот, и виден он только
  // тому, кто знает секрет вебхука.
  const probe = req.nextUrl.searchParams.get('probe');
  if (probe) {
    const id = Number(req.nextUrl.searchParams.get('as') || 0);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return NextResponse.json({ ok: false, error: 'нужен параметр as с числовым id' }, { status: 400 });
    }
    const started = Date.now();
    const result = await askProxysAi(id, probe.slice(0, 500));
    return NextResponse.json({ ok: true, probe: result, tookMs: Date.now() - started });
  }

  // The same cached snapshot the menu uses on this instance; load() never rejects.
  const gateSnapshot = await quickAnswerGate.load();

  return NextResponse.json({
    ok: true,
    service: 'proxysvpn-support-bot',
    env: {
      hasInternalApiKey: config.internalApiKey.length > 0,
      internalApiKeyLength: config.internalApiKey.length,
      aiAccess: config.aiAccess,
      adminUserIds: config.adminUserIds,
      forumMode: config.forumMode,
      siteUrl: config.siteUrl,
      // Who gets «⚡ Быстрый ответ» as the Mini App, and the URL it opens.
      //
      // `gate` describes the site's Redis set in counts only, never member ids.
      // `source: "unavailable"` means the read failed and everyone but the
      // owner gets the in-chat assistant; `ignoredMembers` above zero is
      // usually an id added without `tg_`. It is this instance's cache, up to
      // `ttlMs` old, so an SADD shows here within a minute.
      //
      // `url: null` means SITE_URL is unusable for web_app and everyone, the
      // owner included, gets the in-chat assistant — the same "button quietly
      // differs" blind spot this endpoint exists for.
      quickAnswerWebApp: {
        ownerUserId: OWNER_USER_ID,
        gate: describeQuickAnswerGate(gateSnapshot, Date.now(), quickAnswerGate.ttlMs),
        url: quickAnswerWebAppUrl(config.siteUrl),
      },
    },
  });
}
