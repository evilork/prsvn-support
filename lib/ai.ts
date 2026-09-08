// lib/ai.ts
//
// «Быстрый ответ» — ProxysAI из кабинета, отвечающий здесь.
//
// ── Что это и чем не является ───────────────────────────
// Это НЕ второй помощник и не свой промпт. Модель, правила, состояние аккаунта
// и переписка — те же, что в кабинете на сайте; бот только приносит вопрос и
// уносит ответ. Соблазн написать боту «промпт покороче» здесь сознательно не
// реализован: два свода правил расходятся за месяц, и дальше один и тот же
// человек получает разные ответы в зависимости от того, откуда спросил.
//
// ── Как устроен разговор ────────────────────────────────
// Режим включается кнопкой и живёт двадцать минут (`support:aimode:<tgId>`),
// продлеваясь на каждом ответе. Короткая жизнь здесь принципиальна: залипший
// режим однажды проглотит настоящую жалобу, которую человек писал оператору.
// Поэтому же открытый тикет, ждущий оператора, всегда главнее режима — эту
// проверку делает вызывающий, в handler, — а ответ живого оператора режим
// гасит (`markOperatorReply` в tickets): начатый живой диалог главнее всего.
//
// ── Про разметку ────────────────────────────────────────
// Ответ модели уходит клиенту БЕЗ parse_mode. Правила помощника запрещают ему
// Markdown, но «запрещено» и «никогда не бывает» — разные вещи: одна угловая
// скобка в ответе с parse_mode=HTML означает не кривой шрифт, а отказ Telegram
// отправить сообщение целиком. Обычный текст отправляется всегда, а на
// наши собственные строки с разметкой есть отправка с откатом (см.
// `sendHtmlOrPlain` в handler).

import { Redis } from '@upstash/redis';
import { resolveAccountId } from './account';
import { config } from './config';

const redis = Redis.fromEnv();

const MODE_KEY = (tgId: number) => `support:aimode:${tgId}`;

/**
 * Сколько живёт включённый режим.
 *
 * Двадцать минут — заметно дольше паузы на «дай проверю на телефоне» и заметно
 * короче рабочего дня. Верхняя граница важнее нижней: человек, вернувшийся к
 * боту через час с настоящей бедой, должен попасть к оператору, а не к
 * помощнику, о котором он уже забыл.
 */
const MODE_TTL_SEC = 20 * 60;

/**
 * Сколько ждём ответа от ручки сайта.
 *
 * Число здесь не самостоятельное: оно должно быть БОЛЬШЕ полного бюджета той
 * стороны. Брось мы запрос раньше — сайт всё равно дописал бы оплаченный ответ
 * в общую переписку, человек бы его никогда не увидел, а в следующий раз
 * услышал «как я писал выше» про текст, которого не было.
 *
 * На той стороне бюджет задан под это: ручка `/api/internal/support-ai` даёт
 * модели по 18 секунд на основное и запасное обращение (MODEL_TIMEOUT_MS в
 * route.ts), то есть 36 в худшем случае. Сорок здесь их накрывают, и двадцать
 * до предела вебхука остаются на отказ и передачу оператору. Меняешь одно —
 * меняй и второе.
 */
const REQUEST_TIMEOUT_MS = 40_000;

/** Предел Telegram на одно сообщение. */
const TG_MAX_CHARS = 4096;

/** Сколько последних реплик показываем оператору при передаче разговора. */
const TRANSCRIPT_MESSAGES = 6;

/** Сколько знаков одной реплики попадает в выдержку для оператора. */
const TRANSCRIPT_CHARS = 700;

// ─── режим быстрого ответа ─────────────────────────────────

/**
 * Включить режим (или продлить уже включённый).
 *
 * В ключе лежит НЕ единица, а отметка времени включения: по ней выдержка
 * разговора для оператора отделяет сказанное в боте от сказанного в кабинете —
 * переписка-то общая (см. `aiTranscript`). Продление TTL отметку сохраняет:
 * перезапиши мы её на каждом ответе, из выдержки исчезло бы начало разговора,
 * ради которого она и делается.
 *
 * Ошибку глотаем, но записываем: сюда зовут между ответом модели и отправкой
 * ответа человеку, и исключение здесь означало бы полное молчание в чате.
 */
export async function enableAiMode(tgId: number): Promise<void> {
  try {
    const first = await redis.set(MODE_KEY(tgId), Date.now(), { nx: true, ex: MODE_TTL_SEC });
    if (first === null) await redis.expire(MODE_KEY(tgId), MODE_TTL_SEC);
  } catch (err) {
    console.error('[support][ai] mode write failed:', err);
  }
}

/**
 * Когда включён режим. `null` — режима нет или отметки нет.
 *
 * Отметки нет у режимов, включённых до выката этой правки: там в ключе лежит
 * единица. Такой режим работает как прежде, но выдержку разговора не даёт —
 * это лучше, чем положить оператору в тикет утренний разговор из кабинета.
 */
