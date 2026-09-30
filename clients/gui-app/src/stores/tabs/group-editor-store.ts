import { useEffect } from "react";
import { create } from "zustand";

/**
 * Which tab group's editor is open. The editor is a popover anchored to the
 * group's header or chip, but a task's "Edit group…" (tab appearance menu) has
 * no header to open it on, so the open state lives here: the anchor and the
 * menu both write it, and the anchor shows the popover. Transient, never
 * persisted; one editor at a time.
 *
 * Only a mounted anchor can show the editor, so the anchors count themselves
 * in: a menu offers "Edit group…" only while its group has one (the Activity
 * view draws none), and an editor closes with its group's last anchor, so a
 * later anchor never mounts already open.
 *
 * The menu only requests the editor. A closing menu keeps its exit animation
 * and takes focus back from anything that opens meanwhile, which dismisses a
 * popover, so the menu opens the request once it is gone
 * (`TabContextMenuContent`'s `onCloseAutoFocus`).
 */
interface GroupEditorState {
  readonly groupId: string | null;
  readonly requestedGroupId: string | null;
  /** How many anchors each group has mounted. */
  readonly anchors: Readonly<Record<string, number>>;
  readonly setOpen: (groupId: string, open: boolean) => void;
  readonly request: (groupId: string) => void;
  readonly openRequested: () => void;
  /** Counts an anchor in; the returned function counts it out. */
  readonly mountAnchor: (groupId: string) => () => void;
}

export const useGroupEditorStore = create<GroupEditorState>((set) => ({
  groupId: null,
  requestedGroupId: null,
  anchors: {},
  setOpen: (groupId, open) =>
    set((state) => {
      if (open) return { groupId };
      return state.groupId === groupId ? { groupId: null } : state;
    }),
  request: (groupId) => set({ requestedGroupId: groupId }),
  openRequested: () =>
    set((state) => {
      const requested = state.requestedGroupId;
      if (requested === null) return state;
      return (state.anchors[requested] ?? 0) > 0
        ? { groupId: requested, requestedGroupId: null }
        : { requestedGroupId: null };
    }),
  mountAnchor: (groupId) => {
    set((state) => ({
      anchors: {
        ...state.anchors,
        [groupId]: (state.anchors[groupId] ?? 0) + 1,
      },
    }));
    return () =>
      set((state) => {
        const left = (state.anchors[groupId] ?? 1) - 1;
        const anchors = { ...state.anchors, [groupId]: left };
        return left === 0 && state.groupId === groupId
          ? { anchors, groupId: null }
          : { anchors };
      });
  },
}));

/** Whether a group has an anchor its editor can open on. */
export function useGroupEditorAnchored(groupId: string | null): boolean {
  return useGroupEditorStore(
    (state) => groupId !== null && (state.anchors[groupId] ?? 0) > 0,
  );
}

/**
 * An anchor's hold on its group's editor: whether it is open, and the
 * popover's `onOpenChange`.
 */
export function useGroupEditor(groupId: string): {
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
} {
  const open = useGroupEditorStore((state) => state.groupId === groupId);
  const setOpen = useGroupEditorStore((state) => state.setOpen);
  const mountAnchor = useGroupEditorStore((state) => state.mountAnchor);
  useEffect(() => mountAnchor(groupId), [mountAnchor, groupId]);
  return { open, setOpen: (next) => setOpen(groupId, next) };
}
