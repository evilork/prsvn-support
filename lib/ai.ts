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
 * ── Откуда именно тридцать ──────────────────────────────
 * Вебхук бота живёт 60 секунд (maxDuration в app/api/webhook/route.ts), и в эти
 * 60 обязана уложиться ВСЯ обработка, а не только ожидание модели. Скачивание
 * вложения берёт до 7 (ATTACHMENT_TIMEOUT_MS в lib/attachments.ts), ожидание
 * ответа — до 30: вместе 37, и 23 секунды остаются на самый дорогой из наших
 * исходов — передачу оператору. Она не бесплатна: погасить режим, сказать
 * человеку, создать тему в группе, скопировать сообщение, нарисовать карточку
 * и приложить выдержку разговора — это около десятка обращений к Telegram и
 * Redis подряд.
 *
 * Раньше здесь стояло 40, и сумма 10 + 40 = 50 оставляла на всё это десять
 * секунд. Не хватило бы их — Vercel убивает вызов на шестидесятой секунде, а
 * повторную доставку того же обновления глушит `isDuplicateUpdate`: человеку не
 * отправлено ничего, тикета нет, скриншот исчез совсем.
 *
 * На той стороне бюджет задан под это: ручка `/api/internal/support-ai` даёт
 * модели 18 секунд на обращение, но держит общий потолок в 26 (MODEL_BUDGET_MS
 * там же) и не начинает запасное обращение, если на него не осталось времени.
 * Меняешь одно — меняй и второе.
 */
const REQUEST_TIMEOUT_MS = 30_000;

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

// ─── альбом из нескольких фото ─────────────────────────────
//
// ── Задача ──────────────────────────────────────────────
// Собранного альбома не существует: Telegram доставляет его несколькими
// отдельными обновлениями с общим `media_group_id`, ПАРАЛЛЕЛЬНО и в любом
// порядке. Ждать остальные негде — вебхук живёт одним запросом, — а разбирать
// каждое значит задать модели пять одинаковых вопросов, потратить пять
// обращений из сорока суточных и вывалить человеку пять ответов на одну беду.
//
// ── Что здесь устроено ──────────────────────────────────
// На пачку приходится ОДИН исход. Кто его считает — решает гонка за `claimAlbum`
// (поэтому в ответе человеку разобранный снимок не называется «первым»).
//
// Опасность не в лишнем ответе, а в потере. До 08.09.2026 проигравшие
// обновления просто делали `return`, и это было верно ровно до первого отказа:
// стоило разбору кончиться передачей оператору — неудачей скачивания, ESCALATE
// или сбоем ручки, — как оператор получал ОДИН файл из пяти, а человеку при
// этом было обещано, что сообщение передано. Оператор не знал, что было ещё
// четыре, человек был уверен, что отдал все.
//
// Поэтому пачка ведёт учёт: каждое обновление записывает свой message_id в
// список ДО того, как проверит замок, а победитель на любом пути к оператору
// сначала ставит метку «ушла оператору», а потом дочитывает список и досылает
// остальные. Порядок именно такой и он важен:
//
//   проигравший: RPUSH id → читает метку → если стоит, досылает себя сам;
//   победитель:  ставит метку → читает список → досылает всё, что в нём есть.
//
// Пересечение в обе стороны закрыто. Проигравший, прочитавший метку ДО того,
// как её поставили, успел записать свой id раньше — значит победитель его
// увидит. Проигравший, пришедший ПОСЛЕ метки, доносит себя сам. Двойную
// доставку снимает отдельная отметка на каждое сообщение (`claimAlbumRelay`):
// доставить дважды не страшно, но оператору незачем видеть один скриншот
// двумя копиями.
//
// Сбой базы всюду толкуем в пользу доставки: лишний файл у оператора дешевле
// пропавшего.

const ALBUM_KEY = (tgId: number, groupId: string) => `support:aialbum:${tgId}:${groupId}`;

