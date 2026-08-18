import { unsyncableWork } from "@/lib/registries/epic-session-registry";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import type { DesktopAppUpdatesBridge } from "@/lib/windows/types";

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
export function requestAppUpdateInstall(bridge: DesktopAppUpdatesBridge): void {
  const unsyncable = unsyncableWork();
  if (unsyncable.length === 0) {
    void bridge.installUpdate();
    return;
  }
  useDesktopDialogStore.getState().openUpdateUnsyncedConfirm(unsyncable);
}
