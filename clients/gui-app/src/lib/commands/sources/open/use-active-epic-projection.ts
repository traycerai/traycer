/**
 * Reads the active epic's live Y.Doc projection (chats / tui-agents /
 * artifacts) for the opener category sub-pages.
 *
 * Why the registry instead of `useEpicChatRecords` & friends: those list
 * hooks call `useOpenEpicHandle()`, which only resolves inside
 * `<EpicSessionProvider>`. The command palette mounts at app root (above the
 * per-tab session provider), so the opener sub-pages live OUTSIDE that
 * context and would crash. The open-epic store is reachable imperatively
 * through `getOpenEpicRegistry()` (the same registry `actions/new-chat.ts`
 * uses), so we subscribe to it via `useSyncExternalStore`.
 *
 * `getSnapshot` returns the raw `OpenEpicState` (stable reference until a
 * projection mutation) so it satisfies `useSyncExternalStore`'s identity
 * contract; callers derive their item arrays with `useMemo`.
 */
import { useCallback, useSyncExternalStore } from "react";
import {
  getEpicSessionHandleHostId,
  getOpenEpicRegistry,
} from "@/lib/registries/epic-session-registry";
import type { OpenEpicState } from "@/stores/epics/open-epic/store";

export function useActiveEpicProjection(
  epicId: string | null,
): OpenEpicState | null {
  const subscribe = useCallback(
    (onStoreChange: () => void): (() => void) => {
      if (epicId === null) return () => undefined;
      const handle = getOpenEpicRegistry().get(epicId);
      if (handle === null) return () => undefined;
      return handle.store.subscribe(onStoreChange);
    },
    [epicId],
  );

  const getSnapshot = useCallback((): OpenEpicState | null => {
    if (epicId === null) return null;
    const handle = getOpenEpicRegistry().get(epicId);
    return handle === null ? null : handle.store.getState();
  }, [epicId]);

  return useSyncExternalStore(subscribe, getSnapshot);
}

/**
 * The host that SERVES the active epic's projection - the one its session
 * handle was acquired against - for the opener sub-pages to stamp into the
 * tiles they open and to address the epic's own host-scoped reads.
 *
 * NOT the app-wide addressable host, which is what these sub-pages read
 * before PR #1243: during an A→B re-point the A-backed Epic keeps its
 * projection rendered while the addressable host already answers B, so an
 * artifact opened from the palette became a B-bound tile over A's record -
 * bound for life (the same defect `useEpicArtifactRecords` carried). The
 * handle→host binding is write-once per handle; the registry is subscribed
 * so a re-point that swaps the epic's handle re-answers.
 */
export function useActiveEpicHostId(epicId: string | null): string | null {
  const subscribe = useCallback(
    (onChange: () => void): (() => void) =>
      epicId === null
        ? () => undefined
        : getOpenEpicRegistry().subscribe(onChange),
    [epicId],
  );
  const getSnapshot = useCallback((): string | null => {
    if (epicId === null) return null;
    const handle = getOpenEpicRegistry().get(epicId);
    return handle === null ? null : getEpicSessionHandleHostId(handle);
  }, [epicId]);
  return useSyncExternalStore(subscribe, getSnapshot);
}
