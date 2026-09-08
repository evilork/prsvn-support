// lib/config.ts

/** Целое из окружения; мусор и ноль — значит умолчание, а не «выключено». */
function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

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

/**
 * Владелец: кому первому показывают новые экраны бота.
 *
 * Число здесь, а не только в переменной окружения, намеренно. Правило проекта —
 * новое выкатывать сначала на владельца, а запор, который перестаёт работать
 * стоит забыть переменную в настройках проекта, — это не запор. Забыли
 * переменную — кнопку видит один человек, а не все.
 *
 * Он же единственный админ бота (SUPPORT_ADMIN_USER_IDS), а админ и клиент в
 * этом боте — разные ветки. Чтобы «сначала владельцу» не означало «никому», в
 * handler есть две оговорки: команда /ai включает режим помощника из админской
 * ветки, а клиентские кнопки (⚡, 🆘, разделы FAQ) разбираются до развилки. Без
 * них допущенный человек физически не может вызвать то, что ему открыто.
 */
const OWNER_USER_ID = 6944217115;

/**
 * Кому показана кнопка «Быстрый ответ».
 *
 * С 08.09.2026 по умолчанию — ВСЕМ. До этого умолчанием был один владелец:
 * так требует правило проекта, новые экраны бота сперва обкатываются на нём.
 * Обкатка состоялась в тот же день: живой вопрос прошёл весь путь до модели
 * за 9,4 секунды и вернулся осмысленным ответом, после чего владелец сказал
 * открывать всем.
 *
 * Умолчание перевёрнуто, а не заменено переменной, намеренно: «открыто всем»
 * не должно зависеть от значения, которое можно потерять при переносе
 * проекта. Сузить по-прежнему можно без выката — списком идентификаторов в
 * `SUPPORT_AI_USER_IDS`, а погасить целиком проще всего рубильником
 * `SUPPORT_CHAT_OFF` на стороне сайта: он гасит помощника и в кабинете, и
 * здесь, одним значением.
 *
 * `all`, `*` или пусто — все. Список чисел — только они.
 */
function parseAiAccess(): { everyone: boolean; ids: readonly number[] } {
  const raw = (process.env.SUPPORT_AI_USER_IDS || '').trim();
  if (!raw) return { everyone: true, ids: [] };
  if (raw === '*' || raw.toLowerCase() === 'all') return { everyone: true, ids: [] };

  const ids = raw
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);

  // Переменная задана, но не разобралась (опечатка, чужой формат) — считаем,
  // что запор на месте. Пустой список означал бы «никому», и кнопка пропала бы
  // у владельца ровно тогда, когда он её и проверяет.
  return { everyone: false, ids: ids.length > 0 ? ids : [OWNER_USER_ID] };
}

const aiAccess = parseAiAccess();

/**
 * Общий ключ к внутренним ручкам сайта — то же значение, что в окружении
 * сайта.
 *
 * Без него быстрый ответ невозможен, поэтому кнопка не рисуется вовсе.
 * Запасного варианта («если нет ключа, возьмём токен бота») здесь нет
 * намеренно: однажды такая подстановка уже сломала создание устройств из бота,
 * потому что обе стороны компилировались, но читали разные переменные.
 */
const internalApiKey = (process.env.INTERNAL_API_KEY || '').trim();

export const config = {
  botToken: required('SUPPORT_BOT_TOKEN'),
  webhookSecret: required('SUPPORT_BOT_WEBHOOK_SECRET'),
  adminUserIds: parseAdminIds(),
  groupId,
  forumMode: groupId !== null,

  rateLimitPerMinute: 10,

  /**
   * Сколько вложений в сутки бот скачивает для одного телеграма.
   *
   * Лимиты ручки сайта считают ОБРАЩЕНИЯ К МОДЕЛИ, а скачивание файла до
   * ручки даже не доходит: отбитое по суточной квоте сообщение всё равно
   * тянуло мегабайт из Telegram, кодировало его в base64 и заливало 1,33 МБ в
   * наш же вебхук. Одноразовому телеграму без кабинета положено 5 обращений к
   * модели в сутки — остальные тысячи скачиваний в тот же день оплачивались
   * нами при нулевой выручке, и остановить их было нечем: SUPPORT_CHAT_OFF
   * гасит модель, а не скачивание.
   *
   * Двадцать — это вчетверо больше самого длинного живого разбора со
   * скриншотами и вдвое больше самой длинной пачки, которую кладёт Telegram.
   */
  attachmentsPerDay: envInt('SUPPORT_ATTACH_DAILY', 20),

  /**
   * То же на ВЕСЬ канал за сутки.
   *
   * Личный потолок ограничивает одного человека, а платим мы за всех: двести
   * заведённых за минуту телеграмов дают четыре тысячи скачиваний, и каждый —
   * трафик из Telegram плюс треть сверху в вебхук.
   */
  attachmentsPerDayGlobal: envInt('SUPPORT_ATTACH_DAILY_GLOBAL', 600),

  pageSize: 10,
  ticketDataTtlSec: 60 * 60 * 24 * 180,

  siteUrl: process.env.SITE_URL || 'https://proxysvpn.com',
  dashboardUrl: process.env.DASHBOARD_URL || 'https://proxysvpn.com/dashboard',
  guideUrl: process.env.GUIDE_URL || 'https://proxysvpn.com/guide',
  mainBotUrl: process.env.MAIN_BOT_URL || 'https://t.me/proxysvpn_bot',

  internalApiKey,
  aiAccess,
} as const;

export function isAdmin(userId: number): boolean {
  return config.adminUserIds.includes(userId);
}

/**
 * Показывать ли этому человеку «Быстрый ответ».
 *
 * Два условия, и оба обязательны: ключ к сайту настроен и человек допущен.
 * Порядок важен — без ключа кнопка не появляется НИ У КОГО, включая владельца:
 * кнопка, которая отвечает «недоступно», хуже её отсутствия.
 */
export function aiQuickAnswerEnabled(userId: number): boolean {
  if (!config.internalApiKey) return false;
  if (config.aiAccess.everyone) return true;
  return config.aiAccess.ids.includes(userId);
}
