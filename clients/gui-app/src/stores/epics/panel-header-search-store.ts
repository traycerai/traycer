/**
 * Ephemeral per-panel "header search" state for the Epic left sidebar.
 *
 * A panel that opts in (`supportsHeaderSearch`) trades its whole header row -
 * chevron, icon, title, actions - for a search input while searching, instead
 * of stacking a permanently-visible box underneath it. That keeps the resting
 * panel one row taller and stops a rarely-used mode from carrying constant
 * visual weight.
 *
 * State lives here rather than in `left-panel-store` because none of it should
 * persist: reopening the app should land you in browse mode, never in a
 * half-typed search. `slotByPanelId` holds the header's live portal target, so
 * the owning search component can keep its input, results, refs, and combobox
 * ARIA wiring in ONE component while the input's DOM renders up in the header.
 */
import { create } from "zustand";
import type { LeftPanelId } from "@/stores/epics/left-panel-store";

interface PanelHeaderSearchStore {
  readonly openByPanelId: Readonly<Partial<Record<LeftPanelId, boolean>>>;
  readonly queryByPanelId: Readonly<Partial<Record<LeftPanelId, string>>>;
  readonly slotByPanelId: Readonly<Partial<Record<LeftPanelId, HTMLElement>>>;

  /**
   * Enter search mode. `seed` is the character that triggered it for the
   * type-to-filter path (the keystroke would otherwise be swallowed by the
   * focus handoff), or "" when opened from the header icon.
   */
  readonly openSearch: (panelId: LeftPanelId, seed: string) => void;
  readonly closeSearch: (panelId: LeftPanelId) => void;
  readonly setSearchQuery: (panelId: LeftPanelId, query: string) => void;
  /** Ref-callback sink for the header's portal target; `null` on unmount. */
  readonly setSearchSlot: (
    panelId: LeftPanelId,
    element: HTMLElement | null,
  ) => void;
}

function withoutKey<T>(
  record: Readonly<Partial<Record<LeftPanelId, T>>>,
  panelId: LeftPanelId,
): Readonly<Partial<Record<LeftPanelId, T>>> {
  if (!Object.hasOwn(record, panelId)) return record;
  const { [panelId]: _dropped, ...rest } = record;
  return rest;
}

export const usePanelHeaderSearchStore = create<PanelHeaderSearchStore>(
  (set) => ({
    openByPanelId: {},
    queryByPanelId: {},
    slotByPanelId: {},

    openSearch: (panelId, seed) =>
      set((state) => ({
        openByPanelId: { ...state.openByPanelId, [panelId]: true },
        queryByPanelId: { ...state.queryByPanelId, [panelId]: seed },
      })),

    closeSearch: (panelId) =>
      set((state) => ({
        openByPanelId: withoutKey(state.openByPanelId, panelId),
        queryByPanelId: withoutKey(state.queryByPanelId, panelId),
      })),

    setSearchQuery: (panelId, query) =>
      set((state) => ({
        queryByPanelId: { ...state.queryByPanelId, [panelId]: query },
      })),

    setSearchSlot: (panelId, element) =>
      set((state) => ({
        slotByPanelId:
          element === null
            ? withoutKey(state.slotByPanelId, panelId)
            : { ...state.slotByPanelId, [panelId]: element },
      })),
  }),
);

export function usePanelHeaderSearchOpen(panelId: LeftPanelId): boolean {
  return usePanelHeaderSearchStore(
    (state) => state.openByPanelId[panelId] === true,
  );
}

export function usePanelHeaderSearchQuery(panelId: LeftPanelId): string {
  return usePanelHeaderSearchStore(
    (state) => state.queryByPanelId[panelId] ?? "",
  );
}

export function usePanelHeaderSearchSlot(
  panelId: LeftPanelId,
): HTMLElement | null {
  return usePanelHeaderSearchStore(
    (state) => state.slotByPanelId[panelId] ?? null,
  );
}