/** Список message_id всей пачки: из него досылаются непрочитанные. */
const ALBUM_MSGS_KEY = (tgId: number, groupId: string) =>
  `support:aialbummsgs:${tgId}:${groupId}`;

/** Метка «эта пачка уехала оператору»: опоздавшие идут туда же. */
const ALBUM_HANDOFF_KEY = (tgId: number, groupId: string) =>
  `support:aialbumop:${tgId}:${groupId}`;

/** Отметка на конкретное сообщение пачки: оператору оно уже доставлено. */
const ALBUM_RELAY_KEY = (tgId: number, groupId: string, messageId: number) =>
  `support:aialbumsent:${tgId}:${groupId}:${messageId}`;

/**
 * Живёт две минуты: обновления одной пачки приходят за секунды, а держать
 * метку дольше значит проглотить второй альбом, присланный следом.
 */
const ALBUM_TTL_SEC = 120;

/** Сколько сообщений одной пачки не считаются отдельными обращениями. */
const ALBUM_FREE_MESSAGES = 10;

/**
 * Разбирать ли ЭТО сообщение из присланной пачки.
 *
 * `true` ровно одному обновлению пачки. Остальным — `false`, и они обязаны
 * спросить `albumWentToOperator`, а не молча выйти: см. рассказ выше.
 */
export async function claimAlbum(tgId: number, groupId: string): Promise<boolean> {
  try {
    const first = await redis.set(ALBUM_KEY(tgId, groupId), 1, { nx: true, ex: ALBUM_TTL_SEC });
    return first !== null;
  } catch (err) {
    console.error('[support][ai] album mark failed:', err);
    return true;
  }
}

/**
 * Записать сообщение пачки в общий список.
 *
 * Зовётся ПЕРВЫМ делом, до замка: иначе победитель прочитает список раньше, чем
 * в него попадут опоздавшие, и они потеряются ровно в тот момент, когда пачка
 * уезжает оператору.
 */
export async function noteAlbumMessage(
  tgId: number,
  groupId: string,
  messageId: number,
): Promise<void> {
  try {
    const key = ALBUM_MSGS_KEY(tgId, groupId);
    await redis.rpush(key, String(messageId));
    // Больше десяти Telegram в альбом не кладёт, но `media_group_id` приходит
    // из обновления: список обязан быть ограничен сам, а не верой в отправителя.
    await redis.ltrim(key, -(ALBUM_FREE_MESSAGES * 2), -1);
    await redis.expire(key, ALBUM_TTL_SEC);
  } catch (err) {
    console.error('[support][ai] album list write failed:', err);
  }
}

/**
 * Пометить пачку как уехавшую оператору.
 *
 * Ставится ДО пересылки, а не после: сообщение пачки, пришедшее в эту же
 * секунду, должно увидеть метку и пойти к оператору само, а не решить, что его
 * разбирает помощник.
 */
export async function markAlbumToOperator(tgId: number, groupId: string): Promise<void> {
  try {
    await redis.set(ALBUM_HANDOFF_KEY(tgId, groupId), 1, { ex: ALBUM_TTL_SEC });
  } catch (err) {
    console.error('[support][ai] album handoff mark failed:', err);
  }
}

/**
 * Уехала ли пачка оператору.
 *
 * Сбой чтения — `true`: опоздавшее сообщение лучше отдать оператору лишний раз,
 * чем потерять. Двойную доставку всё равно снимает `claimAlbumRelay`.
 */
export async function albumWentToOperator(tgId: number, groupId: string): Promise<boolean> {
  try {
    return (await redis.get(ALBUM_HANDOFF_KEY(tgId, groupId))) !== null;
  } catch (err) {
    console.error('[support][ai] album handoff read failed:', err);
    return true;
  }
}

/**
 * Какие сообщения пачки записаны. Пустой список — не беда, а обычное дело:
 * остальные обновления могли ещё не дойти.
 */
