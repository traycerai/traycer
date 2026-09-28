import { useMemo } from "react";
import {
  areRailsEqual,
  panelVisibilityOverridesFromValues,
  railRegionForLeftPanelId,
  railVisibilityFor,
  type RailEntry,
} from "@/lib/layout/rail";
import { effectiveLayoutValues } from "@/lib/layout/layout-presets";
import {
  writeArrangement,
  writeArrangementField,
} from "@/lib/layout/arrangement-gestures";
import {
  unstackRailPanel,
  type EdgeSide,
  type LayoutArrangement,
} from "@/lib/layout/layout-arrangement";
import type {
  LeftPanelId,
  PanelVisibilityOverrideById,
} from "@/lib/left-panel-ids";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import { useLayoutStore } from "@/stores/layout/layout-store";

/**
 * The sidebar rail's shape, read and written where it actually lives.
 *
 * `arrangement.rail` and the nine rail regions' `shown` are the layout store's
 * (L-25, L-47), and every sidebar surface reads them from here. This module is
 * that read and its writers, beside the bijection itself.
 *
 * It used to hang off `LeftPanelStore` as five members that each reached into
 * the layout store from inside a zustand action. That API lied about
 * ownership - a reader of the panel store believed it held rail shape - and
 * one of them, "clear every override", looped nine separate writes, which is
 * nine renders and, once a gesture is recorded, nine undo steps (G1-09).
 *
 * The two WRITERS go through `recordGesture`, like every other writer of the
 * same values (`inspector/region-control-io.ts`, `region-quick-verbs.tsx`).
 * That is not decoration: `watchExternalLayoutWrites` reads a write made
 * outside the editor's own depth as ANOTHER WINDOW's and rebases the entry
 * snapshot onto it, so a hide made from the rail's menu during a session was
 * neither undoable nor discardable (L-18, L-150(1)). `recordGesture` with no
 * session open is a pass-through, so the real sidebar's behaviour at rest is
 * exactly what it was.
 *
 * That the editor store is imported from here rather than the write being
 * recorded at the menu is the layering this module already sits in:
 * `lib/layout/editor-session.ts` and `editor-lease.ts` are the session's own
 * seams and import the same store, and putting the recording at the two menu
 * call sites instead would leave the next caller of these functions with the
 * same hole.
 */

/**
 * The rail's entries, for every surface that draws it: the epic sidebar's icon
 * column, the sample workspace's copy of it and the inspector's own picture.
 *
 * Served here because this module is the rail's own ancestor seam - what it
 * answers is which panels EXIST and in what order, and D11 keeps a specimen's
 * preview out of a read that decides a mount.
 */
export function useLayoutRail(): ReadonlyArray<RailEntry> {
  return useLayoutStore((state) => state.arrangement.rail);
}

/** The whole arrangement, for the non-React commit layer (canvas DnD). */
export function currentLayoutArrangement(): LayoutArrangement {
  return useLayoutStore.getState().arrangement;
}

/**
 * The nine rail regions' three-state `shown` as the sparse show/hide map every
 * sidebar render path already reads (`isLeftPanelVisible`).
 */
export function usePanelVisibilityOverrides(): PanelVisibilityOverrideById {
  const basePreset = useLayoutStore((state) => state.basePreset);
  const overrides = useLayoutStore((state) => state.overrides);
  return useMemo(
    () =>
      panelVisibilityOverridesFromValues(
        effectiveLayoutValues(basePreset, overrides),
      ),
    [basePreset, overrides],
  );
}

/**
 * A new rail order written back, in one write.
 *
 * Guarded, so a drop that lands a panel back where it already was writes
 * nothing and spends no undo step on it.
 */
export function applyRail(nextRail: ReadonlyArray<RailEntry>): void {
  const arrangement = useLayoutStore.getState().arrangement;
  if (areRailsEqual(arrangement.rail, nextRail)) return;
  useLayoutStore.getState().setArrangement({ ...arrangement, rail: nextRail });
}

/**
 * One panel's Hide/Show, or `null` to put it back on its own presence rule
 * (L-47). Callers pass `null` whenever the value they are setting already
 * matches that rule, keeping the delta to real preferences.
 *
 * `null` is not a pick, it is the ABSENCE of one, so it is a revert and takes
 * the answer out of the delta (L-133): recording `auto` would store a pick
 * that pins the panel against the day a preset sets a rail region to anything
 * else.
 */
export function setRailVisibilityOverride(
  panelId: LeftPanelId,
  override: boolean | null,
): void {
  const regionId = railRegionForLeftPanelId(panelId);
  useLayoutEditorStore.getState().recordGesture(() => {
    if (override === null) {
      useLayoutStore.getState().clearRegionValues(regionId, ["shown"]);
      return;
    }
    useLayoutStore
      .getState()
      .setRegionValues(regionId, { shown: railVisibilityFor(override) });
  });
}

/**
 * One panel taken out of its stack from the rail's own menu (L-181), as one
 * recorded gesture: an Undo step in a session, a plain write at rest.
 */
export function unstackRailMember(panelId: LeftPanelId): void {
  const arrangement = useLayoutStore.getState().arrangement;
  const next = unstackRailPanel(arrangement, railRegionForLeftPanelId(panelId));
  if (next !== arrangement) writeArrangement(next);
}

/**
 * The per-epic sidebar's side (S-06), written from the rail's own "Move
 * sidebar to..." menu item (S-32) through `writeArrangementField`, the
 * surface placements' one writer (D14).
 */
export function setSidebarSide(side: EdgeSide): void {
  writeArrangementField("sidebarSide", side);
}
