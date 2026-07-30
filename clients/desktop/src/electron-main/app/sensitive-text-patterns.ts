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
export const BASIC_AUTH_PATTERN = /\bBasic\s+[A-Za-z0-9+/=]+/gi;