export async function albumMessages(tgId: number, groupId: string): Promise<number[]> {
  try {
    const raw = await redis.lrange(ALBUM_MSGS_KEY(tgId, groupId), 0, -1);
    if (!Array.isArray(raw)) return [];
    const ids = raw.map((v) => Number(v)).filter((n) => Number.isSafeInteger(n) && n > 0);
    return [...new Set(ids)];
  } catch (err) {
    console.error('[support][ai] album list read failed:', err);
    return [];
  }
}

/**
 * Можно ли доставить оператору ИМЕННО это сообщение пачки.
 *
 * `true` один раз на сообщение. Нужно потому, что доставить его могут двое:
 * победитель по списку и само опоздавшее обновление, увидевшее метку. Сбой базы
 * — `true`: дубль у оператора дешевле пропажи.
 */
export async function claimAlbumRelay(
  tgId: number,
  groupId: string,
  messageId: number,
): Promise<boolean> {
  try {
    const first = await redis.set(ALBUM_RELAY_KEY(tgId, groupId, messageId), 1, {
      nx: true,
      ex: ALBUM_TTL_SEC,
    });
    return first !== null;
  } catch (err) {
    console.error('[support][ai] album relay mark failed:', err);
    return true;
  }
}

// ─── суточный бюджет на скачивание вложений ────────────────
//
// Лимиты на той стороне считают ОБРАЩЕНИЯ К МОДЕЛИ, и это не то же самое, что
// расход. Скачивание файла до модели даже не доходит: сообщение, отбитое
// суточной квотой ручки, всё равно тянуло мегабайт из Telegram, кодировало его
// в base64 и заливало 1,33 МБ в наш же вебхук — а «Быстрый ответ» после отказа
// по квоте намеренно НЕ гасится, значит следующая фотография начинала цикл
// заново. Своя минута — десять сообщений, то есть до двадцати четырёх мегабайт
// в минуту с одного телеграма, которому положено пять ответов в сутки.
//
// Поэтому разрешение спрашивается ДО скачивания и здесь, у бота: ручка про
// файлы ничего не знает и знать не должна.

/** Сутки по UTC: ключ сам истекает, точность до часового пояса тут не нужна. */
function dayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

const ATTACH_DAY_KEY = (tgId: number) => `support:aiattach:${tgId}:${dayStamp()}`;
const ATTACH_DAY_ALL_KEY = () => `support:aiattachall:${dayStamp()}`;

const DAY_SEC = 24 * 60 * 60;

/** Что мешает разобрать вложение. `null` — ничто, качаем. */
export type AttachmentBudget = null | 'user' | 'global';

/**
 * Занять место в суточном бюджете на вложение.
 *
 * Считается ОДИН раз на разбираемое вложение — то есть один раз на пачку, а не
 * на каждый её снимок: замок альбома берётся раньше.
 *
 * Личный счёт проверяется первым, общий вторым и только если личный прошёл:
 * отбитое сообщение не должно съедать канал. Сбой базы — пропускаем: лишний
 * скачанный файл дешевле, чем «Быстрый ответ» который перестал работать у всех
 * из-за одной недоступной записи.
 */
export async function claimAttachmentBudget(tgId: number): Promise<AttachmentBudget> {
  try {
    const key = ATTACH_DAY_KEY(tgId);
    const mine = await redis.incr(key);
    if (mine === 1) await redis.expire(key, DAY_SEC);
    if (mine > config.attachmentsPerDay) return 'user';

    const all = ATTACH_DAY_ALL_KEY();
    const total = await redis.incr(all);
    if (total === 1) await redis.expire(all, DAY_SEC);
    if (total > config.attachmentsPerDayGlobal) {
      console.error(
        `[support][ai] суточный потолок канала на вложения исчерпан (${config.attachmentsPerDayGlobal})`,
      );
      return 'global';
    }
    return null;
  } catch (err) {
    console.error('[support][ai] attachment budget failed:', err);
    return null;
  }
}

