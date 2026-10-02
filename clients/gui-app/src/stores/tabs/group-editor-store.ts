import { createContext, use, useEffect, useId } from "react";
import { create } from "zustand";

/**
 * Which tab group editor is open. The editor is a popover anchored to a group's
 * header, label, rail column or chip, but a task's "Edit group…" (tab
 * appearance menu) has no anchor to open it on, so the open state lives here:
 * the anchor and the menu both write it, and the anchor shows the popover.
 * Transient, never persisted; one editor at a time.
 *
 * The state is per anchor, not per group: the Activity view draws a group's
 * block in every section that holds its tasks, and only the one asked from
 * opens. A block or rail column names its anchor for everything inside it
 * (`GroupEditorScope`), so a task's "Edit group…" opens at its own block; a
 * task outside any (the top strip's) opens at its group's anchor.
 *
 * Only a mounted anchor can show the editor, so the anchors register: a menu
 * offers "Edit group…" only while it has an anchor to open, and an editor
 * closes with its anchor, so a later anchor never mounts already open.
 *
 * The menu only requests the editor. A closing menu keeps its exit animation
 * and takes focus back from anything that opens meanwhile, which dismisses a
 * popover, so the menu opens the request once it is gone
 * (`TabContextMenuContent`'s `onCloseAutoFocus`).
 */
interface GroupEditorState {
  /** The anchor whose editor is open. */
  readonly anchorId: string | null;
  readonly requestedAnchorId: string | null;
  /** Each mounted anchor's group. */
  readonly anchors: Readonly<Record<string, string>>;
  readonly setOpen: (anchorId: string, open: boolean) => void;
  readonly request: (anchorId: string) => void;
  readonly openRequested: () => void;
  /** Registers an anchor; the returned function removes it. */
  readonly mountAnchor: (anchorId: string, groupId: string) => () => void;
}

export const useGroupEditorStore = create<GroupEditorState>((set) => ({
  anchorId: null,
  requestedAnchorId: null,
  anchors: {},
  setOpen: (anchorId, open) =>
    set((state) => {
      if (open) return { anchorId };
      return state.anchorId === anchorId ? { anchorId: null } : state;
    }),
  request: (anchorId) => set({ requestedAnchorId: anchorId }),
  openRequested: () =>
    set((state) => {
      const requested = state.requestedAnchorId;
      if (requested === null) return state;
      return requested in state.anchors
        ? { anchorId: requested, requestedAnchorId: null }
        : { requestedAnchorId: null };
    }),
  mountAnchor: (anchorId, groupId) => {
    set((state) => ({ anchors: { ...state.anchors, [anchorId]: groupId } }));
    return () =>
      set((state) => {
        const { [anchorId]: _removed, ...anchors } = state.anchors;
        return state.anchorId === anchorId
          ? { anchors, anchorId: null }
          : { anchors };
      });
  },
}));

/**
 * The anchor a group's block or rail column puts its editor on, for the anchor
 * itself and for "Edit group…" on the tasks inside it.
 */
export const GroupEditorScope = createContext<string | null>(null);

/**
 * The anchor "Edit group…" opens for a task in `groupId`: its block's or
 * column's, else the group's own, or `null` when none is mounted.
 */
export function useGroupEditorTarget(groupId: string | null): string | null {
  const scope = use(GroupEditorScope);
  return useGroupEditorStore((state) => {
    if (groupId === null) return null;
    if (scope !== null) return state.anchors[scope] === groupId ? scope : null;
    return (
      Object.keys(state.anchors).find((id) => state.anchors[id] === groupId) ??
      null
    );
  });
}

/**
 * An anchor's hold on its group's editor: whether it is open, and the
 * popover's `onOpenChange`. Inside a block or column it is that scope's anchor.
 */
export function useGroupEditor(groupId: string): {
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
} {
  const ownId = useId();
  const anchorId = use(GroupEditorScope) ?? ownId;
  const open = useGroupEditorStore((state) => state.anchorId === anchorId);
  const setOpen = useGroupEditorStore((state) => state.setOpen);
  const mountAnchor = useGroupEditorStore((state) => state.mountAnchor);
  useEffect(
    () => mountAnchor(anchorId, groupId),
    [mountAnchor, anchorId, groupId],
  );
  return { open, setOpen: (next) => setOpen(anchorId, next) };
}
