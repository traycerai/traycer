import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { parkUnwatchedEpicsNow } from "@/lib/epics/epic-parking";
import { appLogger } from "@/lib/logger";
import { isMobileApp } from "@/lib/mobile-app";
import { getChatSessionRegistry } from "@/lib/registries/chat-session-registry";
import { getTerminalSessionRegistry } from "@/lib/registries/terminal-session-registry";

/** What one app-suspend release let go of, for the log line and the tests. */
export interface AppSuspendRelease {
  readonly parkedEpics: number;
  readonly sleptChats: number;
  readonly disposedTerminals: number;
}

/**
 * Release what nobody is looking at, as the app is sent to the background.
 *
 * Every retention plane already sheds its hidden sessions on a clock - the
 * five-minute park window, the ten-minute chat TTL and terminal linger - and a
 * suspended runtime's clocks do not run. So on a phone none of them fired for
 * as long as the app stayed in the background, and the renderer went into it
 * holding every hidden epic, warm chat and lingering terminal it had: the
 * footprint the OS weighs when it picks a process to kill.
 *
 * Each plane keeps its own rules about what may go; this only runs them now:
 *
 *  - epics not in a front pane are PARKED, through the same eligibility the
 *    window's end uses (unsynced edits, working agents and unsaved drafts are
 *    refused and wait);
 *  - lease-free chats with no unsettled work are put to SLEEP - stream closed,
 *    store kept - and reconnect when a tile next leases them;
 *  - lease-free plain terminals are disposed (the PTY runs host-side).
 *
 * Epics first: a park disposes that epic's chats outright, so the chat sweep
 * only sees what is left.
 */
export function releaseForAppSuspend(): AppSuspendRelease {
  const parkedEpics = releasePlane("epics", parkUnwatchedEpicsNow);
  const sleptChats = releasePlane("chats", () =>
    getChatSessionRegistry().sleepIdleWarmSessions(),
  );
  const disposedTerminals = releasePlane("terminals", () =>
    getTerminalSessionRegistry().disposeLingeringPlainTerminals(),
  );
  return { parkedEpics, sleptChats, disposedTerminals };
}

/**
 * One plane's release, isolated: a plane that throws is logged and counted as
 * having released nothing, and the planes after it still run. This is the last
 * chance before the OS suspends the runtime, so one failure must not keep the
 * others' memory resident for the whole background.
 */
function releasePlane(plane: string, release: () => number): number {
  try {
    return release();
  } catch (error) {
    appLogger.error("[app-suspend] plane release failed", { plane }, error);
    return 0;
  }
}

/**
 * Wire {@link releaseForAppSuspend} to the shell's background edge, on the
 * installed mobile app only. Returns a disposer.
 *
 * Mobile-only by product signal (`isMobileApp()`), not by capability: desktop's
 * `onSystemSuspended` is a no-op anyway, but a desktop window that is hidden
 * keeps running and its clocks already do this job, so the gate states the
 * intent rather than relying on the shell staying silent.
 */
export function subscribeAppSuspendRelease(
  runnerHost: IRunnerHost | null,
): () => void {
  if (runnerHost === null || !isMobileApp()) return () => undefined;
  const subscription = runnerHost.onSystemSuspended(() => {
    try {
      const release = releaseForAppSuspend();
      appLogger.info("[app-suspend] released hidden sessions", { ...release });
    } catch (error) {
      // A plane that throws must not take the shell's other suspend
      // subscribers with it; the clocks remain as the fallback.
      appLogger.error("[app-suspend] release failed", {}, error);
    }
  });
  return () => {
    subscription.dispose();
  };
}
