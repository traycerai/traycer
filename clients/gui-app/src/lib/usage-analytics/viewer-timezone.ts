const FALLBACK_TIME_ZONE = "UTC";

/**
 * The viewer's IANA zone, sent on every `host.usage.summary` request so day
 * bucketing lands on the reader's calendar days rather than the host's.
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` does not always name a
 * usable zone: when the machine's zone is one ICU cannot name, V8 (Electron,
 * Chromium WebViews) reports `undefined` or `"Etc/Unknown"`, and the host
 * rejects any zone `Intl` refuses as an explicit `timeZone`. So the zone is
 * sent only when `Intl` accepts it, and UTC otherwise. `Intl` refuses an
 * empty zone too, which the request schema also forbids (see
 * `hostUsageSummaryRequestSchemaV10`).
 */
export function getViewerTimeZone(): string {
  const resolved: unknown = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (typeof resolved !== "string") {
    return FALLBACK_TIME_ZONE;
  }
  try {
    Intl.DateTimeFormat("en-US", { timeZone: resolved });
    return resolved;
  } catch {
    return FALLBACK_TIME_ZONE;
  }
}
