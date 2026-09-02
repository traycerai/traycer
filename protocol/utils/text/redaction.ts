/**
 * The single credential-detection leaf for every redaction path in both
 * repos.
 *
 * This is a security control, not a formatting helper: the detection set must
 * not differ by call site. Before this module the same patterns existed in
 * four hand-synced copies (the desktop's `sensitive-text-patterns.ts`,
 * `packages/common/src/sentry/scrub.ts`, the host's
 * `providers/native-config/redact.ts`, and the desktop logger), and they had
 * already drifted - only one of them knew `Cookie:` headers, Digest
 * `response=` and AWS4 `Signature=`, so whether a session cookie left the
 * machine depended on which writer happened to render it. `@traycer/protocol`
 * is the one package the internal monorepo and the OSS clients can both
 * reach, so the detection rules live here and nowhere else.
 *
 * Detection rules only. Length caps, depth limits, path pseudonymization,
 * hook installation and Sentry event shaping are per-consumer policy and stay
 * with the consumer - nothing here classifies a pattern by who uses it.
 */

/** Keys whose value is never useful in a report and always sensitive. */
export const SENSITIVE_KEY_PATTERN =
  /(?:token|secret|password|authorization|cookie|credential|verifier|refresh|bearer|api[_-]?key|client[_-]?secret|signature)/i;

/**
 * Query parameters carrying a credential: the OAuth set, the URL-signature
 * families the browser plane hands around - `sig`/`signature` (Azure SAS,
 * generic HMAC links), `X-Amz-Signature`/`X-Amz-Credential`/
 * `X-Amz-Security-Token` (S3 presigned URLs), a bare `jwt` - and the plain
 * `key=` remote-MCP endpoints use. The rest of a SAS or presigned tuple
 * (`se`, `sp`, `sv`, `sr`) is deliberately left alone: it is expiry/permission
 * metadata, not the secret, and those two-letter names collide with ordinary
 * application parameters often enough that matching them would redact more
 * signal than risk.
 */
