import { useEffect } from "react";
import "@/components/layout-editor/layout-editor.css";
import {
  cancelLayoutDrag,
  layoutDragActive,
} from "@/components/layout-editor/canvas/drag-engine";
import {
  createHoverChip,
  type HoverChipPlacement,
} from "@/components/layout-editor/canvas/hover-chip";
import { armCanvasDrag } from "@/components/layout-editor/canvas/region-drag";
import { createSelectionRing } from "@/components/layout-editor/canvas/selection-ring";
import { armSurfaceDrag } from "@/components/layout-editor/canvas/surface-drag";
import { SURFACE_PLACEMENT } from "@/components/layout-editor/canvas/surface-placement";
import {
  LAYOUT_REGION_IDS,
  regionFacts,
  regionStateWord,
} from "@/components/layout-editor/regions/region-facts";
import { decoratedHoverRegion } from "@/components/layout-editor/use-layout-region";
import { layoutTransitionRunning } from "@/lib/layout/editor-motion";
import { effectiveLayoutValues } from "@/lib/layout/layout-presets";
import type { LayoutSnapshot } from "@/lib/layout/layout-snapshot";
import { RAIL_REGION_IDS, railStackMembersFor } from "@/lib/layout/rail";
import type { RegionId } from "@/lib/layout/region-id";
import {
  preferredRegionInstance,
  useLayoutEditorStore,
  type LayoutEditorState,
  type LayoutSettingId,
  type PlacementSurfaceId,
} from "@/stores/layout/layout-editor-store";
import {
  SIDE_STRIP_VIEW_AT_TOP,
  SIDE_STRIP_VIEW_COLLAPSED,
  SIDE_STRIP_VIEW_OPTIONS,
} from "@/components/layout-editor/regions/region-grammar";
import { LAYOUT } from "@/components/settings/panels/layout-settings.definitions";
import { getLayoutSnapshot } from "@/stores/layout/layout-store";

/**
 * The canvas half of an editor session: what the pointer is on, and where the
 * two overlays sit (4.2, 4.3, 4.6).
 *
 * It owns nothing about the app's elements. `use-layout-region.ts` stamps the
 * hover, selection and anchor attributes onto every instance of a region from
 * the same store, so every copy of a setting lights up together (L-23); this
 * hook adds the two things a stylesheet cannot do - the chip that names what
 * the pointer is on, and the one ring that travels between selections.
 *
 * Pointer resolution lives on `document` in the capture phase rather than on
 * the column, because the edit firewall (ticket 07) sits on the column and
 * stops immediate propagation there: a capture listener one level up reads the
 * gesture before the firewall swallows it, whatever order the two mount in.
 *
 * Call it unconditionally - it does nothing until a session opens, and tears
 * every overlay and listener down when one closes.
 */