export async function aiModeStartedAt(tgId: number): Promise<number | null> {
  try {
    const raw = await redis.get<unknown>(MODE_KEY(tgId));
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 1 ? n : null;
  } catch (err) {
    console.error('[support][ai] mode read failed:', err);
    return null;
  }
}

export async function isAiMode(tgId: number): Promise<boolean> {
  try {
    return (await redis.get(MODE_KEY(tgId))) !== null;
  } catch (err) {
    // Не знаем — считаем, что режим выключен: сомнение в пользу оператора.
    // Ошибочно включённый режим глотает жалобу, ошибочно выключенный лишь
    // отправляет вопрос живому человеку.
    console.error('[support][ai] mode read failed:', err);
    return false;
  }
}

export async function disableAiMode(tgId: number): Promise<void> {
  await redis.del(MODE_KEY(tgId)).catch((err) => {
    console.error('[support][ai] mode delete failed:', err);
  });
}

// ─── передача разговора оператору «потом» ──────────────────
//
// Кнопку «Связаться со специалистом» человек жмёт ДО того, как напишет вопрос,
// поэтому тикета в этот момент ещё нет и класть выдержку разговора некуда.
// Заводить тикет на нажатие кнопки нельзя — в группе появились бы пустые темы.
// Поэтому оставляем метку: следующее сообщение этого человека создаст тикет, и
// выдержка приедет туда.

const HANDOFF_KEY = (tgId: number) => `support:aihandoff:${tgId}`;

/** Живёт дольше режима: человек ушёл читать инструкцию и вернулся. */
const HANDOFF_TTL_SEC = 30 * 60;

export async function markAiHandoff(tgId: number, startedAt: number | null): Promise<void> {
  if (startedAt === null) return;
  try {
    await redis.set(HANDOFF_KEY(tgId), startedAt, { ex: HANDOFF_TTL_SEC });
  } catch (err) {
    console.error('[support][ai] handoff write failed:', err);
  }
}

/**
 * Сказать ли человеку, что кабинета под этим телеграмом нет.
 *
 * `true` не чаще одного раза за разговор: предупреждение важное, но под каждым
 * ответом оно превращается в шум, а шум учат пролистывать. Метка живёт столько
 * же, сколько режим, и вместе с ним истекает.
 */
export async function noteMissingAccountOnce(tgId: number): Promise<boolean> {
  try {
    const first = await redis.set(`support:ainoacct:${tgId}`, 1, {
      nx: true,
      ex: MODE_TTL_SEC,
    });
    return first !== null;
  } catch (err) {
    // Не знаем — молчим: лишнее предупреждение под каждым ответом хуже, чем
    // отсутствующее.
    console.error('[support][ai] no-account note failed:', err);
    return false;
  }
}

/** Забрать метку (и погасить её): выдержка кладётся в тикет один раз. */
export async function takeAiHandoff(tgId: number): Promise<number | null> {
  try {
    const raw = await redis.get<unknown>(HANDOFF_KEY(tgId));
    if (raw === null || raw === undefined) return null;
    await redis.del(HANDOFF_KEY(tgId));
    const n = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(n) && n > 1 ? n : null;
  } catch (err) {
    console.error('[support][ai] handoff read failed:', err);
    return null;
  }
}

// ─── обращение к помощнику ─────────────────────────────────

export interface AiAnswer {
  text: string;
  /** Непусто — помощник сам решил передать человека оператору. */
  escalate: string | null;
  guarded: boolean;
  /** Нашёлся ли аккаунт по этому телеграму. */
  accountFound: boolean;
}

export type AiResult =
  | { ok: true; answer: AiAnswer }
  /**
   * `limited` отделено от прочих неудач намеренно: превышение лимита — это не
   * наша поломка, и пересылать такое оператору автоматически нельзя, иначе
   * поток сообщений просто переезжает на живого человека.
   */
  | { ok: false; kind: 'limited' | 'failed'; message: string };

interface ApiOk {
  text?: unknown;
  escalate?: unknown;
  guarded?: unknown;
  accountFound?: unknown;
}

const FAILED_MSG = 'Быстрый ответ сейчас недоступен.';

/**
 * Спросить помощника. Никогда не бросает: любая беда — это `ok: false`.
 *
 * `reset: true` стирает разговор и модель не трогает.
 */
