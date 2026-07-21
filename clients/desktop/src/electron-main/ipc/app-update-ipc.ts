import { isDevBuild } from "../../config";
import type { DesktopAppUpdateCheckIntent } from "../../ipc-contracts/app-update-types";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../../ipc-contracts/ipc-channels";
import {
  checkForUpdatesNow,
  getAppUpdateSnapshot,
  installDownloadedUpdate,
  onAppUpdateChange,
  startUpdateDownload,
} from "../app/updater";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";

export function registerAppUpdateIpc(bridge: RunnerIpcBridge): void {
  bridge.handleInvoke(RunnerHostInvoke.appUpdateGetSnapshot, () =>
    getAppUpdateSnapshot(),
  );

  bridge.handleInvoke(RunnerHostInvoke.appUpdateCheck, (_event, intent) =>
    checkForUpdatesNow(isDevBuild, parseAppUpdateCheckIntent(intent)),
  );

  bridge.handleInvoke(RunnerHostInvoke.appUpdateDownload, () =>
    startUpdateDownload(),
  );

  bridge.handleInvoke(RunnerHostInvoke.appUpdateInstall, () =>
    installDownloadedUpdate(),
  );

  bridge.disposeFns.push(
    onAppUpdateChange((snapshot) => {
      bridge.fanOut(RunnerHostEvent.appUpdateChange, snapshot);
    }),
  );
}

function parseAppUpdateCheckIntent(
  value: unknown,
): DesktopAppUpdateCheckIntent {
  return value === "automatic" ? "automatic" : "manual";
}
