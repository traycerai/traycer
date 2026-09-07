import { powerSaveBlocker } from "electron";
import { log } from "./logger";

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
