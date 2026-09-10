// app/api/cron/stale/route.ts
//
// Тикеты, которые ждут ответа. Первый крон в этом боте вообще.
//
// ── Что было ────────────────────────────────────────────
// Отметки `lastOperatorAt` и `isWaiting` в боте есть с самого начала, но
// читаются они только тогда, когда оператор САМ придёт в /start и посмотрит на
// строку «🔴 ждут ответа». Механизма, который бы напомнил, не было ни одного:
// в vercel.json не было ни строчки про кроны, а в app/api лежал один вебхук.
//
// Разбор операторского чата за 17.05–09.09.2026: молчание после передачи
// оператору — самая массовая строка выгрузки и единственная, где мы не
// отвечаем вообще. На конец выгрузки без ответа висели 14 тикетов, трое ждали
// больше суток, один человек написал «Поддержка Ваша говно», другой — «я
// смирился». Хуже того: нажав «Связаться со специалистом», человек попадает в
// `disableAiMode` — помощника ему выключили, а оператор молчит.
//
// ── Что делает ──────────────────────────────────────────
// Две ступени, и они независимы.
//
//   1. Ждёт дольше `staleAiMinutes` — помощник отдаёт ПЕРВЫЙ ответ сам, вместо
//      тишины. Один раз на тикет. Тикет при этом остаётся ждущим: автоответ —
//      не ответ оператора, и снимать с него 🔴 нельзя.
//   2. Ждёт дольше `staleDigestHours` — оператору в личку список «#223 — 19 ч».
//      Не чаще одного раза за тот же срок, иначе это перестанут читать.
//
// ── Про запор ───────────────────────────────────────────
// Ступень 1 ПИШЕТ ЖИВЫМ КЛИЕНТАМ, поэтому по умолчанию она открыта одному
// владельцу (`SUPPORT_STALE_AI_USER_IDS`, см. lib/config.ts) — правило проекта
// «сначала владельцу, потом всем». Ступень 2 никому, кроме оператора, ничего
// не шлёт и работает всегда.
//
// Auth: Vercel cron присылает `Authorization: Bearer <CRON_SECRET>`.

import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { askProxysAi, splitForTelegram } from '@/lib/ai';
import { config, staleAutoAnswerEnabled } from '@/lib/config';
import { noteInTopic } from '@/lib/forum';
import { sendMessage } from '@/lib/telegram';
import {
  claimAutoAnswer,
  claimStaleDigest,
  claimTicketPing,
  listWaitingTickets,
  markBlocked,
  releaseAutoAnswer,
  type Ticket,
} from '@/lib/tickets';

const redis = Redis.fromEnv();

/**
 * След запуска. Первый крон в этом проекте, и молчащий крон от отсутствующего
 * иначе не отличить ничем: без CRON_SECRET ручка отвечает 401 ещё до всякой
 * работы, и в журнале функций это выглядит как чужой сканер. Отметка пишется и
 * на отказе авторизации — именно она и говорит «крон зовут, но он не наш».
 *
 * Своя неудача ничего не значит: это диагностика, а не работа.
 */
async function beat(payload: Record<string, unknown>): Promise<void> {
  try {
    await redis.set(
      'cronbeat:support-stale',
      JSON.stringify({ at: Date.now(), ...payload }),
      { ex: 7 * 24 * 3600 },
    );
  } catch (err) {
    console.error('[support][stale] отметка о проходе не записалась:', err);
  }
}

/**
 * Обращение к модели идёт по одному на тикет и занимает секунды. Вебхук бота
 * живёт 60, здесь запас больше: тикетов может быть десяток.
 */
export const maxDuration = 300;

/** Оставляем время на дайджест и на честный ответ, если бюджет кончился. */
const TIME_BUDGET_MS = 240_000;

/** Сколько автоответов отдаём за один проход. */
const MAX_AUTO_ANSWERS = 10;

/**
 * Сколько личных пингов оператору отдаём за один проход.
 *
 * Первый проход после выката застанет всю накопившуюся очередь — на конец
 * разбираемой выгрузки это 14 тикетов. Четырнадцать сообщений подряд читаются
 * как сбой, а не как сигнал; остальные приедут следующим проходом через
 * четверть часа, и порядок у списка от самых давних.
 */
const MAX_PINGS = 5;

/**
 * На сколько часов замолкает личный пинг ПО ОДНОМУ тикету.
 *
 * Сутки, а не `staleFirstPingHours`. Порог и замок — разные вещи: порог
 * говорит, КОГДА сказать в первый раз, замок — как часто повторять. Тикет,
 * висящий трое суток, при замке в два часа дал бы тридцать шесть одинаковых
 * сообщений и приучил бы их не читать — ровно то, от чего мы уходим. Дальше
 * про него напоминает дайджест, у которого своё место и свой вид.
 */
