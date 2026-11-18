import { powerSaveBlocker } from "electron";
import { log } from "./logger";

/**
 * One OS-level power assertion shared across every renderer window. We use
 * `prevent-app-suspension` rather than `prevent-display-sleep`: the goal is to
 * keep the machine - and the local host running the agent - awake so an
 * in-progress chat / terminal agent keeps going after the user steps away,
 * while still letting the display sleep to save power. `powerSaveBlocker`
 * wraps the per-OS primitive (IOPMAssertion on macOS, SetThreadExecutionState
 * on Windows, the freedesktop/GNOME inhibit on Linux) so callers stay
 * platform-agnostic.
 *
 * Each renderer window publishes its own desired state
 * (`preventSleepWhileRunning && anyLocalAgentActive`). The blocker is held
 * while ANY window wants it and released once none do. State is keyed by
 * `webContents.id` so a window that is torn down (closed in menu-bar mode, a
 * renderer crash) can be dropped via `releaseSleepBlockerForWebContents`
 * without leaking the assertion - the dead renderer can no longer send a
 * `false`.
 *
 * Note: on macOS this prevents idle sleep only; closing the lid still sleeps
 * the machine regardless, which no API can override.
 */
const desiredByWebContents = new Map<number, boolean>();
let blockerId: number | null = null;

export function setSleepBlockedForWebContents(
  webContentsId: number,
  blocked: boolean,
): void {
  if (blocked) {
    desiredByWebContents.set(webContentsId, true);
  } else {
    desiredByWebContents.delete(webContentsId);
  }
  reconcile();
}

export function releaseSleepBlockerForWebContents(webContentsId: number): void {
  if (desiredByWebContents.delete(webContentsId)) {
    reconcile();
  }
}

export function releaseAllSleepBlockers(): void {
  if (desiredByWebContents.size === 0 && blockerId === null) return;
  desiredByWebContents.clear();
  reconcile();
}

function reconcile(): void {
  const shouldBlock = desiredByWebContents.size > 0;
  if (shouldBlock) {
    if (blockerId !== null && powerSaveBlocker.isStarted(blockerId)) return;
    blockerId = powerSaveBlocker.start("prevent-app-suspension");
    log.info("[sleep-blocker] holding power-save blocker", { blockerId });
    return;
  }
  if (blockerId === null) return;
  if (powerSaveBlocker.isStarted(blockerId)) {
    powerSaveBlocker.stop(blockerId);
  }
  log.info("[sleep-blocker] released power-save blocker", { blockerId });
  blockerId = null;
}
