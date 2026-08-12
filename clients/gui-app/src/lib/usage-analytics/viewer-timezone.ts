const FALLBACK_TIME_ZONE = "UTC";

/**
 * The viewer's IANA zone, sent on every `host.usage.summary` request so day
 * bucketing lands on the reader's calendar days rather than the host's.
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` always returns a real
 * IANA name in every browser/Electron runtime this app ships on; the
 * fallback exists only so a request never goes out with an empty string if
 * that assumption is ever wrong (the request schema requires a non-empty
 * zone - see `hostUsageSummaryRequestSchemaV10`).
 */
export function getViewerTimeZone(): string {
  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return resolved.length > 0 ? resolved : FALLBACK_TIME_ZONE;
}
