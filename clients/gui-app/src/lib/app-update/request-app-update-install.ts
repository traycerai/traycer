import { unsyncableWork } from "@/lib/registries/epic-session-registry";
import type { UnsyncedEditsEntry } from "@/stores/epics/open-epic/session-registry";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
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
  const unsyncable = await unsyncableWorkAcrossWindows();
  if (unsyncable.length === 0) {
    void bridge.installUpdate();
    return;
  }
  useDesktopDialogStore.getState().openUpdateUnsyncedConfirm(unsyncable);
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
 * snapshot. The LOCAL registry remains the fallback rather than an error path:
 * outside Electron (gui-app-dev, mobile) there is no `appLifecycle` namespace
 * and one renderer IS the app, and an IPC that rejects must not be allowed to
 * turn "we could not check" into "nothing to lose" - falling back to this
 * window's own answer is strictly more conservative than assuming none.
 */
async function unsyncableWorkAcrossWindows(): Promise<
  ReadonlyArray<UnsyncedEditsEntry>
> {
  const lifecycle = readAppLifecycle();
  if (lifecycle === null) return unsyncableWork();
  try {
    return await lifecycle.unsyncableWorkAcrossWindows();
  } catch (error: unknown) {
    appLogger.error(
      "[app-update] cross-window unsyncable check failed",
      {},
      error,
    );
    return unsyncableWork();
  }
}

/**
 * Structural view of the desktop-only namespace, typed locally and feature
 * detected, exactly as `quit-intercept-bridge.tsx` does it - gui-app must not
 * depend on the desktop package, and every other shell leaves this undefined.
 */
interface AppLifecycleUnsyncableReader {
  unsyncableWorkAcrossWindows(): Promise<ReadonlyArray<UnsyncedEditsEntry>>;
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
