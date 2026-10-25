const FALLBACK_TIME_ZONE = "UTC";

/**
 * The viewer's IANA zone, sent on every `host.usage.summary` request so day
 * bucketing lands on the reader's calendar days rather than the host's.
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` is not always a string:
 * V8 (Electron, Chromium WebViews) reports `undefined` when the machine's
 * zone is one ICU cannot name, so anything but a non-empty string falls back
 * to UTC (the request schema requires a non-empty zone - see
 * `hostUsageSummaryRequestSchemaV10`).
 */
export function getViewerTimeZone(): string {
  const resolved: unknown = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return typeof resolved === "string" && resolved.length > 0
    ? resolved
    : FALLBACK_TIME_ZONE;
}
