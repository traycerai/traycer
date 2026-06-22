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
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
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