const PING_LOCK_HOURS = 24;

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/**
 * Верхняя граница автоответа.
 *
 * Через сутки молчания отвечать помощником уже поздно и оскорбительно: человек
 * ждал живого, а получает робота на следующий день. Такие тикеты идут в
 * дайджест оператору, и только туда.
 */
const AUTO_ANSWER_MAX_AGE_MS = 12 * HOUR;

const AUTO_ANSWER_HEAD =
  'Оператор пока не ответил — вот что могу подсказать сам, пока ждём. ' +
  'Ваш вопрос никуда не делся, оператор ответит здесь же.';

function hoursWord(ms: number): string {
  const h = Math.floor(ms / HOUR);
  if (h >= 1) return `${h} ч`;
  return `${Math.max(1, Math.floor(ms / MIN))} мин`;
}

function who(t: Ticket): string {
  const name = (t.firstName + (t.lastName ? ' ' + t.lastName : '')).trim().slice(0, 30) || 'без имени';
  return t.username ? `${name} @${t.username}` : name;
}

interface Stats {
  waiting: number;
  /** Подходят под автоответ по возрасту и запору. */
  eligible: number;
  answered: number;
  /** Не ответили: модель отказала или ручка недоступна. */
  answerFailed: number;
  /** Отбиты лимитом сайта (429). Отметку вернули — повторим в следующий раз. */
  answerLimited: number;
  /** Помощник сам попросил оператора: ответа человеку нет, оператор извещён. */
  escalated: number;
  /** Ответ не доставлен: человек заблокировал бота уже после обращения. */
  undelivered: number;
  /** Пропущены: последняя реплика — вложение, спрашивать нечего. */
  noQuestion: number;
  /** Личных пингов оператору по отдельным тикетам за проход. */
  pings: number;
  digestTickets: number;
  digestSent: boolean;
  partial?: boolean;
}

/**
 * Ответить помощником вместо молчания.
 *
 * Ответ уходит БЕЗ parse_mode — по той же причине, что и в живом разговоре:
 * одна угловая скобка в режиме HTML стоила бы всего сообщения целиком.
 *
 * ПРО ОТМЕТКУ. `claimAutoAnswer` берётся ДО обращения к модели: два прохода
 * крона не должны дать человеку два автоответа. Но отметка означает «человеку
 * уже сказали», и оставлять её там, где человек не услышал НИЧЕГО, нельзя —
 * попытка на тикет ровно одна. Поэтому исходы разведены:
 *
 *   • 429 от сайта (минутный, суточный на человека, суточный общий) — чужой
 *     и ВРЕМЕННЫЙ отказ: отметку возвращаем, следующий проход через четверть
 *     часа скорее всего пройдёт;
 *   • отказ самой модели — отметку держим: повтор стоит денег и кончится тем
 *     же, а молчание здесь — ровно то, что было до этой правки;
 *   • Telegram не принял (человек заблокировал бота) — отметку возвращаем и
 *     помечаем тикет: досылать будет `flushUndelivered`, когда он вернётся;
 *   • пустой текст при непустом `escalate` — штатный исход, модель осознанно
 *     передаёт человека живому. Молчать об этом нельзя ни клиенту, ни
 *     оператору: клиенту сказать нечего, а оператору — есть, и он узнаёт.
 */
