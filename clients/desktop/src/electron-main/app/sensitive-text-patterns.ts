/**
 * Token/secret/bearer/api-key patterns shared by two independent redaction
 * paths: `logger.ts`'s `redactLogText` (single log lines, capped at 1,000
 * chars) and `support-scrubber.ts`'s `scrubSupportText` (full log tails and
 * diagnostic payloads, never truncated - ticket 09). Both need the exact same
 * detection rules; a single source here is what keeps them from drifting
 * apart as patterns are tuned.
 */

export const SENSITIVE_KEY_PATTERN =
  /(?:token|secret|password|authorization|cookie|credential|verifier|refresh|bearer|api[_-]?key|client[_-]?secret)/i;

export const SENSITIVE_QUERY_PARAM_PATTERN =
  /([?&](?:access_token|refresh_token|id_token|token|code|code_verifier|password|secret|client_secret|api_key|authorization)=)([^&#\s]+)/gi;

export const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

export const SENSITIVE_INLINE_VALUE_PATTERN =
  /(\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|code[_-]?verifier|password|secret|client[_-]?secret|api[_-]?key|authorization|cookie|credential)\b\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}&]+)/gi;

/**
 * Scrubber-only strengthening (ticket 09 code review, finding #3) - NOT used
 * by `logger.ts`, so `redactLogText`'s runtime behavior stays exactly as
 * before. Same sensitive-key set as {@link SENSITIVE_INLINE_VALUE_PATTERN}
 * above, but additionally tolerates a quote character sitting between the
 * key word and the `:`/`=` separator - JSON/YAML-style `"password": "value"`
 * has a closing key-quote right there, which the plain pattern's `\s*[:=]`
 * does not skip past, so it silently fails to match quoted-key forms.
 */
export const QUOTED_SENSITIVE_INLINE_VALUE_PATTERN =
  /(\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|code[_-]?verifier|password|secret|client[_-]?secret|api[_-]?key|authorization|cookie|credential)\b\s*["'`]?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}&]+)/gi;

/**
 * Scrubber-only, mirrors {@link BEARER_PATTERN} for HTTP Basic auth: an
 * unquoted `Authorization: Basic <base64>` header value has a whitespace
 * between "Basic" and its base64 payload, so the bare (unquoted) branch of
 * the inline-value patterns above - which stops at the first whitespace -
 * would otherwise redact only the word "Basic" and leave the actual
 * credential intact right after it.
 */
// Require a plausibly encoded payload rather than any word after "Basic".
// Support reports scrub user prose too, so a broad match would corrupt text
// such as "Basic setup fails" even though it is not an auth header.
export const BASIC_AUTH_PATTERN =
  /\bBasic\s+(?=[A-Za-z0-9+/=]{16,}(?![A-Za-z0-9+/=]))(?![A-Za-z]+(?![A-Za-z0-9+/=]))[A-Za-z0-9+/=]+/gi;

/**
 * Scrubber-only, redacts the TOKEN ITSELF wherever it appears in free text -
 * no key/assignment context required (code review, finding N2, P1): a naked
 * high-entropy API key pasted directly into user-typed intent text matches
 * none of the key=value/quoted-key/bearer patterns above, since there is no
 * key at all around it. Every alternative anchors on a real provider's
 * fixed, published token prefix (Anthropic, OpenAI-style, GitHub, Slack,
 * AWS, Google, Stripe, JWT, npm) - never a bare long hex/base64 run, which
 * the same review round explicitly ruled out as too false-positive-prone.
 * `\b` on both ends keeps this from firing inside an ordinary word that
 * happens to contain one of these short prefixes (e.g. "task-runner",
 * "risk-adjusted" never match - the letter immediately before the prefix is
 * a word character too, so there is no boundary there); the `{n,}` minimum
 * length on every open-ended alternative rules out short coincidental hits.
 */
export const TOKEN_SHAPE_PATTERN =
  /\b(?:sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|gh[oprsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|(?:sk|rk)_live_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|npm_[A-Za-z0-9]{20,})\b/gi;
