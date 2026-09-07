import { RunnerHostInvoke } from "../../ipc-contracts/ipc-channels";
import {
  releaseAllSleepBlockers,
  releaseSleepBlockerForWebContents,
  setSleepBlockedForWebContents,
} from "../app/sleep-blocker";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";

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
