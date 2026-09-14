// lib/redact.ts
//
// Hide access keys in client text before it travels beyond the ticket topic.
//
// A subscription link IS the access: whoever has it can connect. People paste
// their own link into support ("here is my link, it does not work"), and until
// 14.09.2026 it was stored verbatim in `lastClientText`. From there it went to
// the operator's personal ping, into the model's question for the stale-ticket
// auto-answer, and into the site conversation the AI endpoint appends to.
// Audit BS-7.
//
// The ticket topic itself is deliberately left untouched: the operator needs the
// real link to check it. The mask applies only to the copy that travels further.
//
// The link's shape stays visible, so the text still says what it was about. The
// rules follow the site's export redaction (`redact` in src/lib/support-export.ts),
// except its dashed-UUID rule: see `maskSubscriptionLinks`.

const KEY_MASK = '<ключ скрыт>';
const LINK_MASK = '<ссылка скрыта>';

/**
 * A ready proxy config. In `vless://<uuid>@<host>:<port>?pbk=…` every field is
 * part of the key, and node addresses must not be published, so the whole URI
 * goes.
 */
const PROXY_URI_RE = /\b(?:vless|vmess|trojan|ss|hy2|hysteria2|tuic):\/\/\S+/gi;

/**
 * Happ deep links: `happ://add/<subscription URL>` and `happ://crypt4/<base64>`
 * (the /p/<token> page redirects to the latter). Both carry the whole
 * subscription. `happ://routing/…` is our shared routing profile with nothing
 * personal in it, so it stays: it shows which profile the person has.
 *
 * `(?!<)` skips text that is already masked. The mask contains a space, so
 * without it a second pass (the cron masks legacy records, and new records are
 * masked on write) would append a second « скрыта>» tail.
 */
const HAPP_LINK_RE = /\bhapp:\/\/(?!routing\/|<)\S+/gi;

/**
 * Site paths whose last segment is the subscription token: the subscription
 * itself (/api/sub), the Happ import page (/p), the add page (/add) and the QR
 * image (/api/qr). Token shape as the site checks it (TOKEN_RE in
 * src/lib/sub-token-lookup.ts): eight characters or more. Case-insensitive:
 * a phone keyboard or a retyped link turns /api/sub into /API/SUB.
 */
const TOKEN_PATH_RE = /(\/(?:api\/sub|api\/qr|p|add)\/)[A-Za-z0-9_-]{8,}/gi;

/**
 * A subscription token pasted without the link: 32 hex characters in a row, as
 * the site issues them (`randomBytes(16).toString('hex')` in src/lib/accounts.ts).
 * Same rule as the site export. A dashed UUID never has 32 hex characters in a
 * row, so YooKassa payment ids are not touched.
 */
const BARE_HEX_TOKEN_RE = /\b[0-9a-f]{32}\b/gi;

/**
 * The text with subscription links and bare tokens masked. Everything else is
 * unchanged.
 *
 * Dashed UUIDs are NOT masked, unlike the site export: people send YooKassa
 * payment ids in that shape («оплатил, платёж 22e12f66-…»), and the operator
 * ping and the model question lose their point without them.
 *
 * Order matters: a Happ deep link contains a plain subscription URL, so it must
 * be removed whole before the path mask leaves a fragment like
 * `happ://add/https://…/api/sub/<ключ скрыт>`.
 */
export function maskSubscriptionLinks(text: string): string {
  if (typeof text !== 'string' || text === '') return '';
  return text
    .replace(PROXY_URI_RE, LINK_MASK)
    .replace(HAPP_LINK_RE, `happ://${LINK_MASK}`)
    .replace(TOKEN_PATH_RE, `$1${KEY_MASK}`)
    .replace(BARE_HEX_TOKEN_RE, KEY_MASK);
}
