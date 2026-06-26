export const DIAGNOSTICS_REDACTION_POLICY_VERSION = "diagnostics-redaction-v1";

const SENSITIVE_QUERY_PARAM_PATTERN =
  /([?&](?:access_token|refresh_token|id_token|token|code|code_verifier|password|secret|client_secret|api_key|authorization)=)([^&#\s]+)/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const SENSITIVE_INLINE_VALUE_PATTERN =
  /(\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|code[_-]?verifier|password|secret|client[_-]?secret|api[_-]?key|authorization|cookie|credential)\b\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}&]+)/gi;
const PRIVATE_KEY_BEGIN_PREFIX = "-----BEGIN ";
const PRIVATE_KEY_END_PREFIX = "-----END ";
const PRIVATE_KEY_SUFFIX = "PRIVATE KEY-----";

export function redactDiagnosticsText(value: string): string {
  return redactSensitiveHeaders(redactPrivateKeyBlocks(value))
    .replace(SENSITIVE_QUERY_PARAM_PATTERN, "$1<redacted>")
    .replace(BEARER_PATTERN, "Bearer <redacted>")
    .replace(SENSITIVE_INLINE_VALUE_PATTERN, "$1<redacted>");
}

/**
 * Redact a byte-window log tail. When a log is collected by tailing the last N
 * bytes the window can begin mid-line, slicing the leading bytes (e.g. an
 * `Authorization:`/`Cookie:` header name) off the first line. Header redaction
 * only acts on complete header lines, so such a split header value would survive
 * `redactDiagnosticsText`. Drop everything up to and including the first newline
 * before redacting so only whole lines are emitted; callers pass
 * `truncated=false` for whole-file reads to keep the first line intact.
 */
export function redactDiagnosticsLogTail(
  rawTail: string,
  truncated: boolean,
): string {
  const wholeLines = truncated ? dropPartialFirstLine(rawTail) : rawTail;
  return redactDiagnosticsText(redactTruncatedPrivateKeyFragments(wholeLines));
}

function dropPartialFirstLine(value: string): string {
  const newlineIndex = value.indexOf("\n");
  return newlineIndex === -1 ? "" : value.slice(newlineIndex + 1);
}

function redactSensitiveHeaders(value: string): string {
  let redacted = "";
  let lineStart = 0;

  while (lineStart < value.length) {
    const newlineIndex = value.indexOf("\n", lineStart);
    if (newlineIndex === -1) {
      redacted += redactSensitiveHeaderLine(value.slice(lineStart));
      break;
    }

    const hasCarriageReturn =
      newlineIndex > lineStart && value.charCodeAt(newlineIndex - 1) === 13;
    const lineEnd = hasCarriageReturn ? newlineIndex - 1 : newlineIndex;
    redacted += redactSensitiveHeaderLine(value.slice(lineStart, lineEnd));
    redacted += value.slice(lineEnd, newlineIndex + 1);
    lineStart = newlineIndex + 1;
  }

  return redacted;
}

function redactSensitiveHeaderLine(value: string): string {
  let headerStart = 0;
  while (
    headerStart < value.length &&
    isHorizontalWhitespace(value[headerStart])
  ) {
    headerStart += 1;
  }

  const colonIndex = value.indexOf(":", headerStart);
  if (colonIndex === -1) return value;

  const headerName = value.slice(headerStart, colonIndex).trim().toLowerCase();
  if (!isSensitiveHeaderName(headerName)) return value;

  let valueStart = colonIndex + 1;
  while (
    valueStart < value.length &&
    isHorizontalWhitespace(value[valueStart])
  ) {
    valueStart += 1;
  }

  return `${value.slice(0, valueStart)}<redacted>`;
}

function isSensitiveHeaderName(value: string): boolean {
  return (
    value === "authorization" ||
    value === "proxy-authorization" ||
    value === "cookie" ||
    value === "set-cookie"
  );
}

function isHorizontalWhitespace(value: string | undefined): boolean {
  return value === " " || value === "\t";
}

