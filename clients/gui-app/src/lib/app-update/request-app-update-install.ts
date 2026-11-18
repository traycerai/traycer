import { unsyncableWork } from "@/lib/registries/epic-session-registry";
import type { UnsyncedEditsEntry } from "@/stores/epics/open-epic/session-registry";
import {
  useDesktopDialogStore,
  type UpdateUnsyncedConfirmation,
} from "@/stores/dialogs/desktop-dialog-store";
import type { DesktopAppUpdatesBridge } from "@/lib/windows/types";
import { appLogger } from "@/lib/logger";

/**
 * The one door to `installUpdate()`.
 *
 * Installing an update quits and relaunches the app, and the update quit
 * deliberately skips the unsynced-edits interception - `update-install-quit.ts`
 * says so, and it is right to: prompting there would swallow the install. What
 * it drains instead is the renderer's per-window projection (tabs, canvas, and
 * workspace-file drafts into IndexedDB), which preserves those across the
 * relaunch.
 *
 * It does not, and cannot, preserve a RETAINED epic buffer. Retention calls
 * `detachTransport()`, so the buffer is a live `Y.Doc` with no socket, its
 * store is frozen at retention time, and no epic document has any local
 * persistence to be drained into. For a retained buffer the drain cannot help
 * BY CONSTRUCTION - there is nothing durable to drain to - which is why the
 * remedy is to ask before starting the install rather than to add the epic doc
 * to the existing drain.
 *
 * This is NOT a reinstatement of the restart confirmation that `b2a1097a`
 * (#683) deliberately removed. That commit is preserved exactly: it removed a
 * prompt in a world where every dirty session held a transport and would drain,
 * and this fires only on work that can never drain - a state that did not exist
 * until `30819ce6` introduced retention three weeks later. A syncable dirty
 * session still installs with no prompt, as the user chose.
 *
 * Both install surfaces route through here - the header button and the update
 * toast - because gating one moves the door rather than closing it.
 *
 * Prompting BEFORE `installUpdate()` is also what keeps this free of the
 * `installingUpdate` flag: that flag is raised inside `installUpdate` and
 * lowered in exactly one place, so a prompt after it would have to add a
 * lowering transition purely to undo something we should not have started, and
 * a cancel would strand it raised for the next quit.
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
 * What the confirmation's Confirm did: installed, or re-asked because the
 * protected set is no longer the one the user was shown.
 */
export type ConfirmAppUpdateInstallOutcome = "installed" | "reconfirm";

/**
 * The confirmation's Confirm - the SECOND half of the door, and the half that
 * actually installs after a prompt.
 *
 * `shown` is what the user consented to discard: the rows the dialog listed
 * and whether it said other windows were unaccounted for. Between the dialog
 * opening and Confirm, another window (or this one) can retain a NEW Epic -
 * a host re-point mid-dialog is exactly the kind of event that produces
 * unsyncable work - and installing off the captured list would destroy a
 * buffer the confirmation never named. The update quit skips the
 * unsynced-edits interception on purpose (`update-install-quit.ts`), so this
 * prompt is the ONLY thing standing in front of that buffer; a Confirm that
 * does not re-check leaves it standing in front of a stale list.
 *
 * So Confirm re-runs the app-wide check and installs only if the answer is
 * still COVERED by what was shown: no epic the user was not shown, and no
 * flip from "other windows checked" to "other windows unknown". A set that
 * SHRANK is fine - a retention reclaimed while the dialog was up means less
 * to lose than consented to, and re-asking about less would be noise. A set
 * that GREW (or lost its coverage) replaces the confirmation's rows with the
 * fresh FULL set and does NOT install: the user reads the current list and
 * confirms again, or cancels. (No delta is highlighted - the rows are the
 * whole set, re-listed.) The dialog holds its rows in the store rather than re-deriving
 * (`desktop-dialog-store.ts` says why), and this is the one place they are
 * replaced - by a check, never by a passive re-query.
 */
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
 * True when everything `fresh` would destroy was already on the table when
 * the user confirmed. Keyed on `epicId`, not row identity: the rows are
 * rebuilt on every check, and a row whose title or queue size moved is still
 * the same consented-to buffer.
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
 * The unsyncable set for the WHOLE APP, not this renderer.
 *
 * `unsyncableWork()` reads a module-scoped registry, so it can only ever see
 * the Epics open in the window that was clicked - while `installUpdate()`
 * quits and relaunches the entire Electron app. A user with a retained buffer
 * in window B who clicked Update in window A got no prompt at all and lost it,
 * which is precisely the case this helper was added to cover: the update quit
 * bypasses the unsynced-edits interception, so this prompt is the only thing
 * standing in front of that buffer.
 *
 * Main answers, because main is the only process holding every window's
 * snapshot. Two things look like "no answer from main" and they are NOT the
 * same:
 *
 *  - No `appLifecycle` namespace at all (gui-app-dev, mobile): there is no
 *    other window - one renderer IS the app - so this window's own registry
 *    is the whole truth and `otherWindowsUnknown` is false.
 *  - The IPC exists and REJECTS: the other windows are unaccounted for. This
 *    used to fall back to the local registry as if that were merely
 *    "conservative", but a local answer of "nothing" from window A while
 *    window B held a retained buffer read as "nothing to lose" and installed -
 *    destroying exactly the work the check exists to protect. A failed
 *    app-wide check therefore FAILS CLOSED: the door reports the local rows it
 *    can see plus `otherWindowsUnknown: true`, and the caller must confirm
 *    (the dialog says other windows could not be checked) rather than
 *    install on an answer nobody gave.
 *
 * A THIRD case fails closed the same way and is easy to miss because the call
 * succeeds: main answered, but a window missed its fresh-snapshot deadline and
 * main substituted that window's cached row. `otherWindowsUnknown` comes back
 * true on the report and is honoured here rather than being flattened into
 * "the IPC resolved, so the answer is complete". A resolved promise is
 * evidence that main replied, never that every window did.
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
 * Structural view of the desktop-only namespace, typed locally and feature
 * detected, exactly as `quit-intercept-bridge.tsx` does it - gui-app must not
 * depend on the desktop package, and every other shell leaves this undefined.
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
  // Method-level detection, not namespace-level: a desktop shell older than
  // this channel still installs `appLifecycle`, and calling a method it does
  // not have would reject into the fallback on every click.
  const read = lifecycle.unsyncableWorkAcrossWindows;
  if (read === undefined) return null;
  return { unsyncableWorkAcrossWindows: () => read.call(lifecycle) };
}