export function useLayoutCanvas(column: HTMLElement | null): void {
  const live = useLayoutEditorStore((state) => state.session !== null);

  useEffect(() => {
    if (!live || column === null) return;
    // What the decoration CSS scopes everything to. Written here rather than
    // in the shell's markup so it can never outlive the session that needs it.
    column.setAttribute("data-layout-editing", "1");
    const chip = createHoverChip();
    const ring = createSelectionRing();
    // The chip's text, computed per hovered region and only when it can have
    // moved. `paint` runs on EVERY editor-store notification - each pointer
    // move that changes the hovered region, each filter keystroke, each
    // selection change while the pointer rests on a region - and building the
    // label means building the whole 22-region value set to read one region's
    // state word (G1-04's rule, which `layout-form.tsx` follows in this
    // same commit). The label changes only when the pointer moves to another
    // region or the layout is written, so those are the two things this
    // remembers.
    let lastLabel: {
      readonly regionId: RegionId;
      readonly snapshot: LayoutSnapshot;
      readonly label: string;
    } | null = null;
    const labelFor = (regionId: RegionId): string => {
      const snapshot = getLayoutSnapshot();
      if (
        lastLabel !== null &&
        lastLabel.regionId === regionId &&
        sameLayout(lastLabel.snapshot, snapshot)
      )
        return lastLabel.label;
      const label = hoverChipLabel(regionId, snapshot);
      lastLabel = { regionId, snapshot, label };
      return label;
    };

    // Fixed chrome the canvas names without it being a setting (C4): the
    // Message queue says it is always there, and a press on it selects nothing.
    let cue: HTMLElement | null = null;
    const setCue = (next: HTMLElement | null): void => {
      if (next === cue) return;
      cue?.removeAttribute("data-layout-anchor");
      cue = next;
      cue?.setAttribute("data-layout-anchor", "hover");
      paint();
    };

    // The node a setting's chip is anchored to: its part, or the strip when
    // there is no room for the part. Stamped like the cue, since neither is a
    // region `use-layout-region.ts` decorates.
    let settingAnchor: HTMLElement | null = null;
    const anchorSettingChip = (next: HTMLElement | null): void => {
      if (next === settingAnchor) return;
      settingAnchor?.removeAttribute("data-layout-anchor");
      settingAnchor = next;
      settingAnchor?.setAttribute("data-layout-anchor", "hover");
    };

    const paint = (): void => {
      const state = useLayoutEditorStore.getState();
      const hoveredRegion = decoratedHoverRegion(state);
      const hovered =
        hoveredRegion === null
          ? null
          : preferredRegionInstance(state, hoveredRegion);
      const setting =
        hoveredRegion === null && cue === null ? settingChip(state) : null;
      anchorSettingChip(setting?.node ?? null);
      if (setting !== null) chip.show(setting);
      else if (hoveredRegion === null && cue !== null)
        chip.show({
          label: cue.getAttribute("data-layout-cue") ?? "",
          node: cue,
          placement: "above",
        });
      else if (hoveredRegion === null || hovered === null) chip.hide();
      else
        chip.show({
          label: labelFor(hoveredRegion),
          node: hovered.node,
          placement: chipPlacement(hoveredRegion),
        });
      // Identity-guarded inside the controller, so this costs nothing on the
      // notifications that did not move the selection. Where the ring's node
      // IS is not this hook's business at all: the controller re-reads the
      // rect every frame, so every reflow of the canvas under it is followed
      // without anything here having to notice one (L-90). A placement write
      // that REMOUNTS a surface (the top strip and the vertical one are two
      // components) re-registers it, which is a notification; between the
      // old element leaving and the new one registering the ring is held
      // rather than put away, so it travels to the new element.
      const node = selectedNode(state);
      if (node !== null || state.selectedSurface === null) ring.track(node);
    };

    const onPointerMove = (event: PointerEvent): void => {
      // A member in hand owns the pointer: re-hovering whatever it is passing
      // over would move the chip and the selection mid-gesture.
      if (layoutDragActive()) return;
      if (!hoverCapablePointer(event.pointerType)) return;
      const target = event.target;
      if (!(target instanceof Node) || !column.contains(target)) return;
      const regionNode = regionNodeUnder(target, column);
      const regionId = regionIdOf(regionNode);
      const state = useLayoutEditorStore.getState();
      if (regionNode !== null) state.setPointed(regionNode);
      state.setHovered(regionId);
      state.setHoveredSetting(
        regionId === null ? settingUnder(target, column) : null,
      );
      setCue(regionId === null ? cueNodeUnder(target, column) : null);
    };

    // The one owner of "this press starts a drag". The firewall swallows
    // `pointerdown` on the column in the capture phase, so the decision is
    // made here, one level up and still in capture, and the drag it arms
    // listens on `window` from then on - never a second listener racing the
    // firewall for the same event.
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node) || !column.contains(target)) return;
      const state = useLayoutEditorStore.getState();
      state.setKeyboardNav(false);
      const member = memberNodeUnder(target, column);
      const regionNode = regionNodeUnder(target, column);
      const regionId = regionIdOf(regionNode);
      if (regionNode !== null) state.setPointed(regionNode);
      // A surface is selected only through its OWN space: a region inside it
      // (the Home tab, a rail icon), a setting's part (the live agents under
      // the active tab) and a rail divider stay what they were.
      const setting =
        regionId === null && member === null
          ? settingUnder(target, column)
          : null;
      const surface =
        regionId === null && member === null && setting === null
          ? surfaceNodeUnder(target, column)
          : null;
      if (setting !== null) state.selectSetting(setting);
      else if (surface === null) state.select(regionId);
      else state.selectSurface(surface.id);
      // A session on its way out, or a shell still gliding, has boxes that are
      // about to move or are already a snapshot; neither is something to
      // measure a drag against.
      if (state.leaving || layoutTransitionRunning()) return;
      if (member !== null) armCanvasDrag({ event, node: member });
      else if (surface !== null) armPlacementDrag(event, surface, column);
    };

    // Leaving the canvas drops the canvas's own hover. The inspector's rows
    // set it too, and the pointer is already over one by the time this fires.
    const onPointerLeave = (): void => {
      useLayoutEditorStore.getState().setHovered(null);
      setCue(null);
    };

    paint();
    const unsubscribe = useLayoutEditorStore.subscribe((state, previous) => {
      paint();
      // An exit has started. Every path out of the editor raises `leaving`
      // first, so this is the one edge that catches them all - including a
      // re-open that flushes the old session's teardown before React has
      // re-rendered, where the unmount cleanup below never runs at all.
      if (state.leaving && !previous.leaving) cancelLayoutDrag();
    });
    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    column.addEventListener("pointerleave", onPointerLeave);

    return () => {
      unsubscribe();
      document.removeEventListener("pointermove", onPointerMove, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      column.removeEventListener("pointerleave", onPointerLeave);
      // An exit under a live gesture: the drag's own listeners, its frame and
      // the transform it put on an element the app owns all go with the
      // session, and it writes nothing on the way out.
      cancelLayoutDrag();
      setCue(null);
      anchorSettingChip(null);
      chip.destroy();
      ring.destroy();
      column.removeAttribute("data-layout-editing");
    };
  }, [column, live]);
}