function redactPrivateKeyBlocks(value: string): string {
  let redacted = "";
  let cursor = 0;

  while (cursor < value.length) {
    const beginIndex = value.indexOf(PRIVATE_KEY_BEGIN_PREFIX, cursor);
    if (beginIndex === -1) {
      redacted += value.slice(cursor);
      break;
    }

    const typeStart = beginIndex + PRIVATE_KEY_BEGIN_PREFIX.length;
    const beginMarkerEnd = value.indexOf(PRIVATE_KEY_SUFFIX, typeStart);
    if (beginMarkerEnd === -1) {
      redacted += value.slice(cursor);
      break;
    }

    const keyType = value.slice(typeStart, beginMarkerEnd);
    if (!isPrivateKeyType(keyType)) {
      const nextCursor = beginIndex + PRIVATE_KEY_BEGIN_PREFIX.length;
      redacted += value.slice(cursor, nextCursor);
      cursor = nextCursor;
      continue;
    }

    const endMarker = `${PRIVATE_KEY_END_PREFIX}${keyType}${PRIVATE_KEY_SUFFIX}`;
    const endIndex = value.indexOf(
      endMarker,
      beginMarkerEnd + PRIVATE_KEY_SUFFIX.length,
    );
    if (endIndex === -1) {
      redacted += value.slice(cursor);
      break;
    }

    redacted += `${value.slice(cursor, beginIndex)}<redacted-private-key>`;
    cursor = endIndex + endMarker.length;
  }

  return redacted;
}

function redactTruncatedPrivateKeyFragments(value: string): string {
  return redactTrailingPartialPrivateKeyBlock(
    redactLeadingPartialPrivateKeyBlock(value),
  );
}

function redactLeadingPartialPrivateKeyBlock(value: string): string {
  const firstBeginIndex = value.indexOf(PRIVATE_KEY_BEGIN_PREFIX);
  const firstEndMarker = findPrivateKeyEndMarker(value, 0);
  if (firstEndMarker === null) return value;
  if (firstBeginIndex !== -1 && firstBeginIndex < firstEndMarker.start) {
    return value;
  }
  return `<redacted-private-key>${value.slice(firstEndMarker.end)}`;
}

function redactTrailingPartialPrivateKeyBlock(value: string): string {
  let cursor = 0;
  while (cursor < value.length) {
    const beginMarker = findPrivateKeyBeginMarker(value, cursor);
    if (beginMarker === null) return value;

    const endMarker = `${PRIVATE_KEY_END_PREFIX}${beginMarker.keyType}${PRIVATE_KEY_SUFFIX}`;
    const endIndex = value.indexOf(endMarker, beginMarker.end);
    if (endIndex === -1) {
      return `${value.slice(0, beginMarker.start)}<redacted-private-key>`;
    }
    cursor = endIndex + endMarker.length;
  }
  return value;
}

function findPrivateKeyBeginMarker(
  value: string,
  startIndex: number,
): {
  readonly start: number;
  readonly end: number;
  readonly keyType: string;
} | null {
  let cursor = startIndex;
  while (cursor < value.length) {
    const markerStart = value.indexOf(PRIVATE_KEY_BEGIN_PREFIX, cursor);
    if (markerStart === -1) return null;

    const typeStart = markerStart + PRIVATE_KEY_BEGIN_PREFIX.length;
    const markerEnd = value.indexOf(PRIVATE_KEY_SUFFIX, typeStart);
    if (markerEnd === -1) return null;

    const keyType = value.slice(typeStart, markerEnd);
    const end = markerEnd + PRIVATE_KEY_SUFFIX.length;
    if (isPrivateKeyType(keyType)) {
      return { start: markerStart, end, keyType };
    }
    cursor = typeStart;
  }
  return null;
}

function findPrivateKeyEndMarker(
  value: string,
  startIndex: number,
): { readonly start: number; readonly end: number } | null {
  let cursor = startIndex;
  while (cursor < value.length) {
    const markerStart = value.indexOf(PRIVATE_KEY_END_PREFIX, cursor);
    if (markerStart === -1) return null;

    const typeStart = markerStart + PRIVATE_KEY_END_PREFIX.length;
    const markerEnd = value.indexOf(PRIVATE_KEY_SUFFIX, typeStart);
    if (markerEnd === -1) return null;

    const keyType = value.slice(typeStart, markerEnd);
    const end = markerEnd + PRIVATE_KEY_SUFFIX.length;
    if (isPrivateKeyType(keyType)) {
      return { start: markerStart, end };
    }
    cursor = typeStart;
  }
  return null;
}

function isPrivateKeyType(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    const isUpperAlpha = code >= 65 && code <= 90;
    const isDigit = code >= 48 && code <= 57;
    if (!isUpperAlpha && !isDigit && char !== " " && char !== "-") {
      return false;
    }
  }
  return true;
}
