import { isValidCompatibilityEpoch } from "@traycer/protocol/framework/index";
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
  resolveCompatRecovery,
  setAllowPrereleaseUpdates,
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

  // `refused-update-pending` is a standing state on macOS (a natively staged update cannot be withdrawn), and a caller that saw only a snapshot would read the unchanged.
  bridge.handleInvoke(
    RunnerHostInvoke.appUpdateSetAllowPrerelease,
    async (_event, allowPrerelease) => {
      const change = await setAllowPrereleaseUpdates(allowPrerelease === true);
      if (change.outcome === "changed") {
        // The new channel has never been queried. Ask now so the surface that
        // requested the switch can move straight to the download affordance
        // instead of sitting on a snapshot that describes the old feed.
        void checkForUpdatesNow(isDevBuild, "manual");
      }
      return change;
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.appUpdateResolveCompatRecovery,
    (_event, request) =>
      resolveCompatRecovery(parseCompatRecoveryRequest(request)),
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

/** `hostAllowsRcRecovery` must be exactly `true`; anything else means no RC hop is authorized. */
function parseCompatRecoveryRequest(value: unknown): {
  readonly minimumEpoch: number;
  readonly hostAllowsRcRecovery: boolean;
} {
  if (value === null || typeof value !== "object") {
    return {
      minimumEpoch: Number.MAX_SAFE_INTEGER,
      hostAllowsRcRecovery: false,
    };
  }
  const record: Record<string, unknown> = { ...value };
  const minimumEpoch = record.minimumEpoch;
  return {
    minimumEpoch:
      typeof minimumEpoch === "number" &&
      isValidCompatibilityEpoch(minimumEpoch)
        ? minimumEpoch
        : Number.MAX_SAFE_INTEGER,
    hostAllowsRcRecovery: record.hostAllowsRcRecovery === true,
  };
}
