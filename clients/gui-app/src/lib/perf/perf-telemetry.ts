/** Structured performance-telemetry emitter for the renderer. */

const TELEMETRY_LOG_PREFIX = "[traycer-perf]";
const TELEMETRY_FLAG_KEY = "traycer:perf:telemetry";

export type PerfFieldValue = number | string | boolean | null;

function telemetryEnabled(): boolean {
  if (typeof window === "undefined") return false;
  // An explicit flag wins in every build: opt-in for prod, and lets a test
  // force the emitter on despite the test-mode default-off below.
  try {
    const flag = window.localStorage.getItem(TELEMETRY_FLAG_KEY);
    if (flag === "1") return true;
    if (flag === "0") return false;
  } catch {
    // localStorage can throw (privacy mode); fall through to build defaults.
  }
  if (import.meta.env.MODE === "test") return false;
  return Boolean(import.meta.env.DEV);
}

/**
 * Emit one structured perf event.
 * No-ops when telemetry is disabled and never throws into the caller's hot path.
 */
export function logPerfEvent(
  name: string,
  fields: Record<string, PerfFieldValue>,
): void {
  if (!telemetryEnabled()) return;
  try {
    const event = { name, tsMs: Date.now(), fields };
    console.warn(`${TELEMETRY_LOG_PREFIX} ${JSON.stringify(event)}`);
  } catch {
    // Best-effort: a serialization/console failure must never disrupt the app.
  }
}