/**
 * Считать ли ЭТО сообщение пачки отдельным обращением для минутного лимита.
 *
 * Пачка — это одно действие человека, а лимит стоит на действиях. Считая
 * каждое обновление, мы съедали весь минутный запас (`rateLimitPerMinute` = 10)
 * ровно тем альбомом, на который сами же отвечаем «пришлите нужный снимок
 * отдельным сообщением»: следующее сообщение оказывалось одиннадцатым и
 * получало «Слишком много сообщений». Совет и отказ его выполнить шли подряд.
 *
 * Первое сообщение пачки считается обычным, следующие девять — бесплатны
 * (больше десяти Telegram в альбом не кладёт). Всё сверх этого снова считается:
 * `media_group_id` присваивает Telegram, но опираться на это как на защиту от
 * потока нельзя.
 *
 * Сбой базы — считаем: лимит должен ошибаться в сторону строгости.
 */
export async function albumCountsAsMessage(tgId: number, groupId: string): Promise<boolean> {
  const key = `support:aialbumrate:${tgId}:${groupId}`;
  try {
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, ALBUM_TTL_SEC);
    return n === 1 || n > ALBUM_FREE_MESSAGES;
  } catch (err) {
    console.error('[support][ai] album rate mark failed:', err);
    return true;
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
 *
 * `image` — data:-адрес картинки (скриншот клиента или кадр из видео). Поле
 * необязательное и устроено ровно как в кабинете: ручка кладёт его в то же
 * сообщение переписки, а собирает части для модели `askSupport` на сайте.
 * Второго пути к модели у картинок нет намеренно — он разошёлся бы с
 * кабинетом. Размер сюда приходит уже проверенным (`lib/attachments.ts`);
 * если он всё же велик, ручка отвечает 413, и это обычная неудача: сообщение
 * человека уедет оператору, а не пропадёт.
 *
 * `display` — как ту же реплику показать ЧЕЛОВЕКУ. Вопрос по вложению собран
 * нами: там служебная обвязка, границы файла и обращение к модели на «ты».
 * Переписка общая с кабинетом, и без этого поля человек, приславший в бот
 * скриншот, открывал чат на сайте и видел в СВОЁМ пузыре текст, который писали
 * не он и не про него, — заодно получая готовую карту наших границ и дословную
 * формулировку защиты. Модель по-прежнему читает `text`: проверка на внедрение
 * стоит на нём, и разводить эти два текста дальше показа нельзя.
 */
export async function askProxysAi(
  tgId: number,
  text: string,
  opts: { reset?: boolean; image?: string; display?: string } = {},
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
      body: JSON.stringify({
        telegramId: tgId,
        text,
        reset: opts.reset === true,
        // Поле кладём только когда картинка есть: `image: undefined` в JSON
        // превратилось бы в отсутствие поля и так, но явное условие говорит
        // читателю, что обычный текстовый вопрос ходит ровно как раньше.
        ...(opts.image ? { image: opts.image } : {}),
        // То же и с `display`: обычный набранный руками вопрос человек видит
        // ровно таким, каким его читает модель, и подменять там нечего.
        ...(opts.display ? { display: opts.display } : {}),
      }),
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
  /**
   * Человеческий вид реплики, если он отличается от того, что читала модель.
   *
   * Вопрос по вложению собирает `composeQuestion`: там служебная обвязка,
   * границы файла и обращение к модели на «ты». Оператору нужна не она, а то,
   * что человек прислал на самом деле, — иначе в тикете под значком 👤 стоят
   * 700 знаков нашей же инструкции вместо содержимого файла.
   */
  display?: unknown;
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
        // `display` главнее: см. поле в StoredMessage.
        const shown = typeof m.display === 'string' && m.display.trim() ? m.display : m.text;
        const body = typeof shown === 'string' ? shown.trim() : '';
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
