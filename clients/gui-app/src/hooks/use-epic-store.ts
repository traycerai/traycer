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
import { useStore } from "zustand";
import { useOpenEpicHandle } from "@/providers/use-open-epic-handle";
import type { OpenEpicState } from "@/stores/epics/open-epic/store";

export function useEpicStore<T>(selector: (state: OpenEpicState) => T): T {
  const handle = useOpenEpicHandle();
  return useStore(handle.store, selector);
}
