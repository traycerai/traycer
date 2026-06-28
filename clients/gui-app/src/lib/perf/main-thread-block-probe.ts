import { appLogger } from "@/lib/logger";

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
      appLogger.warn("[main-thread-block] renderer main thread blocked", {
        blockedMs,
        atMs,
        attribution: attributionLabel(entry),
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
