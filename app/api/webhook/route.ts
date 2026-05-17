// app/api/webhook/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { handleUpdate } from '@/lib/handler';
import type { Update } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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

export async function GET() {
  return NextResponse.json({ ok: true, service: 'proxysvpn-support-bot' });
}
