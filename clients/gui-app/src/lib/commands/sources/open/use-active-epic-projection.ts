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
import type {
  OpenEpicState,
  OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";

/**
 * The epic's CURRENT session handle, re-answered when a re-point swaps it.
 *
 * Two tiers deliberately, the same shape `useEpicChatProjections` and
 * `useChatSessionProjection` use: the outer store is the REGISTRY (whose
 * `emit()` fires on `replaceMounted`), and only the handle it yields is
 * closed over by the inner subscription below. A single tier that resolved
 * the handle INSIDE a `subscribe` keyed on `epicId` is the defect this shape
 * exists to prevent - the deps never change across a re-point, so React never
 * re-runs `subscribe` and the hook stays bound to the OUTGOING handle's
 * store. The next registry `emit()` refreshes the snapshot exactly once and
 * then goes quiet, because the registry's own subscription is
 * eligibility-keyed and deliberately does not fire on ordinary projection
 * mutations. The palette's chats/artifacts/files/TUI lists would freeze at
 * that one snapshot until the sub-page remounted.
 *
 * `peek` rather than `get`: these are passive projections, and `getSnapshot`
 * runs on every render. `get()` stamps `lastUsedAt`, so reading a list in the
 * palette would keep an epic at the head of the MRU purely because React
 * rendered - which is the misuse `peek`'s own doc names. Nothing open in a
 * tab is at risk from the weaker claim: `prune()` skips any entry with
 * mounted refs, an unclean handle, or active agent work.
 */
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
 * The host that SERVES the active epic's projection - the one its session
 * handle was acquired against - for the opener sub-pages to stamp into the
 * tiles they open and to address the epic's own host-scoped reads.
 *
 * NOT the app-wide addressable host, which is what these sub-pages read
 * before PR #1243: during an A→B re-point the A-backed Epic keeps its
 * projection rendered while the addressable host already answers B, so an
 * artifact opened from the palette became a B-bound tile over A's record -
 * bound for life (the same defect `useEpicArtifactRecords` carried). The
 * handle→host binding is write-once per handle; the handle above is
 * registry-subscribed, so a re-point that swaps it re-answers.
 */
export function useActiveEpicHostId(epicId: string | null): string | null {
  const handle = useActiveEpicHandle(epicId);
  return handle === null ? null : getEpicSessionHandleHostId(handle);
}
