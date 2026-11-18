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

  // The RC opt-in the compatibility-recovery surface offers, and deliberately
  // the ONLY way a channel change is reachable: there is no general Settings
  // toggle, so consent is always given against a named RC build that a probe
  // has already proven clears the rejecting host's floor.
  //
  // The full `DesktopAppUpdateChannelChange` crosses back, not just the
  // snapshot. `refused-update-pending` is a standing state on macOS (a natively
  // staged update cannot be withdrawn), and a caller that saw only a snapshot
  // would read the unchanged `allowPrerelease` as a silent failure rather than
  // as the instruction it is.
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

/**
 * Normalizes the recovery request arriving over IPC.
 *
 * Both members fail CLOSED. A floor that is not a positive safe integer becomes
 * `Number.MAX_SAFE_INTEGER`, so no candidate can clear it and the plan degrades
 * to the manual link - the opposite of defaulting to a low floor, which would
 * offer a build that the host then refuses. `hostAllowsRcRecovery` must be
 * exactly `true`; anything else means no RC hop is authorized.
 *
 * This is a renderer of ours over a contextIsolated bridge, not an untrusted
 * peer, so the point is not defence - it is that a shape bug here would
 * otherwise present as a mysteriously permissive gate rather than as a visibly
 * conservative one.
 */
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
