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
  setAllowPrereleaseUpdates,
  startUpdateDownload,
  type DesktopAppUpdateChannelChange,
} from "../app/updater";
import { describeLogError, log } from "../app/logger";
import { isUpdatePreferencePersistenceError } from "../app/update-preferences";
import { refreshRegistryUpdateState } from "./host-management-ipc";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";

// Surfaced to the renderer as the mutation error when a channel switch is
// refused because an update is already downloading or staged for install
// (`updater.setAllowPrereleaseUpdates`). The user has to resolve that update
// first; the preference genuinely did not change.
export const CHANNEL_CHANGE_REFUSED_MESSAGE =
  "Finish or restart into the pending Traycer update before changing the release channel.";

export const CHANNEL_PREFERENCE_SAVE_FAILED_MESSAGE =
  "Couldn't save the release channel preference. Please try again.";

export function registerAppUpdateIpc(bridge: RunnerIpcBridge): void {
  bridge.handleInvoke(RunnerHostInvoke.appUpdateGetSnapshot, () =>
    getAppUpdateSnapshot(),
  );

  bridge.handleInvoke(RunnerHostInvoke.appUpdateCheck, (_event, intent) =>
    checkForUpdatesNow(isDevBuild, parseAppUpdateCheckIntent(intent)),
  );

  bridge.handleInvoke(
    RunnerHostInvoke.appUpdateSetAllowPrerelease,
    async (_event, allowPrerelease) => {
      let change: DesktopAppUpdateChannelChange;
      try {
        change = await setAllowPrereleaseUpdates(allowPrerelease === true);
      } catch (err) {
        if (!isUpdatePreferencePersistenceError(err)) {
          throw err;
        }
        // The renderer should not receive a filesystem error or user-data
        // path, but the original (redacted) error remains in the main-process
        // log for diagnostics.
        log.error("[app-update] failed to persist release channel preference", {
          error: describeLogError(err.cause),
        });
        throw new Error(CHANNEL_PREFERENCE_SAVE_FAILED_MESSAGE);
      }
      // Refused before persistence - nothing changed. Fail the invoke so the
      // renderer treats it as a mutation error (no analytics, no cache
      // invalidation, no follow-up checks) rather than a silent no-op that
      // still reads as success.
      if (change.outcome === "refused-update-pending") {
        throw new Error(CHANNEL_CHANGE_REFUSED_MESSAGE);
      }
      // Idempotent set: the requested channel was already selected, so there
      // is nothing to re-resolve for either updater.
      if (change.outcome === "unchanged") {
        return change.snapshot;
      }
      // Durable success. The Host registry cache is keyed by channel, so every
      // window and the native menu/tray are now advertising a target selected
      // under the *previous* channel. Force a re-probe and await it before
      // returning: `refreshRegistryUpdateState` fans the fresh state out to
      // every BrowserWindow (`hostRegistryUpdateStateChange`) and to the
      // menu/tray (`onHostRegistryUpdateStateChange` -> menu controller), so
      // by the time this mutation resolves no surface is still showing the old
      // channel's version. Never throws (a failed probe yields an unreachable
      // state, which clears the update affordances) - guarded anyway so a
      // registry problem can't fail an already-persisted preference change.
      await refreshRegistryUpdateState({ force: true, maxAgeMs: null }).catch(
        (err: unknown) => {
          log.warn(
            "[app-update] registry refresh after channel change failed",
            {
              err,
            },
          );
        },
      );
      return checkForUpdatesNow(isDevBuild, "manual");
    },
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
