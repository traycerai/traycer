/**
 * Reads the active epic's live Y.Doc projection (chats / tui-agents / artifacts) for the opener category sub-pages.
 */
import { useCallback, useSyncExternalStore } from "react";
import {
  getEpicSessionHandleHostId,
  getOpenEpicRegistry,
} from "@/lib/registries/epic-session-registry";
import type {
  OpenEpicState,
  OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";

/** The epic's CURRENT session handle, re-answered when a re-point swaps it. */
function useActiveEpicHandle(
  epicId: string | null,
): OpenEpicStoreHandle | null {
  const subscribe = useCallback(
    (onChange: () => void): (() => void) =>
      epicId === null
        ? () => undefined
        : getOpenEpicRegistry().subscribe(onChange),
    [epicId],
  );
  const getSnapshot = useCallback(
    (): OpenEpicStoreHandle | null =>
      epicId === null ? null : getOpenEpicRegistry().peek(epicId),
    [epicId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}

export function useActiveEpicProjection(
  epicId: string | null,
): OpenEpicState | null {
  const handle = useActiveEpicHandle(epicId);
  const subscribe = useCallback(
    (onStoreChange: () => void): (() => void) =>
      handle === null ? () => undefined : handle.store.subscribe(onStoreChange),
    [handle],
  );
  const getSnapshot = useCallback(
    (): OpenEpicState | null =>
      handle === null ? null : handle.store.getState(),
    [handle],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}

/**
 * The host that SERVES the active epic's projection - the one its session handle was acquired against - for the opener sub-pages to stamp into the tiles they open and to address the epic's own host-scoped reads.
 */
export function useActiveEpicHostId(epicId: string | null): string | null {
  const handle = useActiveEpicHandle(epicId);
  return handle === null ? null : getEpicSessionHandleHostId(handle);
}
