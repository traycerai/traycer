import { appLogger } from "@/lib/logger";

/**
 * First-time load instrumentation for terminal and TUI (terminal-agent) tiles.
 *
 * Measures the wall-clock path a tile travels from mounting to its first
 * painted frame of content, broken into the phases that actually cost time:
 *
 *   mount         tile component mounted (user opened the tab)
 *   list-ready    `terminal.list` resolved (host-has-session predicate known)
 *   prepare-done  per-tile launch payload built (TUI: `prepareLaunch` RPC done)
 *   create-done   `terminal.create` RPC succeeded (skipped when reattaching)
 *   session-handle session store acquired + stream opening
 *   snapshot      first host frame (scrollback) arrived
 *   xterm-open    lazy `@xterm/*` chunk loaded, Terminal created + opened
 *   writer-ready  writer registered, pending bytes flushed (first content)
 *   first-render  xterm committed its first frame (first paint)
 *
 * The first four spans subdivide the network/RPC bootstrap leg, which in
 * practice dominates first-paint time; `xterm-open` onward is the (cheap)
 * view leg. The view leg runs partly concurrently with the data leg
 * (`snapshot`), so adjacent deltas across that boundary can read slightly
 * negative - that is effect-flush ordering, not a real regression.
 *
 * Each phase is recorded once (the first occurrence) per session, keyed by
 * `sessionId`, so re-renders and reattach frames don't perturb the numbers.
 * On `first-render` the timeline is logged as a structured renderer event and
 * a `performance.measure` is emitted for each span so the spans also show up in
 * the browser Performance panel.
 *
 * Gating: on by default in dev, off under test, and opt-in for production
 * builds via `localStorage["traycer:perf:terminal"] = "1"`.
 */

// Ordered so the summary table and the adjacent-span measures read top-to-bottom
// in load order regardless of the order marks happen to arrive.
const PHASE_ORDER = [
  "mount",
  "list-ready",
  "prepare-done",
  "create-done",
  "session-handle",
  "snapshot",
  "xterm-open",
  "writer-ready",
  "first-render",
] as const;

export type TerminalLoadPhase = (typeof PHASE_ORDER)[number];
export type TerminalLoadKind = "terminal" | "terminal-agent";

interface TerminalLoadTimeline {
  readonly kind: TerminalLoadKind;
  readonly startedAt: number;
  readonly marks: Map<TerminalLoadPhase, number>;
}

const timelines = new Map<string, TerminalLoadTimeline>();
const completed = new Set<string>();
let chunkLoadLogged = false;

function instrumentationEnabled(): boolean {
  if (typeof window === "undefined") return false;
  // Keep the suite quiet and deterministic; opt in explicitly when profiling.
  if (import.meta.env.MODE === "test") return false;
  if (import.meta.env.DEV) return true;
  try {
    return window.localStorage.getItem("traycer:perf:terminal") === "1";
  } catch {
    return false;
  }
}

function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

function markName(sessionId: string, phase: TerminalLoadPhase): string {
  return `terminal-load:${sessionId}:${phase}`;
}

/**
 * Open a timeline for a tile's first load. Idempotent: the first call wins,
 * later calls (re-mounts, the sibling reachability gate) are ignored, and a
 * session that has already completed is never re-measured.
 */
export function beginTerminalLoad(
  sessionId: string,
  kind: TerminalLoadKind,
): void {
  if (!instrumentationEnabled()) return;
  if (completed.has(sessionId)) return;
  if (timelines.has(sessionId)) return;
  const startedAt = performance.now();
  timelines.set(sessionId, {
    kind,
    startedAt,
    marks: new Map([["mount", startedAt]]),
  });
  performance.mark(markName(sessionId, "mount"));
}

/**
 * Record the first time `phase` is reached for `sessionId`. No-ops when the
 * timeline is closed/absent or the phase was already seen. Reaching
 * `first-render` finalizes and logs the timeline.
 */
export function markTerminalLoad(
  sessionId: string,
  phase: TerminalLoadPhase,
): void {
  if (!instrumentationEnabled()) return;
  const timeline = timelines.get(sessionId);
  if (timeline === undefined) return;
  if (timeline.marks.has(phase)) return;
  timeline.marks.set(phase, performance.now());
  performance.mark(markName(sessionId, phase));
  if (phase === "first-render") finishTerminalLoad(sessionId, timeline);
}

function finishTerminalLoad(
  sessionId: string,
  timeline: TerminalLoadTimeline,
): void {
  timelines.delete(sessionId);
  completed.add(sessionId);

  const table: Record<string, { atMs: number; deltaMs: number }> = {};
  let previous = timeline.startedAt;
  let previousPhase: TerminalLoadPhase | null = null;
  for (const phase of PHASE_ORDER) {
    const at = timeline.marks.get(phase);
    if (at === undefined) continue;
    table[phase] = {
      atMs: roundMs(at - timeline.startedAt),
      deltaMs: roundMs(at - previous),
    };
    if (previousPhase !== null) {
      try {
        performance.measure(
          `terminal-load:${sessionId}:${previousPhase}->${phase}`,
          markName(sessionId, previousPhase),
          markName(sessionId, phase),
        );
      } catch (error) {
        appLogger.debug("[terminal-perf] span measure skipped", {
          sessionId,
          fromPhase: previousPhase,
          toPhase: phase,
          error: error instanceof Error ? error.name : typeof error,
        });
        // A mark may be missing if a phase was skipped; the table still
        // reports the spans we did capture.
      }
    }
    previous = at;
    previousPhase = phase;
  }

  const totalMs = roundMs(previous - timeline.startedAt);
  appLogger.debug("[terminal-perf] first paint measured", {
    sessionId,
    kind: timeline.kind,
    totalMs,
    phases: table,
  });
}

/**
 * Log the one-time cost of fetching the lazy `@xterm/*` chunk. Only the first
 * terminal opened in a session pays this download; later tiles reuse the
 * cached module, so this is reported once and separately from per-tile spans.
 */
export function markXtermChunkLoad(durationMs: number): void {
  if (!instrumentationEnabled()) return;
  if (chunkLoadLogged) return;
  chunkLoadLogged = true;
  appLogger.debug("[terminal-perf] xterm chunk loaded", {
    durationMs: roundMs(durationMs),
  });
}
