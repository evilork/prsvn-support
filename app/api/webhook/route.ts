// app/api/webhook/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { askProxysAi } from '@/lib/ai';
import { handleUpdate } from '@/lib/handler';
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
    },
  });
}