export async function askProxysAi(
  tgId: number,
  text: string,
  opts: { reset?: boolean } = {},
): Promise<AiResult> {
  if (!config.internalApiKey) {
    // До сюда доходить не должно: без ключа кнопки нет. Но если дошло —
    // молчать нельзя, иначе поломка выглядит как «бот не отвечает».
    console.error('[support][ai] INTERNAL_API_KEY не задан');
    return { ok: false, kind: 'failed', message: FAILED_MSG };
  }

  const url = `${config.siteUrl.replace(/\/+$/, '')}/api/internal/support-ai`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.internalApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ telegramId: tgId, text, reset: opts.reset === true }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (res.status === 429) {
      const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
      const message =
        typeof body?.error === 'string' && body.error
          ? body.error
          : 'Слишком часто. Подождите немного.';
      return { ok: false, kind: 'limited', message };
    }

    if (!res.ok) {
      console.error(`[support][ai] HTTP ${res.status}`);
      return { ok: false, kind: 'failed', message: FAILED_MSG };
    }

    const data = (await res.json()) as ApiOk;
    const answer = typeof data.text === 'string' ? data.text.trim() : '';
    const escalate =
      typeof data.escalate === 'string' && data.escalate.trim() ? data.escalate.trim() : null;

    // Пустой ответ без признака передачи оператору — это тоже неудача, просто
    // тихая. Отправить человеку пустоту хуже, чем честно сказать «не вышло».
    if (!answer && !escalate) {
      console.error('[support][ai] пустой ответ ручки');
      return { ok: false, kind: 'failed', message: FAILED_MSG };
    }

    return {
      ok: true,
      answer: {
        text: answer,
        escalate,
        guarded: data.guarded === true,
        accountFound: data.accountFound === true,
      },
    };
  } catch (err) {
    console.error('[support][ai] request failed:', err);
    return { ok: false, kind: 'failed', message: FAILED_MSG };
  }
}

// ─── выдержка из разговора для оператора ───────────────────

interface StoredMessage {
  role?: unknown;
  text?: unknown;
  at?: unknown;
}

/**
 * Последние реплики разговора с помощником — чтобы оператор видел, что уже
 * пробовали, и не начинал с «расскажите, что у вас случилось».
 *
 * Читаем тот же ключ, в который пишет сайт. Своей копии переписки у бота нет и
 * быть не должно: это один разговор одного человека.
 *
 * ── Почему обязателен `startedAt` ───────────────────────
 * Ключ общий с чатом кабинета, и без отсечки по времени в тикет уехало бы всё
 * подряд: человек утром писал помощнику в кабинете про возврат на карту, а
 * вечером спросил в боте про Германию — и его утренние реплики оказались бы в
 * операторской группе, где их видят все. Он на это не соглашался. Поэтому в
 * тикет попадает только сказанное ПОСЛЕ включения режима в боте, а без отметки
 * (режим включён до выката этой правки) — ничего.
 *
 * Неудача чтения не должна ломать передачу оператору — тикет важнее выдержки,
 * поэтому здесь пустой список, а не исключение.
 */
export async function aiTranscript(tgId: number, startedAt: number | null): Promise<string[]> {
  if (startedAt === null) return [];
  try {
    const accountId = await resolveAccountId(tgId);
    const raw = await redis.get<StoredMessage[] | string>(`support:chat:${accountId}`);
    const list = typeof raw === 'string' ? (JSON.parse(raw) as StoredMessage[]) : raw;
    if (!Array.isArray(list)) return [];

    return list
      .filter((m) => {
        const at = typeof m.at === 'number' ? m.at : Number(m.at);
        return Number.isFinite(at) && at >= startedAt;
      })
      .slice(-TRANSCRIPT_MESSAGES)
      .map((m) => {
        const who = m.role === 'assistant' ? '🤖' : '👤';
        const body = typeof m.text === 'string' ? m.text.trim() : '';
        if (!body) return null;
        const cut = body.length > TRANSCRIPT_CHARS ? `${body.slice(0, TRANSCRIPT_CHARS - 1)}…` : body;
        return `${who} ${cut}`;
      })
      .filter((s): s is string => s !== null);
  } catch (err) {
    console.error('[support][ai] transcript read failed:', err);
    return [];
  }
}

// ─── нарезка длинного ответа ───────────────────────────────

/**
 * Нарезать ответ под предел Telegram, по границам абзацев.
 *
 * Режем сначала по пустым строкам, потом по переводам строки и только в
 * последнюю очередь посередине слова: разорванный абзац читается плохо, но
 * разорванная строка кода или ссылка — это уже неверный совет.
 */
export function splitForTelegram(text: string, limit = TG_MAX_CHARS): string[] {
  const src = text.trim();
  if (src.length <= limit) return src ? [src] : [];

  const chunks: string[] = [];
  let rest = src;

  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    // Приоритет границ: абзац → строка → пробел → жёсткий разрез.
    let cut = window.lastIndexOf('\n\n');
    if (cut < limit * 0.5) cut = window.lastIndexOf('\n');
    if (cut < limit * 0.5) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = limit;

    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  if (rest) chunks.push(rest);
  return chunks.filter((c) => c.length > 0);
}