async function answerOne(t: Ticket, stats: Stats): Promise<void> {
  const question = (t.lastClientText || '').trim();
  if (!question) {
    stats.noQuestion += 1;
    return;
  }
  if (!(await claimAutoAnswer(t.id))) return;

  const res = await askProxysAi(t.userId, question);
  if (!res.ok) {
    if (res.kind === 'limited') {
      stats.answerLimited += 1;
      await releaseAutoAnswer(t.id);
    } else {
      stats.answerFailed += 1;
    }
    console.error(`[support][stale] #${t.id}: помощник не ответил (${res.kind})`);
    return;
  }

  // Передачу оператору помощник тут делать не может — тикет УЖЕ у оператора.
  // Если он её попросил ВМЕСТЕ с текстом, отдаём текст: он всё равно по делу,
  // а строка «передаю оператору» человеку, который сутки ждёт оператора, —
  // издёвка. Если текста нет вовсе, сказать человеку нечего, но оператор
  // обязан узнать, что помощник смотрел и отказался отвечать сам.
  const body = res.answer.text.trim();
  if (!body) {
    stats.escalated += 1;
    await pingOperators(
      t,
      `🤖 <b>Помощник просит оператора</b> — #${t.id}, ждёт ${hoursWord(waitedOf(t))}.` +
        (res.answer.escalate ? `\nПричина: ${escapeHtml(res.answer.escalate)}` : ''),
      stats,
    );
    await noteInTopic(
      t,
      '🤖 <b>Помощник не стал отвечать сам</b> — вопрос требует оператора. Клиенту ничего не отправлено.',
      { notify: true },
    );
    return;
  }

  const chunks = splitForTelegram(`${AUTO_ANSWER_HEAD}\n\n${body}`);
  let delivered = 0;
  for (const chunk of chunks) {
    const sent = await sendMessage(t.userId, chunk);
    if (!sent.ok) {
      console.error(`[support][stale] #${t.id}: ответ не доставлен: ${sent.description || 'ошибка'}`);
      break;
    }
    delivered += 1;
  }

  // Ни одного куска не доехало — значит человек нас не слышит. Отметку
  // возвращаем: помощник ему так ничего и не сказал, а когда он разблокирует
  // бота, попытка должна остаться.
  if (delivered === 0) {
    stats.undelivered += 1;
    await releaseAutoAnswer(t.id);
    await markBlocked(t.id);
    return;
  }

  stats.answered += 1;

  // Оператор обязан видеть, что человеку уже сказали: иначе он ответит второй
  // раз то же самое, а человек прочитает это как «меня не слушают». СО ЗВУКОМ:
  // это единственная служебная строка, которую он должен прочитать сразу.
  await noteInTopic(
    t,
    `🤖 <b>Помощник ответил сам</b> — тикет ждал ${hoursWord(waitedOf(t))}. ` +
      `Тикет по-прежнему ждёт вашего ответа.`,
    { notify: true },
  );
}

