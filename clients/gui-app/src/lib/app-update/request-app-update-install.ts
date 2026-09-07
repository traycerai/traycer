import { unsyncableWork } from "@/lib/registries/epic-session-registry";
import type { UnsyncedEditsEntry } from "@/stores/epics/open-epic/session-registry";
import {
  useDesktopDialogStore,
  type UpdateUnsyncedConfirmation,
} from "@/stores/dialogs/desktop-dialog-store";
import type { DesktopAppUpdatesBridge } from "@/lib/windows/types";
import { appLogger } from "@/lib/logger";

/**
 * The one door to `installUpdate()`. Prompt before calling: a retained epic buffer cannot drain, and a prompt after would strand `installingUpdate`.
 */
export async function requestAppUpdateInstall(
  bridge: DesktopAppUpdatesBridge,
): Promise<void> {
  const check = await unsyncableWorkAcrossWindows();
  if (!check.otherWindowsUnknown && check.epics.length === 0) {
    void bridge.installUpdate();
    return;
  }
  useDesktopDialogStore.getState().openUpdateUnsyncedConfirm(check);
}

/**
 * What the confirmation's Confirm did: installed, or re-asked because the protected set is no longer the one the user was shown.
 */
export type ConfirmAppUpdateInstallOutcome = "installed" | "reconfirm";

/** The confirmation's Confirm - the SECOND half of the door, and the half that actually installs after a prompt. */
export async function confirmAppUpdateInstall(
  bridge: DesktopAppUpdatesBridge,
  shown: UpdateUnsyncedConfirmation,
): Promise<ConfirmAppUpdateInstallOutcome> {
  const fresh = await unsyncableWorkAcrossWindows();
  if (!coveredByShown(fresh, shown)) {
    useDesktopDialogStore.getState().openUpdateUnsyncedConfirm(fresh);
    return "reconfirm";
  }
  useDesktopDialogStore.getState().close();
  void bridge.installUpdate();
  return "installed";
}

/**
 * True when everything `fresh` would destroy was already on the table when the user confirmed.
 * Keyed on `epicId`, not row identity: the rows are rebuilt on every check, and a row whose title or queue size moved is still the same consented-to buffer.
 */
function coveredByShown(
  fresh: UpdateUnsyncedConfirmation,
  shown: UpdateUnsyncedConfirmation,
): boolean {
  if (fresh.otherWindowsUnknown && !shown.otherWindowsUnknown) return false;
  const shownIds = new Set(shown.epics.map((epic) => epic.epicId));
  return fresh.epics.every((epic) => shownIds.has(epic.epicId));
}

/**
 * App-wide unsyncable set (install quits every window).
 * Missing `appLifecycle` means this renderer is the whole app.
 */
async function unsyncableWorkAcrossWindows(): Promise<UpdateUnsyncedConfirmation> {
  const lifecycle = readAppLifecycle();
  if (lifecycle === null) {
    return { epics: unsyncableWork(), otherWindowsUnknown: false };
  }
  try {
    const report = await lifecycle.unsyncableWorkAcrossWindows();
    return {
      epics: report.epics,
      otherWindowsUnknown: report.otherWindowsUnknown,
    };
  } catch (error: unknown) {
    appLogger.error(
      "[app-update] cross-window unsyncable check failed",
      {},
      error,
    );
    return { epics: unsyncableWork(), otherWindowsUnknown: true };
  }
}

/**
 * Structural view of the desktop-only namespace, typed locally and feature detected, exactly as `quit-intercept-bridge.tsx` does it - gui-app must not depend on the desktop package, and every other shell leaves this undefined.
 */
interface CrossWindowUnsyncableReport {
  readonly epics: ReadonlyArray<UnsyncedEditsEntry>;
  readonly otherWindowsUnknown: boolean;
}

interface AppLifecycleUnsyncableReader {
  unsyncableWorkAcrossWindows(): Promise<CrossWindowUnsyncableReport>;
}

interface WindowWithRunnerHost {
  runnerHost?: {
    readonly appLifecycle?: Partial<AppLifecycleUnsyncableReader>;
  };
}

function readAppLifecycle(): AppLifecycleUnsyncableReader | null {
  if (typeof window === "undefined") return null;
  const lifecycle = (window as WindowWithRunnerHost).runnerHost?.appLifecycle;
  if (lifecycle === undefined) return null;
  // Method-level detection, not namespace-level: a desktop shell older than this channel still installs `appLifecycle`, and calling a method it does not have would reject into the fallback on every click.
  const read = lifecycle.unsyncableWorkAcrossWindows;
  if (read === undefined) return null;
  return { unsyncableWorkAcrossWindows: () => read.call(lifecycle) };
}
