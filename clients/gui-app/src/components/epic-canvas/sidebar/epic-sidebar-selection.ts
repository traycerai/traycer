import {
  createContext,
  createElement,
  use,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from "react";
import type { EpicTreeIndex } from "@/lib/epic-selectors";
import { sortNodeIds, type NodeComparator } from "@/lib/epic-sort";
import { withMemberToggled } from "@/lib/immutable-set";

export type SidebarBulkSelectionPanelId = "chats" | "artifacts";

export type SidebarTreeFilterFn = (type: string | null | undefined) => boolean;

interface SidebarBulkSelectionProviderProps {
  readonly panelId: SidebarBulkSelectionPanelId;
  readonly collapsed: boolean;
  readonly children: ReactNode;
}

interface SidebarBulkSelectionState {
  readonly selectionMode: boolean;
  readonly selectedIds: ReadonlySet<string>;
  readonly selectableIds: readonly string[];
  readonly pendingDeleteIds: readonly string[] | null;
  readonly deletePending: boolean;
}

type SidebarBulkSelectionAction =
  | { readonly type: "enter" }
  | { readonly type: "cancel" }
  | { readonly type: "toggle"; readonly id: string }
  | { readonly type: "selectAll" }
  | { readonly type: "deselectAll" }
  | { readonly type: "setSelectable"; readonly ids: readonly string[] }
  | { readonly type: "requestDelete"; readonly ids: readonly string[] }
  | { readonly type: "closeDelete" }
  | { readonly type: "setDeletePending"; readonly pending: boolean }
  | { readonly type: "clearSelected"; readonly ids: readonly string[] }
  | { readonly type: "reset" };

export interface SidebarBulkSelectionValue {
  readonly panelId: SidebarBulkSelectionPanelId;
  readonly selectionMode: boolean;
  readonly selectedIds: ReadonlySet<string>;
  readonly selectableIds: readonly string[];
  readonly selectedVisibleIds: readonly string[];
  readonly selectedCount: number;
  readonly canSelect: boolean;
  readonly allVisibleSelected: boolean;
  readonly pendingDeleteIds: readonly string[] | null;
  readonly deletePending: boolean;
  readonly enterSelectionMode: () => void;
  readonly cancelSelection: () => void;
  readonly toggleSelection: (id: string) => void;
  readonly selectAllVisible: () => void;
  readonly deselectAllVisible: () => void;
  readonly setSelectableIds: (ids: readonly string[]) => void;
  readonly requestDeleteSelected: () => void;
  readonly closeDeleteDialog: () => void;
  readonly setDeletePending: (pending: boolean) => void;
  readonly clearSelectedIds: (ids: readonly string[]) => void;
  readonly resetSelection: () => void;
}

const EMPTY_SELECTED_IDS: ReadonlySet<string> = new Set();
const EMPTY_SELECTABLE_IDS: readonly string[] = Object.freeze([]);
const EMPTY_TREE_IDS: readonly string[] = Object.freeze([]);

const INITIAL_SELECTION_STATE: SidebarBulkSelectionState = {
  selectionMode: false,
  selectedIds: EMPTY_SELECTED_IDS,
  selectableIds: EMPTY_SELECTABLE_IDS,
  pendingDeleteIds: null,
  deletePending: false,
};

const SidebarBulkSelectionContext =
  createContext<SidebarBulkSelectionValue | null>(null);

export function isSidebarBulkSelectionPanelId(
  panelId: string,
): panelId is SidebarBulkSelectionPanelId {
  return panelId === "chats" || panelId === "artifacts";
}

export function SidebarBulkSelectionProvider(
  props: SidebarBulkSelectionProviderProps,
): ReactNode {
  const [state, dispatch] = useReducer(
    sidebarBulkSelectionReducer,
    INITIAL_SELECTION_STATE,
  );

  useEffect(() => {
    if (props.collapsed) dispatch({ type: "reset" });
  }, [props.collapsed]);

  const selectedVisibleIds = useMemo(
    () =>
      state.selectableIds.reduce<string[]>((ids, id) => {
        if (state.selectedIds.has(id)) ids.push(id);
        return ids;
      }, []),
    [state.selectableIds, state.selectedIds],
  );

  const enterSelectionMode = useCallback(() => {
    dispatch({ type: "enter" });
  }, []);

  const cancelSelection = useCallback(() => {
    dispatch({ type: "cancel" });
  }, []);

  const toggleSelection = useCallback((id: string) => {
    dispatch({ type: "toggle", id });
  }, []);

  const selectAllVisible = useCallback(() => {
    dispatch({ type: "selectAll" });
  }, []);

  const deselectAllVisible = useCallback(() => {
    dispatch({ type: "deselectAll" });
  }, []);

  const setSelectableIds = useCallback((ids: readonly string[]) => {
    dispatch({ type: "setSelectable", ids });
  }, []);

  const requestDeleteSelected = useCallback(() => {
    dispatch({ type: "requestDelete", ids: selectedVisibleIds });
  }, [selectedVisibleIds]);

  const closeDeleteDialog = useCallback(() => {
    dispatch({ type: "closeDelete" });
  }, []);

  const setDeletePending = useCallback((pending: boolean) => {
    dispatch({ type: "setDeletePending", pending });
  }, []);

  const clearSelectedIds = useCallback((ids: readonly string[]) => {
    dispatch({ type: "clearSelected", ids });
  }, []);

  const resetSelection = useCallback(() => {
    dispatch({ type: "reset" });
  }, []);

  const value = useMemo<SidebarBulkSelectionValue>(
    () => ({
      panelId: props.panelId,
      selectionMode: state.selectionMode,
      selectedIds: state.selectedIds,
      selectableIds: state.selectableIds,
      selectedVisibleIds,
      selectedCount: selectedVisibleIds.length,
      canSelect: state.selectableIds.length > 0,
      allVisibleSelected:
        state.selectableIds.length > 0 &&
        selectedVisibleIds.length === state.selectableIds.length,
      pendingDeleteIds: state.pendingDeleteIds,
      deletePending: state.deletePending,
      enterSelectionMode,
      cancelSelection,
      toggleSelection,
      selectAllVisible,
      deselectAllVisible,
      setSelectableIds,
      requestDeleteSelected,
      closeDeleteDialog,
      setDeletePending,
      clearSelectedIds,
      resetSelection,
    }),
    [
      props.panelId,
      state.selectionMode,
      state.selectedIds,
      state.selectableIds,
      selectedVisibleIds,
      state.pendingDeleteIds,
      state.deletePending,
      enterSelectionMode,
      cancelSelection,
      toggleSelection,
      selectAllVisible,
      deselectAllVisible,
      setSelectableIds,
      requestDeleteSelected,
      closeDeleteDialog,
      setDeletePending,
      clearSelectedIds,
      resetSelection,
    ],
  );

  return createElement(
    SidebarBulkSelectionContext.Provider,
    { value },
    props.children,
  );
}

export function useSidebarBulkSelection(): SidebarBulkSelectionValue {
  const context = use(SidebarBulkSelectionContext);
  if (context === null) {
    throw new Error(
      "useSidebarBulkSelection must be used inside SidebarBulkSelectionProvider",
    );
  }
  return context;
}

export function useMaybeSidebarBulkSelection(): SidebarBulkSelectionValue | null {
  return use(SidebarBulkSelectionContext);
}

export function collectVisibleSidebarTreeIds(args: {
  readonly rootIds: readonly string[];
  readonly expandedIds: ReadonlySet<string>;
  readonly tree: EpicTreeIndex;
  readonly treeFilter: SidebarTreeFilterFn;
  readonly visibleIds: ReadonlySet<string> | null;
  readonly comparator: NodeComparator | null;
}): readonly string[] {
  const results: string[] = [];
  const visit = (nodeId: string): void => {
    if (!Object.hasOwn(args.tree.nodeById, nodeId)) return;
    const node = args.tree.nodeById[nodeId];
    if (!args.treeFilter(node.type)) return;
    if (args.visibleIds !== null && !args.visibleIds.has(nodeId)) return;
    results.push(nodeId);
    if (!args.expandedIds.has(nodeId)) return;
    const childIds = args.tree.childrenByParent[nodeId] ?? EMPTY_TREE_IDS;
    const visibleChildIds = childIds.reduce<string[]>((ids, childId) => {
      if (!Object.hasOwn(args.tree.nodeById, childId)) return ids;
      if (!args.treeFilter(args.tree.nodeById[childId].type)) return ids;
      if (args.visibleIds !== null && !args.visibleIds.has(childId)) {
        return ids;
      }
      ids.push(childId);
      return ids;
    }, []);
    sortNodeIds(visibleChildIds, args.tree.nodeById, args.comparator).forEach(
      visit,
    );
  };
  args.rootIds.forEach(visit);
  return results;
}

export function rootmostSelectedSidebarIds(args: {
  readonly ids: readonly string[];
  readonly tree: EpicTreeIndex;
}): readonly string[] {
  const selectedIds = new Set(args.ids);
  return args.ids.filter(
    (id) => !hasSelectedAncestor(id, selectedIds, args.tree),
  );
}

function sidebarBulkSelectionReducer(
  state: SidebarBulkSelectionState,
  action: SidebarBulkSelectionAction,
): SidebarBulkSelectionState {
  switch (action.type) {
    case "enter":
      return enterSidebarBulkSelection(state);
    case "cancel":
      return {
        ...state,
        selectionMode: false,
        selectedIds: new Set(),
        pendingDeleteIds: null,
      };
    case "toggle": {
      if (!state.selectableIds.includes(action.id)) return state;
      const nextSelectedIds = withMemberToggled(state.selectedIds, action.id);
      return {
        ...state,
        selectionMode: true,
        selectedIds: nextSelectedIds,
        pendingDeleteIds: null,
      };
    }
    case "selectAll":
      return { ...state, selectedIds: new Set(state.selectableIds) };
    case "deselectAll":
      // Clear every check but stay in selection mode (unlike `clearSelected`,
      // which exits when the set empties) so the toolbar's "Deselect all" is a
      // pure toggle back to "Select all" without dropping the user out.
      if (state.selectedIds.size === 0) return state;
      return { ...state, selectedIds: new Set() };
    case "setSelectable":
      if (sameStringArray(state.selectableIds, action.ids)) return state;
      return {
        ...state,
        selectableIds: action.ids,
        selectedIds: selectedIdsVisibleIn(action.ids, state.selectedIds),
      };
    case "requestDelete":
      if (action.ids.length === 0) return state;
      return { ...state, pendingDeleteIds: [...action.ids] };
    case "closeDelete":
      return { ...state, pendingDeleteIds: null };
    case "setDeletePending":
      return { ...state, deletePending: action.pending };
    case "clearSelected":
      return clearSelectedIds(state, action.ids);
    case "reset":
      return INITIAL_SELECTION_STATE;
  }
}

function enterSidebarBulkSelection(
  state: SidebarBulkSelectionState,
): SidebarBulkSelectionState {
  if (state.selectableIds.length === 0) return state;
  return {
    ...state,
    selectionMode: true,
    selectedIds: new Set(),
    pendingDeleteIds: null,
  };
}

function clearSelectedIds(
  state: SidebarBulkSelectionState,
  ids: readonly string[],
): SidebarBulkSelectionState {
  if (ids.length === 0) return state;
  const idsToRemove = new Set(ids);
  const nextSelectedIds = [...state.selectedIds].reduce<Set<string>>(
    (next, id) => {
      if (!idsToRemove.has(id)) next.add(id);
      return next;
    },
    new Set(),
  );
  if (nextSelectedIds.size === state.selectedIds.size) return state;
  return {
    ...state,
    selectedIds: nextSelectedIds,
    selectionMode: nextSelectedIds.size > 0,
    pendingDeleteIds: null,
  };
}

function selectedIdsVisibleIn(
  selectableIds: readonly string[],
  selectedIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const selectableIdSet = new Set(selectableIds);
  return [...selectedIds].reduce<Set<string>>((next, id) => {
    if (selectableIdSet.has(id)) next.add(id);
    return next;
  }, new Set());
}

function hasSelectedAncestor(
  id: string,
  selectedIds: ReadonlySet<string>,
  tree: EpicTreeIndex,
): boolean {
  if (!Object.hasOwn(tree.nodeById, id)) return false;
  let parentId = tree.nodeById[id].parentId;
  while (parentId !== null) {
    if (selectedIds.has(parentId)) return true;
    if (!Object.hasOwn(tree.nodeById, parentId)) return false;
    parentId = tree.nodeById[parentId].parentId;
  }
  return false;
}

function sameStringArray(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}
