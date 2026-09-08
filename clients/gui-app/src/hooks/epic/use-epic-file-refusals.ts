/**
 * Drop-zone refusals for one epic's `files/` directory (D12): a secret-shaped
 * name (`.env*`, `*.pem`, `id_rsa*`, …), a file over the per-file cap, a
 * symlink, a drop zone over its hourly bound. The host refuses the write and
 * says so on `epic.fileEvents`; the GUI names the file so the user knows their
 * drop did not land.
 *
 * A pure READ of `lib/epic-files/file-events-store.ts`. The subscription that
 * fills it is owned by `<EpicFileEventsBinder>`, mounted per epic pane, so this
 * hook renders the same list whether the Files panel opened first or last - and
 * answers "nothing refused" against a host that predates the file plane, which
 * serves no `fileEvents` stream and therefore has nothing to report.
 *
 * No user id in the copy (D31): a refusal names the file, never who dropped it.
 */
import { useCallback, useSyncExternalStore } from "react";
import {
  getEpicFileRefusals,
  subscribeEpicFileRefusals,
} from "@/lib/epic-files/file-events-store";
import type { EpicFileRefusal } from "@/lib/epic-files/file-refusals";

export function useEpicFileRefusals(
  epicId: string,
): readonly EpicFileRefusal[] {
  const subscribe = useCallback(
    (onStoreChange: () => void): (() => void) =>
      subscribeEpicFileRefusals(epicId, onStoreChange),
    [epicId],
  );
  // Returns the store's own array - never a fresh one - so this is a stable
  // snapshot and the quiet case shares one frozen reference.
  const getSnapshot = useCallback(
    (): readonly EpicFileRefusal[] => getEpicFileRefusals(epicId),
    [epicId],
  );
  return useSyncExternalStore(subscribe, getSnapshot);
}
