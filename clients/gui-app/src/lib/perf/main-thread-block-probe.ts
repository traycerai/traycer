import { appLogger } from "@/lib/logger";
import { logPerfEvent } from "@/lib/perf/perf-telemetry";

/**
 * Renderer main-thread block probe.
 *
 * A host RPC is dialed per request over a one-shot WebSocket, so when the
 * renderer's main thread is busy, incoming WebSocket frames sit unprocessed and
 * the RPC *looks* slow even though the host answered in ms. This probe
 * surfaces those stalls directly using the browser's Long Tasks API
 * (`PerformanceObserver` for `longtask`), which reports every task that blocked
 * the main thread for ≥50ms, with its duration and start time, so a ~700ms long
 * task explains the RPCs it actually delayed.
 *
 * Gating mirrors `terminal-load-perf`: on in dev, off under test, opt-in for
 * prod via `localStorage["traycer:perf:mainthread"] = "1"`.
 */

// Only surface tasks at/above this to keep the console signal-rich. The
// Long Tasks spec already floors reporting at 50ms; this trims the chatter.
const REPORT_THRESHOLD_MS = 100;

let started = false;

function probeEnabled(): boolean {
  if (typeof window === "undefined") return false;
  if (import.meta.env.MODE === "test") return false;
  if (import.meta.env.DEV) return true;
  try {
    return window.localStorage.getItem("traycer:perf:mainthread") === "1";
  } catch {
    return false;
  }
}

function attributionLabel(entry: PerformanceEntry): string {
  // `attribution` is a TaskAttributionTiming[]; it usually only identifies the
  // container (frame), not the exact function, but the container + duration is
  // enough to correlate with what was rendering. Read defensively - the field
  // is non-standard across engines.
  const attribution = (
    entry as PerformanceEntry & {
      readonly attribution?: ReadonlyArray<{
        readonly name?: string;
        readonly containerType?: string;
        readonly containerName?: string;
        readonly containerSrc?: string;
      }>;
    }
  ).attribution;
  if (attribution === undefined || attribution.length === 0) return "self";
  const first = attribution[0];
  const parts = [
    first.containerType,
    first.containerName,
    first.containerSrc,
    first.name,
  ].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  return parts.length > 0 ? parts.join(" ") : "self";
}

/**
 * Cheap active-surface tag so a block can be tied to a specific page (e.g. the
 * Worktrees settings panel). The Long Tasks API's `attribution` usually only
 * names the container ("window unknown"), so the route path is what makes a
 * stall actionable. Read defensively - `location` access can throw in some
 * sandboxed contexts.
 */
function activeSurface(): string {
  if (typeof window === "undefined") return "unknown";
  try {
    return window.location.pathname;
  } catch {
    return "unknown";
  }
}

/**
 * Starts the probe. Idempotent and safe to call from a module side-effect
 * import; no-ops when disabled or when the Long Tasks API is unavailable.
 */
export function startMainThreadBlockProbe(): void {
  if (started) return;
  if (!probeEnabled()) return;
  if (!PerformanceObserver.supportedEntryTypes.includes("longtask")) return;

  started = true;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.duration < REPORT_THRESHOLD_MS) continue;
      const blockedMs = Math.round(entry.duration);
      const atMs = Math.round(entry.startTime);
      const attribution = attributionLabel(entry);
      appLogger.warn("[main-thread-block] renderer main thread blocked", {
        blockedMs,
        atMs,
        attribution,
      });
      // Also route to the dedicated perf file with a surface tag, so a stall can
      // be attributed to the route it happened on (fixes the container-only
      // "window unknown" blind spot). Keeps the human-log warn above intact.
      logPerfEvent("main_thread_block", {
        blockedMs,
        atMs,
        attribution,
        surface: activeSurface(),
      });
    }
  });
  try {
    observer.observe({ entryTypes: ["longtask"] });
  } catch (error) {
    appLogger.warn("[main-thread-block] observer start failed", {
      error: error instanceof Error ? error.name : typeof error,
    });
    // `longtask` not observable in this engine; leave the probe inert.
    started = false;
  }
}