/** The fixed-chrome cue under the pointer, if any (`data-layout-cue`). */
function cueNodeUnder(target: Node, column: HTMLElement): HTMLElement | null {
  const element = target instanceof Element ? target : target.parentElement;
  const node = element?.closest("[data-layout-cue]") ?? null;
  return node instanceof HTMLElement && column.contains(node) ? node : null;
}

/**
 * The nearest element at a point that answers for a region: its registered
 * node (`data-layout-region`), which is what makes the whole element hoverable
 * rather than only the pixel the pointer is over, or a PART drawn for it
 * elsewhere (`data-layout-region-part`, the sample picker's footer), which
 * hovers and selects the region without being its node. Only the node carries
 * `data-layout-region`, so every lookup by region name finds it and nothing
 * else.
 */
function regionNodeUnder(
  target: Node,
  column: HTMLElement,
): HTMLElement | null {
  const element = target instanceof Element ? target : target.parentElement;
  const node =
    element?.closest("[data-layout-region], [data-layout-region-part]") ?? null;
  if (!(node instanceof HTMLElement) || !column.contains(node)) return null;
  return node;
}

/**
 * The nearest element a canvas drag can pick up, which is NOT the same
 * question as which region is under the pointer: the sidebar rail's dividers
 * are members of the rail's order without being regions of their own (L-115),
 * so the member is resolved off the attribute the drag reads rather than off
 * the region registration.
 */
function memberNodeUnder(
  target: Node,
  column: HTMLElement,
): HTMLElement | null {
  const element = target instanceof Element ? target : target.parentElement;
  const node = element?.closest('[data-layout-draggable="1"]') ?? null;
  if (!(node instanceof HTMLElement) || !column.contains(node)) return null;
  return node;
}

/**
 * The placement surface whose own space is under a press, or `null`. Resolved
 * past any region-less element inside it (a task tab is not a region), which is
 * what makes the whole strip a handle.
 */
function surfaceNodeUnder(
  target: Node,
  column: HTMLElement,
): { readonly id: PlacementSurfaceId; readonly node: HTMLElement } | null {
  const element = target instanceof Element ? target : target.parentElement;
  const node = element?.closest("[data-layout-surface]") ?? null;
  if (!(node instanceof HTMLElement) || !column.contains(node)) return null;
  const value = node.getAttribute("data-layout-surface");
  if (value === "topBar" || value === "sidebar") return { id: value, node };
  return null;
}

/**
 * Arm the drag of a surface onto an edge. The tab strip's edges are the app
 * column's; the sidebar's are the content's it sits beside, which is its
 * parent on the canvas.
 */
function armPlacementDrag(
  event: PointerEvent,
  surface: { readonly id: PlacementSurfaceId; readonly node: HTMLElement },
  column: HTMLElement,
): void {
  const facts = SURFACE_PLACEMENT[surface.id];
  const container =
    surface.id === "topBar" ? column : surface.node.parentElement;
  if (container === null) return;
  armSurfaceDrag({
    event,
    node: surface.node,
    container,
    edges: facts.edges,
    current: facts.current(getLayoutSnapshot().arrangement),
    onDrop: facts.write,
  });
}

/**
 * The setting whose part is under the pointer (`data-layout-setting`, stamped
 * by `useLayoutSettingPart`), or `null`.
 */
function settingUnder(
  target: Node,
  column: HTMLElement,
): LayoutSettingId | null {
  const element = target instanceof Element ? target : target.parentElement;
  const node = element?.closest("[data-layout-setting]") ?? null;
  if (!(node instanceof HTMLElement) || !column.contains(node)) return null;
  return node.getAttribute("data-layout-setting") === "sideStripView"
    ? "sideStripView"
    : null;
}

/**
 * The chip for a hovered setting: its name and value on its part, as a
 * region's chip reads. Where the strip has no room for the part - tabs at the
 * top, or the strip collapsed to its rail - the chip goes on the strip and says
 * why, so pointing at the row always answers on the canvas.
 */
