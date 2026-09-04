/**
 * Single React hook for reading the active per-Epic store. Resolves the
 * handle from `EpicSessionContext` and delegates to Zustand's `useStore`,
 * so call-sites look like a regular Zustand selector hook:
 *
 *   const title = useEpicStore(s => s.epic.title);
 *   const ids   = useEpicStore(s => s.tree.rootIds);
 *
 * For object-shaped selectors that would otherwise return a fresh object
 * every render, wrap with `useShallow` from `zustand/react/shallow`:
 *
 *   const { chat, childIds } = useEpicStore(useShallow(
 *     s => ({ chat: s.chats.byId[id], childIds: s.tree.childrenByParent[id] }),
 *   ));
 *
 * Chat message rows are owned by `chat.subscribe`; do not project them through
 * this root Epic store.
 */
import { useCallback, useSyncExternalStore } from "react";
import { useStore } from "zustand";
import {
  useMaybeOpenEpicHandle,
  useOpenEpicHandle,
} from "@/providers/use-open-epic-handle";
import type { OpenEpicState } from "@/stores/epics/open-epic/store";

export function useEpicStore<T>(selector: (state: OpenEpicState) => T): T {
  const handle = useOpenEpicHandle();
  return useStore(handle.store, selector);
}

/**
 * The tolerant read, for surfaces that legitimately mount OUTSIDE an
 * `<EpicSessionProvider>` and still want the open epic's answer when there is
 * one - the Epic sidebar is a sibling of the canvas, and a split surface can
 * mount it before (or without) a session in context.
 *
 * `fallback` is returned whole while there is no session, so callers state the
 * no-epic answer explicitly instead of inheriting whatever a partial state
 * would have produced. Selectors passed here must return a PRIMITIVE: the
 * snapshot is read on every store notification and an object literal would
 * hand `useSyncExternalStore` a fresh reference each time (see
 * `epic-selectors.ts`'s `useShallow` rule, which has no equivalent here).
 */
export function useMaybeEpicStore<T extends string | number | boolean | null>(
  selector: (state: OpenEpicState) => T,
  fallback: T,
): T {
  const handle = useMaybeOpenEpicHandle();
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (handle === null) return () => undefined;
      return handle.store.subscribe(onChange);
    },
    [handle],
  );
  const getSnapshot = useCallback(
    () => (handle === null ? fallback : selector(handle.store.getState())),
    [handle, selector, fallback],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
