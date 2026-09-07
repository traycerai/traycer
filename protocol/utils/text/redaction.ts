/**
 * The single credential-detection leaf for every redaction path in both repos.
 * This is a security control, not a formatting helper: the detection set must not differ by call site.
 */

/** Keys whose value is never useful in a report and always sensitive. */
export const SENSITIVE_KEY_PATTERN =
  /(?:token|secret|password|authorization|cookie|credential|verifier|refresh|bearer|api[_-]?key|client[_-]?secret|signature)/i;

const SENSITIVE_QUERY_PARAM_PATTERN =
  /([?&](?:access_token|refresh_token|id_token|token|code|code_verifier|password|secret|client_secret|api_key|apikey|authorization|jwt|key|sig|signature|x-amz-signature|x-amz-credential|x-amz-security-token)=)([^&#\s]+)/gi;

/**
 * `https://user:pass@host` and `https://token@host` - strip the userinfo.
 * The password half is optional (password-less userinfo is the token form).
 */
const URL_USERINFO_PATTERN = /(https?:\/\/)([^/\s@]+@)/gi;

/** Cookie / Set-Cookie header values (session cookies, auth cookies). */
const COOKIE_HEADER_PATTERN =
  /(\b(?:Set-Cookie|Cookie)\b\s*[=:]\s*)([^\r\n|]+)/gi;

/**
 * Quoted-JSON Cookie / Set-Cookie keys: `"Cookie": "session=..."`. The
 * unquoted header pattern never sees the quotes around the key/value.
 */
const QUOTED_JSON_COOKIE_PATTERN =
  /((?:["'])(?:Set-Cookie|Cookie)(?:["'])\s*:\s*)(["'])([^"']*)\2/gi;

/** Authorization-style headers, quoted or unquoted VALUE. */
const AUTHORIZATION_HEADER_PATTERN =
  /((?<!["'])\b(?:Proxy-Authorization|Authorization|X-Api-Key|X-Auth-Token)\b\s*["'`]?\s*[=:]\s*)(?:([A-Za-z][A-Za-z0-9._-]*)\s+)?("[^"]*"|'[^']*'|[^\s,;}|&"']+)/gi;

/** Quoted key, UNQUOTED value: `{"authorization": ghs_...}`. */
const QUOTED_KEY_AUTHORIZATION_PATTERN =
  /((?:["'])(?:Proxy-Authorization|Authorization|X-Api-Key|X-Auth-Token)(?:["'])\s*:\s*)(?:([A-Za-z][A-Za-z0-9._-]*)\s+)?([^\s,;}|&"']+)/gi;

/**
 * Quoted-JSON Authorization-style keys: `"Authorization": "Bearer x"` / `"Authorization":"token ghs_..."`.
 */
const QUOTED_JSON_AUTHORIZATION_PATTERN =
  /((?:["'])(?:Proxy-Authorization|Authorization|X-Api-Key|X-Auth-Token)(?:["'])\s*:\s*)(["'])(?:([A-Za-z][A-Za-z0-9._+-]*)\s+)?([^"']*)\2/gi;

/**
 * Digest auth `response=` field. Authorization redaction only keeps the
 * scheme and first token; multipart Digest leaves `response="..."` intact.
 */
const DIGEST_RESPONSE_PATTERN =
  /(\bresponse\s*=\s*)("[^"]*"|'[^']*'|[^\s,;}&"']+)/gi;

/**
 * AWS4-HMAC-SHA256 `Signature=` tail. Authorization redaction only keeps the
 * scheme and first token (`Credential=...`); the Signature hex remains.
 */
const AWS4_SIGNATURE_PATTERN = /(\bSignature\s*=\s*)([^\s,;}&"']+)/gi;

const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

const BASIC_AUTH_PATTERN =
  /\bBasic\s+(?=[A-Za-z0-9+/=]{16,}(?![A-Za-z0-9+/=]))(?![A-Za-z]+(?![A-Za-z0-9+/=]))[A-Za-z0-9+/=]+/gi;

const SENSITIVE_INLINE_VALUE_PATTERN =
  /(\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|code[_-]?verifier|password|secret|client[_-]?secret|api[_-]?key|cookie|credential|signature)\b\s*["'`]?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}&]+)/gi;

/**
 * Session cookies, which are bearer credentials none of the patterns above match: a log line or a `browser-trace.jsonl` record naming `csrftoken=...` or `sessionid=...` carries a live session and reads as ordinary text.
 * The left edge is a lookbehind rather than `\b`, because `_` is a word character: `\b` never fires at the start of `_acme_session=`, which is the exact spelling Rails and Django hand out.
 */
const SESSION_COOKIE_PATTERN =
  /(?<![A-Za-z0-9._-])((?:csrf[_-]?token|xsrf[_-]?token|session[_-]?id|session[_-]?token|PHPSESSID|JSESSIONID|ASP\.NET_SessionId|connect\.sid|[A-Za-z0-9._-]*_session)\s*["'`]?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}&]+)/g;

/**
 * Redacts the TOKEN ITSELF wherever it appears in free text - no key/assignment context required: a naked high-entropy API key pasted into user-typed intent text matches none of the patterns above, since there is no key.
 * Every alternative anchors on a real provider's fixed, published prefix (Anthropic, OpenAI-style, GitHub, Slack, AWS, Google, Stripe, JWT, npm) - never a bare long hex/base64 run, which is too false-positive-prone.
 */
const TOKEN_SHAPE_PATTERN =
  /\b(?:sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|gh[oprsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|(?:sk|rk)_live_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|npm_[A-Za-z0-9]{20,})\b/gi;

/**
 * KEY=value / "KEY": "value" assign candidates.
 * A length cap makes it linear too, and was tried first - but it silently breaks redaction, so it is NOT the fix.
 */
const ASSIGN_CANDIDATE_PATTERN =
  /(?<![A-Za-z0-9_.-])(["']?)([A-Za-z0-9_.-]+)\1(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;}&"']+)/g;

/**
 * Sensitive key stems, matched as substrings of the normalized key so arbitrary prefixes/suffixes still hit (`OPENAI_API_KEY`, `GITHUB_TOKEN`).
 */
const SENSITIVE_KEY_STEMS = [
  "api_key",
  "apikey",
  "token",
  "secret",
  "password",
  "bearer",
  "credential",
] as const;

/**
 * Qualifiers that make a trailing `_tokens` a usage COUNT rather than a credential: `max_tokens=4096`, `cache_read_input_tokens: 12`.
 * Enumerated rather than keyed off the plural `tokens`, so an unrecognised `*_tokens` key stays redacted: a miss here costs a diagnostic, never a leak.
 */
const TOKEN_COUNT_QUALIFIERS = new Set([
  "max",
  "min",
  "num",
  "input",
  "output",
  "total",
  "prompt",
  "completion",
  "reasoning",
  "cache",
  "cached",
  "used",
  "remaining",
  "budget",
]);

function isTokenCountKey(normalizedKey: string): boolean {
  if (!normalizedKey.endsWith("_tokens")) return false;
  const head = normalizedKey.slice(0, -"_tokens".length);
  const lastSegment = head.split("_").pop() ?? "";
  return TOKEN_COUNT_QUALIFIERS.has(lastSegment);
}

function isSensitiveAssignKey(rawKey: string): boolean {
  // `-` folds to `_` so `API-KEY` and `API_KEY` share one stem list.
  const key = rawKey.toLowerCase().replace(/-/g, "_");
  if (isTokenCountKey(key)) return false;
  return SENSITIVE_KEY_STEMS.some((stem) => key.includes(stem));
}

function replaceSensitiveAssign(
  match: string,
  quote: string,
  key: string,
  separator: string,
): string {
  if (!isSensitiveAssignKey(key)) return match;
  return `${quote}${key}${quote}${separator}${REDACTED}`;
}

const REDACTED = "<redacted>";

function replaceAuthorization(
  _match: string,
  key: string,
  scheme: string | undefined,
): string {
  return scheme === undefined
    ? `${key}${REDACTED}`
    : `${key}${scheme} ${REDACTED}`;
}

function replaceQuotedJsonAuthorization(
  _match: string,
  key: string,
  quote: string,
  scheme: string | undefined,
  rest: string,
): string {
  if (scheme !== undefined && rest.length > 0) {
    return `${key}${quote}${scheme} ${REDACTED}${quote}`;
  }
  return `${key}${quote}${REDACTED}${quote}`;
}

/**
 * Every credential pattern applied and nothing else: no length cap, no container walking, no path pseudonymization.
 * Idempotent: a value already rendered `<redacted>` re-renders to itself, so a call site that scrubs on its own is unaffected by the shared hook that scrubs again.
 */
export function redactSensitiveText(value: string): string {
  return (
    value
      .replace(URL_USERINFO_PATTERN, `$1${REDACTED}@`)
      .replace(SENSITIVE_QUERY_PARAM_PATTERN, `$1${REDACTED}`)
      .replace(COOKIE_HEADER_PATTERN, `$1${REDACTED}`)
      .replace(QUOTED_JSON_COOKIE_PATTERN, `$1$2${REDACTED}$2`)
      .replace(
        QUOTED_JSON_AUTHORIZATION_PATTERN,
        replaceQuotedJsonAuthorization,
      )
      .replace(QUOTED_KEY_AUTHORIZATION_PATTERN, replaceAuthorization)
      .replace(AUTHORIZATION_HEADER_PATTERN, replaceAuthorization)
      .replace(DIGEST_RESPONSE_PATTERN, `$1${REDACTED}`)
      .replace(AWS4_SIGNATURE_PATTERN, `$1${REDACTED}`)
      .replace(BEARER_PATTERN, `Bearer ${REDACTED}`)
      .replace(BASIC_AUTH_PATTERN, `Basic ${REDACTED}`)
      .replace(SENSITIVE_INLINE_VALUE_PATTERN, `$1${REDACTED}`)
      .replace(SESSION_COOKIE_PATTERN, `$1${REDACTED}`)
      // A naked high-entropy key has no key/assignment context for any of the
      // above to anchor on; this matches the token itself.
      .replace(TOKEN_SHAPE_PATTERN, REDACTED)
      .replace(ASSIGN_CANDIDATE_PATTERN, replaceSensitiveAssign)
  );
}

/** A URL reduced to `origin + pathname`. */
export function reduceUrlToOriginAndPath(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return redactSensitiveText(value);
  }
}

/** A bare query string with no leading `?` - the shape Sentry's `request.query_string` carries. */
export function redactQueryString(value: string): string {
  return redactSensitiveText(`?${value}`).slice(1);
}

/**
 * For span attributes that hold either an absolute URL (`url.full`, `http.url`) or a bare request target (`http.target`, e.g.
 */
export function reduceRequestTargetToPath(value: string): string {
  const queryStart = value.search(/[?#]/);
  return redactSensitiveText(
    queryStart === -1 ? value : value.slice(0, queryStart),
  );
}