function settingChip(
  state: Pick<
    LayoutEditorState,
    "hoveredSetting" | "settingNodes" | "surfaceNodes"
  >,
): {
  readonly label: string;
  readonly node: HTMLElement;
  readonly placement: HoverChipPlacement;
} | null {
  if (state.hoveredSetting === null) return null;
  const { label } = LAYOUT.definitions.sideStripView;
  const { arrangement } = getLayoutSnapshot();
  const part = state.settingNodes.get(state.hoveredSetting);
  if (part !== undefined) {
    const value = SIDE_STRIP_VIEW_OPTIONS.find(
      (option) => option.value === arrangement.sideStripView,
    );
    return {
      label: `${label} · ${value?.label ?? ""}`,
      node: part,
      // Under the list: above it is the tab the list belongs to, whose name
      // the chip would cover.
      placement: "below",
    };
  }
  const strip = state.surfaceNodes.get("topBar");
  if (strip === undefined) return null;
  const atTop = arrangement.tabStripPlacement === "top";
  return {
    label: `${label} · ${atTop ? SIDE_STRIP_VIEW_AT_TOP : SIDE_STRIP_VIEW_COLLAPSED}`,
    node: strip,
    placement: atTop ? "below" : "above",
  };
}

/** The element the ring is on: the selected region's, surface's or setting's part. */
function selectedNode(
  state: Pick<
    LayoutEditorState,
    | "instances"
    | "pointed"
    | "selected"
    | "selectedSurface"
    | "surfaceNodes"
    | "selectedSetting"
    | "settingNodes"
  >,
): HTMLElement | null {
  if (state.selected !== null) {
    const own = preferredRegionInstance(state, state.selected);
    if (own !== null) return own.node;
    // A stack's lower members have no node of their own: the stack's one icon
    // stands for them on the rail (G3, L-181), so that icon gets the ring.
    const selected = state.selected;
    const railRegion = RAIL_REGION_IDS.find((id) => id === selected);
    if (railRegion === undefined) return null;
    const [top] = railStackMembersFor(
      getLayoutSnapshot().arrangement.rail,
      railRegion,
      () => true,
    );
    return top === railRegion
      ? null
      : (preferredRegionInstance(state, top)?.node ?? null);
  }
  if (state.selectedSurface !== null)
    return state.surfaceNodes.get(state.selectedSurface) ?? null;
  if (state.selectedSetting !== null)
    return state.settingNodes.get(state.selectedSetting) ?? null;
  return null;
}

function regionIdOf(node: HTMLElement | null): RegionId | null {
  if (node === null) return null;
  const value =
    node.getAttribute("data-layout-region") ??
    node.getAttribute("data-layout-region-part");
  return LAYOUT_REGION_IDS.find((id) => id === value) ?? null;
}

/** A top-bar region has nothing above it, so its chip goes underneath (4.3). */
function chipPlacement(regionId: RegionId): HoverChipPlacement {
  return regionFacts(regionId).surface === "topBar" ? "below" : "above";
}

/**
 * What the chip says: the region's name AND the state it is in right now
 * (C-05) - "Browsers · Shown", "Minimap · Right".
 *
 * The name alone made the chip a label for something the pointer was already
 * on. The state word is the answer to the question hovering asks, and it is
 * read through the same `regionStateWord` the inspector's index rows print, so
 * the canvas and the list can never name one region's state two ways. The
 * separator is the app's own middle dot rather than the prototype's ASCII dash.
 *
 * Off the store rather than out of a render: the chip is a DOM element this
 * module owns, and a hover must not re-render a chat tile. Takes the snapshot
 * it is built from rather than reading one, so the caller's cache and this
 * answer can never be about two different layouts.
 */
function hoverChipLabel(regionId: RegionId, snapshot: LayoutSnapshot): string {
  const values = effectiveLayoutValues(snapshot.basePreset, snapshot.overrides);
  const state = regionStateWord(regionId, values, snapshot.arrangement);
  return `${regionFacts(regionId).name} · ${state}`;
}

/**
 * Whether two snapshots are the same layout, by the identity of the three
 * fields the store holds - never a deep compare. Each one is replaced whole on
 * a write, so a reference match IS "nothing was written since".
 */
function sameLayout(left: LayoutSnapshot, right: LayoutSnapshot): boolean {
  return (
    left.basePreset === right.basePreset &&
    left.overrides === right.overrides &&
    left.arrangement === right.arrangement
  );
}

/**
 * Whether this pointer can REST on a region, which is the precondition for
 * hover decoration at all (C-09).
 *
 * The prototype refuses hover unless `(hover: hover) and (pointer: fine)`; a
 * per-event answer is the same rule and is also right on a hybrid machine,
 * where the media query describes the device and this describes the gesture. A
 * touch or a pen reports a move on the way to a tap, which would light a
 * region up and leave a chip sitting behind the finger. The app already
 * answers this question this way for its hover popovers.
 */
function hoverCapablePointer(pointerType: string): boolean {
  return pointerType === "mouse";
}
