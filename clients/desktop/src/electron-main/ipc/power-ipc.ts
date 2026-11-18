import { RunnerHostInvoke } from "../../ipc-contracts/ipc-channels";
import {
  releaseAllSleepBlockers,
  releaseSleepBlockerForWebContents,
  setSleepBlockedForWebContents,
} from "../app/sleep-blocker";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";

/**
 * Backs `runnerHost.power.setSleepBlocked(blocked)`. The renderer recomputes
 * `preventSleepWhileRunning && anyLocalAgentActive` and pushes the result here;
 * main holds a single `powerSaveBlocker` while any window wants it (see
 * `app/sleep-blocker`).
 *
 * Keyed by the sender's `webContents.id` so multiple windows compose with OR
 * semantics. Each sender gets a one-time `destroyed` listener so a window
 * closed in menu-bar mode or whose renderer process disappears releases its
 * hold instead of pinning the machine awake forever - once the renderer is gone
 * it can no longer send `false` itself.
 */
export function registerPowerIpc(bridge: RunnerIpcBridge): void {
  const guarded = new Set<number>();
  bridge.handleInvoke(
    RunnerHostInvoke.powerSetSleepBlocked,
    (event, blocked: unknown) => {
      const webContents = event.sender;
      const webContentsId = webContents.id;
      if (!guarded.has(webContentsId)) {
        guarded.add(webContentsId);
        const release = (): void => {
          webContents.off("destroyed", release);
          webContents.off("render-process-gone", release);
          guarded.delete(webContentsId);
          releaseSleepBlockerForWebContents(webContentsId);
        };
        webContents.once("destroyed", release);
        webContents.once("render-process-gone", release);
      }
      setSleepBlockedForWebContents(webContentsId, blocked === true);
    },
  );
  bridge.disposeFns.push(() => {
    releaseAllSleepBlockers();
  });
}
