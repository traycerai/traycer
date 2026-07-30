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