function waitedOf(t: Ticket): number {
  return Date.now() - (t.waitingSince ?? t.lastClientAt ?? t.updatedAt);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Личный пинг оператору по ОДНОМУ тикету.
 *
 * Дайджест приходит раз в `staleDigestHours` и держит общий замок на тот же
 * срок — между 45 минутами и полусутками у оператора не было ни одного
 * сигнала, а тикет, перешагнувший порог сразу после рассылки, ждал следующей
 * почти сутки. Здесь замок ПОТИКЕТНЫЙ: одно сообщение на тикет за
 * `staleFirstPingHours`, независимо от того, когда уходил дайджест.
 */
async function pingOperators(t: Ticket, text: string, stats: Stats): Promise<void> {
  if (config.adminUserIds.length === 0) return;
  if (!(await claimTicketPing(t.id, PING_LOCK_HOURS))) return;
  for (const adminId of config.adminUserIds) {
    await sendMessage(adminId, text, { parse_mode: 'HTML' });
  }
  stats.pings += 1;
}

/** Список ждущих дольше суток — оператору в личку. */
async function sendDigest(items: { ticket: Ticket; waitedMs: number }[], stats: Stats): Promise<void> {
  if (items.length === 0) return;
  stats.digestTickets = items.length;
  if (config.adminUserIds.length === 0) return;
  if (!(await claimStaleDigest(config.staleDigestHours))) return;

  const lines = [
    `⏳ <b>Ждут ответа дольше ${config.staleDigestHours} ч: ${items.length}</b>`,
    '',
    ...items.slice(0, 20).map((x) => `#${x.ticket.id} — ${hoursWord(x.waitedMs)} · ${who(x.ticket)}`),
  ];
  if (items.length > 20) lines.push(`…и ещё ${items.length - 20}`);

  for (const adminId of config.adminUserIds) {
    await sendMessage(adminId, lines.join('\n'), { parse_mode: 'HTML' });
  }
  stats.digestSent = true;
}

/**
 * Кто имеет право запускать проход.
 *
 * Правильный путь один: заголовок с `CRON_SECRET`. Пока переменная задана,
 * ничего другого не принимается.
 *
 * Запасной путь появился 10.09.2026 по факту: Vercel вызвал ручку в 06:30,
 * получил 401 и ничего не сделал — переменной в проекте не было, а владелец в
 * дороге до 11-го, то есть ровно в те сутки, ради которых крон и написан.
 * Поэтому БЕЗ заданного секрета мы принимаем вызов самого Vercel, опознавая
 * его по `user-agent: vercel-cron/...`.
 *
 * Почему это допустимо. Подделать строку опознания может кто угодно, но
 * выигрыш от подделки нулевой: каждое действие прохода стоит за своим замком —
 * личный пинг по тикету раз в сутки, общая сводка раз в двенадцать часов,
 * автоответ по тикету один. Сколько бы раз ручку ни дёрнули, оператор получит
 * не больше, чем от честного расписания, а посторонний не увидит ничего:
 * ответ содержит только счётчики.
 *
 * Как только `CRON_SECRET` появится, запасной путь выключится сам, и в отметке
 * это видно полем `openMode`.
 */
function cronAllowed(req: NextRequest): { ok: boolean; openMode: boolean } {
  if (config.cronSecret) {
    return { ok: req.headers.get('authorization') === `Bearer ${config.cronSecret}`, openMode: false };
  }
  const ua = (req.headers.get('user-agent') || '').toLowerCase();
  return { ok: ua.startsWith('vercel-cron/'), openMode: true };
}

export async function GET(req: NextRequest) {
  const gate = cronAllowed(req);
  if (!gate.ok) {
    // Отметка ДО отказа и есть весь смысл `beat`: 401 в журнале функций
    // выглядит как чужой сканер, и «CRON_SECRET забыли завести» от «крона нет
    // вовсе» иначе не отличить ничем. `noSecret` прямо называет причину.
    await beat({ ok: false, unauthorized: true, noSecret: !config.cronSecret });
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (gate.openMode) {
    console.warn('[support][stale] CRON_SECRET не задан — проход пущен по опознанию вызова Vercel');
  }

  const startedAt = Date.now();
  const stats: Stats = {
    waiting: 0,
    eligible: 0,
    answered: 0,
    answerFailed: 0,
    answerLimited: 0,
    escalated: 0,
    undelivered: 0,
    noQuestion: 0,
    pings: 0,
    digestTickets: 0,
    digestSent: false,
  };

  try {
    const waiting = await listWaitingTickets(config.staleAiMinutes * MIN, startedAt);
    stats.waiting = waiting.length;

    // Дайджест собираем ПЕРВЫМ: он дешёвый и не зависит от того, хватило ли
    // бюджета времени на обращения к модели.
    await sendDigest(
      waiting.filter((x) => x.waitedMs >= config.staleDigestHours * HOUR),
      stats,
    );

    // Личный пинг на ПЕРВОМ пороге. Между автоответом на 45 минуте и
    // дайджестом на 12 часе у оператора не было ни одного сигнала, а замок
    // дайджеста — ОДИН ГЛОБАЛЬНЫЙ на те же 12 часов: тикет, перешагнувший
    // порог через десять минут после рассылки, попадал в следующую почти через
    // сутки. Ровно та картина, что в выгрузке — «трое ждут больше суток».
    // Здесь замок потикетный, поэтому каждый тикет получает свой сигнал в свой
    // срок и ровно один раз.
    for (const x of waiting) {
      if (stats.pings >= MAX_PINGS) break;
      if (x.waitedMs < config.staleFirstPingHours * HOUR) continue;
      if (Date.now() - startedAt > TIME_BUDGET_MS) break;
      await pingOperators(
        x.ticket,
        `⏳ <b>Ждёт ответа ${hoursWord(x.waitedMs)}</b> — #${x.ticket.id} · ${escapeHtml(who(x.ticket))}` +
          (x.ticket.autoAnsweredAt ? '\nПомощник уже отвечал сам.' : '') +
          (x.ticket.lastClientText ? `\n<i>${escapeHtml(x.ticket.lastClientText.slice(0, 200))}</i>` : ''),
        stats,
      );
    }

    const fresh = waiting.filter(
      (x) => x.waitedMs < AUTO_ANSWER_MAX_AGE_MS && !x.ticket.autoAnsweredAt,
    );
    for (const x of fresh) {
      if (stats.answered >= MAX_AUTO_ANSWERS) break;
      if (Date.now() - startedAt > TIME_BUDGET_MS) {
        stats.partial = true;
        console.error('[support][stale] бюджет времени исчерпан — остальные в следующий раз');
        break;
      }
      if (!staleAutoAnswerEnabled(x.ticket.userId)) continue;
      stats.eligible += 1;
      await answerOne(x.ticket, stats);
    }
  } catch (err) {
    console.error('[support][stale] проход не удался:', err);
    await beat({ ok: false, openMode: gate.openMode, ms: Date.now() - startedAt, error: String(err), ...stats });
    return NextResponse.json({ ok: false, stats }, { status: 500 });
  }

  await beat({ ok: true, openMode: gate.openMode, ms: Date.now() - startedAt, ...stats });
  return NextResponse.json({ ok: true, ms: Date.now() - startedAt, stats });
}
