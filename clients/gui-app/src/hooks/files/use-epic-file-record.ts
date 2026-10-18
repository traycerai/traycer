import { useCallback, useSyncExternalStore } from "react";
import type {
  EpicFileLocalState,
  EpicStateFileRecord,
} from "@traycer/protocol/host/epic/files";
import type { EpicFileAddress } from "@/hooks/files/use-epic-file-text-query";
import {
  EMPTY_FILES_SLICE,
  type FilesSlice,
} from "@/stores/epics/open-epic/types";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";

/**
 * The files lane's record for one path, or `null` when the lane has none (a
 * host older than `@1.2`, a path not in the manifest, or no epic session).
 *
 * Tolerant of a missing session for the same reason `useEpicLaneCommentThreads`
 * is: a page row can mount where no store is in scope, and "the lane has not
 * said" is the honest answer there. It returns the record object the slice
 * already holds - never a copy - so `useSyncExternalStore` sees a stable
 * snapshot until that file's record actually changes.
 *
 * Read only its shared manifest half (`entry`) from a tile: its `localState`
 * is the canvas host's, which {@link useEpicFileLocalState} accounts for.
 */
export function useEpicFileRecord(path: string): EpicStateFileRecord | null {
  const handle = useMaybeOpenEpicHandle();
  const subscribe = useCallback(
    (onChange: () => void): (() => void) =>
      handle === null ? () => {} : handle.store.subscribe(onChange),
    [handle],
  );
  const getSnapshot = useCallback((): EpicStateFileRecord | null => {
    if (handle === null) return null;
    return (
      handle.store
        .getState()
        .files.records.find((record) => record.path === path) ?? null
    );
  }, [handle, path]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Whether `hostId` holds the bytes at `address`, as the files lane says - or
 * `null` when the lane cannot say.
 *
 * The manifest half of a record is shared, but `localState` describes the disk
 * of the host serving the epic session, which is the CANVAS's host. A tile is
 * bound to its own host for life, and that can be another machine, so the lane
 * is trusted only when it is that tile's host and the record still names the
 * tile's sha (a newer version at the same path says nothing about this one).
 * Otherwise the tile's host's own `readFile` / `fetchFile` answers are the only
 * truth, and a `null` here sends the caller to them.
 */
export function useEpicFileLocalState(
  hostId: string,
  address: EpicFileAddress,
): EpicFileLocalState | null {
  const handle = useMaybeOpenEpicHandle();
  const record = useEpicFileRecord(address.path);
  if (handle === null || handle.hostId !== hostId) return null;
  if (record === null || record.entry.sha256 !== address.sha256) return null;
  return record.localState;
}

/**
 * The whole files slice, or the unserved one when there is no epic session.
 * For surfaces a tile mounts - the version menu - that must render in a test or
 * a detached window with no store behind them.
 */
export function useMaybeEpicFiles(): FilesSlice {
  const handle = useMaybeOpenEpicHandle();
  const subscribe = useCallback(
    (onChange: () => void): (() => void) =>
      handle === null ? () => {} : handle.store.subscribe(onChange),
    [handle],
  );
  const getSnapshot = useCallback(
    (): FilesSlice =>
      handle === null ? EMPTY_FILES_SLICE : handle.store.getState().files,
    [handle],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