const SENSITIVE_QUERY_PARAM_PATTERN =
  /([?&](?:access_token|refresh_token|id_token|token|code|code_verifier|password|secret|client_secret|api_key|apikey|authorization|jwt|key|sig|signature|x-amz-signature|x-amz-credential|x-amz-security-token)=)([^&#\s]+)/gi;

/**
 * `https://user:pass@host` and `https://token@host` - strip the userinfo.
 * The password half is optional (password-less userinfo is the token form).
 */
const URL_USERINFO_PATTERN = /(https?:\/\/)([^/\s@]+@)/gi;

/**
 * Cookie / Set-Cookie header values (session cookies, auth cookies). Redacts
 * the full header value through the rest of the field (stops at newline or
 * the multi-field `|` separator common in log lines).
 *
 * Deliberately does NOT stop at `,` or `;`: real cookies are `;`-joined
 * multi-pair (`a=1; b=2`), Set-Cookie attributes use commas (`Expires=Wed,
 * 21 Oct ...`), and some loggers naively comma-join multiple Set-Cookie
 * instances. An early comma-stop under-redacted a second secret. Prefer
 * over-redacting adjacent log fields over leaking cookie material.
 */
const COOKIE_HEADER_PATTERN =
  /(\b(?:Set-Cookie|Cookie)\b\s*[=:]\s*)([^\r\n|]+)/gi;

/**
 * Quoted-JSON Cookie / Set-Cookie keys: `"Cookie": "session=..."`. The
 * unquoted header pattern never sees the quotes around the key/value.
 */
const QUOTED_JSON_COOKIE_PATTERN =
  /((?:["'])(?:Set-Cookie|Cookie)(?:["'])\s*:\s*)(["'])([^"']*)\2/gi;

/**
 * Authorization-style headers, quoted or unquoted VALUE. Keep the optional
 * scheme, redact the credential. The scheme is matched generically (`Basic`, `Bearer`, `Digest`,
 * GitHub's `token`, ...): enumerating schemes meant an unlisted one was
 * consumed as the credential, leaving the real secret in place
 * (`authorization: token ghs_x` -> `authorization: <redacted> ghs_x`). A
 * scheme only counts when another token follows it, so a scheme-less
 * `Authorization: abc123` still redacts `abc123`. Stops at whitespace/common
 * field delimiters so a multi-secret single log line is not wiped after the
 * first Authorization.
 */
const AUTHORIZATION_HEADER_PATTERN =
  /((?<!["'])\b(?:Proxy-Authorization|Authorization|X-Api-Key|X-Auth-Token)\b\s*["'`]?\s*[=:]\s*)(?:([A-Za-z][A-Za-z0-9._-]*)\s+)?("[^"]*"|'[^']*'|[^\s,;}|&"']+)/gi;

/**
 * Quoted key, UNQUOTED value: `{"authorization": ghs_...}`. Neither sibling
 * sees it - the quoted-JSON pattern requires quotes on both sides, and the
 * header pattern's lookbehind (which is what keeps it from re-consuming an
 * already-redacted quoted value) excludes a quoted key by construction.
 */
const QUOTED_KEY_AUTHORIZATION_PATTERN =
  /((?:["'])(?:Proxy-Authorization|Authorization|X-Api-Key|X-Auth-Token)(?:["'])\s*:\s*)(?:([A-Za-z][A-Za-z0-9._-]*)\s+)?([^\s,;}|&"']+)/gi;

/**
 * Quoted-JSON Authorization-style keys: `"Authorization": "Bearer x"` /
 * `"Authorization":"token ghs_..."`. Same generic-scheme rule as the header
 * pattern.
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

/**
 * Mirrors {@link BEARER_PATTERN} for HTTP Basic auth: an unquoted
 * `Authorization: Basic <base64>` value has whitespace between "Basic" and
 * its payload, so the bare branch of the inline-value pattern below - which
 * stops at the first whitespace - would otherwise redact only the word
 * "Basic" and leave the credential right after it. A plausibly encoded
 * payload is required rather than any word: support reports scrub user prose
 * too, and a broad match would corrupt text such as "Basic setup fails".
 */
const BASIC_AUTH_PATTERN =
  /\bBasic\s+(?=[A-Za-z0-9+/=]{16,}(?![A-Za-z0-9+/=]))(?![A-Za-z]+(?![A-Za-z0-9+/=]))[A-Za-z0-9+/=]+/gi;

/**
 * `key: value` / `key=value` for a sensitive key word, tolerating a quote
 * character between the key word and the separator - JSON/YAML `"password":
 * "value"` has a closing key-quote right there, which a plain `\s*[:=]` does
 * not skip past.
 */
const SENSITIVE_INLINE_VALUE_PATTERN =
  /(\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|code[_-]?verifier|password|secret|client[_-]?secret|api[_-]?key|cookie|credential|signature)\b\s*["'`]?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}&]+)/gi;

/**
 * Session cookies, which are bearer credentials none of the patterns above
 * match: a log line or a `browser-trace.jsonl` record naming `csrftoken=...`
 * or `sessionid=...` carries a live session and reads as ordinary text.
 * Replaying one is a full account takeover.
 *
 * CASE-SENSITIVE, and that is the whole point of the spelling below. Matching
 * case-insensitively also ate Traycer's own camelCase `"sessionId"` - a field
 * on nearly every trace and telemetry line - which destroyed support-bundle
 * correlation while protecting nothing: no cookie is ever named `sessionId`.
 * What is listed is each real cookie's real casing.
 *
 * The name list is CLOSED rather than a `*session*` wildcard for the same
 * reason: a wildcard also eats `sessionAnchor`, `sessionCount` and every
 * other diagnostic field whose name contains the word, and a scrubber that
 * corrupts a bug report is a scrubber people work around.
 *
 * One pattern, not a quoted/unquoted pair: the quote between the name and the
 * separator is optional here, so the bare `sessionid=abc` and the serialized
 * `{"sessionid": "abc"}` forms are the same match and no consumer can apply
 * half of the rule.
 *
 * The left edge is a lookbehind rather than `\b`, because `_` is a word
 * character: `\b` never fires at the start of `_acme_session=`, which is the
 * exact spelling Rails and Django hand out.
 */
const SESSION_COOKIE_PATTERN =
  /(?<![A-Za-z0-9._-])((?:csrf[_-]?token|xsrf[_-]?token|session[_-]?id|session[_-]?token|PHPSESSID|JSESSIONID|ASP\.NET_SessionId|connect\.sid|[A-Za-z0-9._-]*_session)\s*["'`]?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}&]+)/g;

/**
 * Redacts the TOKEN ITSELF wherever it appears in free text - no
 * key/assignment context required: a naked high-entropy API key pasted into
 * user-typed intent text matches none of the patterns above, since there is
 * no key around it at all. Every alternative anchors on a real provider's
 * fixed, published prefix (Anthropic, OpenAI-style, GitHub, Slack, AWS,
 * Google, Stripe, JWT, npm) - never a bare long hex/base64 run, which is too
 * false-positive-prone. `\b` on both ends keeps this from firing inside an
 * ordinary word containing one of these short prefixes, and the `{n,}`
 * minimum on every open-ended alternative rules out short coincidental hits.
 */
const TOKEN_SHAPE_PATTERN =
  /\b(?:sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|gh[oprsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|(?:sk|rk)_live_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|npm_[A-Za-z0-9]{20,})\b/gi;

/**
 * KEY=value / "KEY": "value" assign candidates. Every key is matched here;
 * whether it is *sensitive* is decided in `isSensitiveAssignKey` rather than
 * by an alternation inside the pattern.
 *
 * The previous single regex wrapped `[A-Za-z0-9_.-]*` around a stem
 * alternation on BOTH sides. Those two open-ended runs and the stem all match
 * the same characters, so a long key-shaped run with no `=` forces the engine
 * to re-split it at every offset — quadratic, ~2.9s on a 50 KiB log line
 * (1.5ms at 1 KiB, 453ms at 20 KiB). this runs on CLI stderr, which
 * is attacker-influenced in exactly that way. The key is now one unambiguous
 * `[A-Za-z0-9_.-]+` run.
 *
 * Removing the ambiguity was necessary but NOT sufficient: an unbounded run is
 * still rescanned from every offset inside it when the input never satisfies
 * what follows. On a key run with no `=`/`:` anywhere the match fails at each
 * start offset after scanning to the end of the run — measured 172ms at
 * 10 KiB, 702ms at 20 KiB, 11.4s at 80 KiB, a clean 4x per doubling.
 *
 * The lookbehind is what fixes that, by pinning a match to a run's true start:
 * at every interior offset the assertion fails in O(1) instead of rescanning
 * to the end of the run, so one pass stays linear (1ms at 160 KiB).
 *
 * A length cap makes it linear too, and was tried first — but it silently
 * breaks redaction, so it is NOT the fix. Sensitivity is decided from the key,
 * so the key has to arrive whole. Capped at 256, a longer key is classified
 * from its trailing 256 characters only: `TOKEN_<300 chars>=secret` matches
 * with a key of pure padding, tests as non-sensitive, and leaks the value. The
 * quoted form fails worse — the closing `\1` backreference is unreachable past
 * the cap, so nothing matches at all and the value is passed through verbatim.
 */
const ASSIGN_CANDIDATE_PATTERN =
  /(?<![A-Za-z0-9_.-])(["']?)([A-Za-z0-9_.-]+)\1(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;}&"']+)/g;

/**
 * Sensitive key stems, matched as substrings of the normalized key so
 * arbitrary prefixes/suffixes still hit (`OPENAI_API_KEY`, `GITHUB_TOKEN`).
 * `access_token` / `refresh_token` / `id_token` / `client_secret` need no
 * entries of their own — `token` and `secret` already cover them.
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
 * Qualifiers that make a trailing `_tokens` a usage COUNT rather than a
 * credential: `max_tokens=4096`, `cache_read_input_tokens: 12`. Those are the
 * most common numbers in provider CLI diagnostics and redacting them destroys
 * the diagnostic without protecting anything.
 *
 * Enumerated rather than keyed off the plural `tokens`, so an unrecognised
 * `*_tokens` key stays redacted: a miss here costs a diagnostic, never a leak.
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
 * Every credential pattern applied and nothing else: no length cap, no
 * container walking, no path pseudonymization. Those are consumer policy, and
 * folding any of them in here is what made the previous copies unusable
 * outside the one file each was written for.
 *
 * Idempotent: a value already rendered `<redacted>` re-renders to itself, so
 * a call site that scrubs on its own is unaffected by the shared hook that
 * scrubs again.
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
      // Last, and the only pattern that classifies an ARBITRARY key rather
      // than matching an enumerated key word: provider CLIs and app code
      // print `OPENAI_API_KEY=`, `GITHUB_TOKEN=`, `MY_SECRET_TOKEN=` and
      // every other spelling of the same idea. Runs after the enumerated
      // patterns so a value they already redacted is re-redacted to itself
      // rather than losing an auth scheme they deliberately kept.
      .replace(ASSIGN_CANDIDATE_PATTERN, replaceSensitiveAssign)
  );
}

/**
 * A URL reduced to `origin + pathname`. The whole query string is dropped
 * rather than pattern-matched: a signed URL's credential lives in the query,
 * and "which parameters are credentials" is an open set - every CDN and
 * object store names them differently - so the only rule that stays correct
 * as new ones appear is to keep none of them. The fragment goes with it, for
 * the same reason (implicit-flow tokens land there).
 *
 * The non-URL fallback is `redactSensitiveText`, once, here: a relative path,
 * a template or free text has no query to strip, and the three former copies
 * of this function each answered that case differently - one returned the
 * input untouched.
 */
export function reduceUrlToOriginAndPath(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return redactSensitiveText(value);
  }
}

/**
 * A bare query string with no leading `?` - the shape Sentry's
 * `request.query_string` carries. The query-parameter pattern anchors on
 * `?`/`&`, so the FIRST parameter of such a string matched nothing and its
 * credential shipped; scrubbing a `?`-prefixed copy is what gives the first
 * parameter the same delimiter every later one already has.
 */
export function redactQueryString(value: string): string {
  return redactSensitiveText(`?${value}`).slice(1);
}

/**
 * For span attributes that hold either an absolute URL (`url.full`,
 * `http.url`) or a bare request target (`http.target`, e.g.
 * `/v1/pay?token=abc`): cutting at the first `?`/`#` reduces both to origin +
 * path, where {@link reduceUrlToOriginAndPath} would fall through to the text
 * scrubber on the relative one and leave its query behind.
 */
export function reduceRequestTargetToPath(value: string): string {
  const queryStart = value.search(/[?#]/);
  return redactSensitiveText(
    queryStart === -1 ? value : value.slice(0, queryStart),
  );
}
