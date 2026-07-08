/**
 * Structured performance-telemetry emitter for the renderer.
 *
 * Unlike `logger.ts` (human-readable diagnostics that land in
 * `traycer-desktop.log`), perf events are machine-parseable and routed to a
 * DEDICATED file so they can be mined for data-driven perf work without
 * grepping the human log.
 *
 * Wiring: `logPerfEvent` prints a single `console.warn` line prefixed
 * `[traycer-perf]` carrying `{ name, tsMs, fields }` JSON. The desktop shell
 * recognizes that prefix in its `console-message` handler
 * (`windows/window-factory.ts`) and appends the event to
 * `<userData>/traycer-perf.ndjson` (one JSON object per line) via
 * `perf/perf-telemetry-writer.ts` INSTEAD of electron-log. `console.warn` (not
 * `console.log`) is required because production only forwards renderer
 * warning/error console messages.
 *
 * Enable + where to read:
 *   - Flag:  localStorage["traycer:perf:telemetry"] = "1" (opt-in) / "0" (off)
 *   - File:  <Electron userData>/traycer-perf.ndjson (rotates to `.ndjson.1`)
 * Gating mirrors the existing probes (`main-thread-block-probe.ts`,
 * `terminal-load-perf.ts`): on by default in dev, off under test, opt-in for
 * production via the localStorage flag. An explicit flag ("1"/"0") always wins,
 * so profiling can be toggled in any build (and forced on inside a test).
 *
 * Cheap and non-throwing by contract: perf fields are numbers/counts/strings
 * (no secrets), so no sanitization is applied here.
 */

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
 * Emit one structured perf event. No-ops when telemetry is disabled and never
 * throws into the caller's hot path.
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
