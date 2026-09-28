import { useCallback, useEffect, useRef, type RefObject } from "react";
import { useEpicViewTabId } from "@/components/epic-canvas/view-tab-context";
import { usePaneVisible } from "@/components/epic-tabs/pane-visibility-context";
import { useRegionValues } from "@/lib/layout-overrides";
import { regionValuesHidden } from "@/lib/layout/layout-values";
import { canvasOrderGroupForRegion } from "@/lib/layout/layout-arrangement";
import type { RegionId } from "@/lib/layout/region-id";
import {
  preferredRegionInstance,
  regionGhostRequested,
  useLayoutEditorStore,
  type LayoutEditorState,
  type RegionInstance,
} from "@/stores/layout/layout-editor-store";

/**
 * Marks a real element as a customizable region (4.1).
 *
 * The node ref, the scene/instance key and the pane-visibility gate are the
 * registration hook's from the start, because they are what makes a hidden
 * pane's copy of a region stay out of the editor. What changed is what
 * registration is FOR. The node used to be a rect source for a proxy button
 * drawn on top of it; it is now the attribute host that the decoration CSS
 * styles in place, plus the element the ring measures and the chip anchors to
 * (L-13).
 *
 * Decoration is written straight onto the node rather than returned as props:
 * the element belongs to the app, its props belong to whatever renders it, and
 * a hover must not re-render a chat tile.
 *
 * NAMING the element is a separate lifetime from registering it (L-129). The
 * name - `data-layout-region`, plus the instance it belongs to - is on the
 * element for as long as the element is a visible region, session or not,
 * because a right-click has to be able to say which region it landed on while
 * the user is only using the app (L-19): the cluster menu resolves the region
 * from the DOM under the pointer, and with the name gated on a session every
 * pixel of every cluster answered "nothing customizable here". Everything the
 * EDITOR needs - the registry entry, the drag group, the decoration - stays
 * gated on the session exactly as before.
 */
export function useLayoutRegion(input: {
  regionId: RegionId;
  instanceId: string | null;
}): {
  readonly ref: (node: HTMLElement | null) => void;
  readonly editing: boolean;
  /**
   * Whether a HIDDEN region should materialise in place right now (L-14).
   *
   * The host renders its real control on this, and the decoration CSS draws it
   * at low opacity so it reads as a preview rather than as a setting that came
   * back on. A region the user has not hidden never sees it.
   */
  readonly ghost: boolean;
} {
  const { regionId, instanceId } = input;
  const viewTabId = useEpicViewTabId();
  const visible = usePaneVisible();
  const editing = useLayoutEditorStore((state) => state.session !== null);
  const ghost = useRegionGhost(regionId);
  const nodeRef = useRef<HTMLElement | null>(null);
  const registered = useRef<RegionInstance | null>(null);
  // The node this hook has NAMED, which outlives every session the node is on
  // screen for - so it is tracked apart from the registration and taken off
  // apart from it too.
  const named = useRef<HTMLElement | null>(null);
  // Read by `sync`, which runs on registration rather than on a ghost change,
  // so a region that re-registers while materialised keeps its flag.
  const ghostRef = useRef(ghost);

  const sync = useCallback(() => {
    const previous = registered.current;
    const state = useLayoutEditorStore.getState();
    const node = nodeRef.current;
    const sceneId = viewTabId ?? "shell";
    const key = `${regionId}@${sceneId}:${instanceId ?? "-"}`;
    // A hidden pane's copy is named no more than it is registered (L-109): it
    // cannot be pointed at, and naming it would put a second element with the
    // same region name in the document for `closest` to find.
    if (node === null || !visible) unnameNode(named);
    else nameNode(named, node, regionId, instanceId);
    const wanted = state.session !== null && node !== null && visible;
    // Idempotent, because it runs twice on mount by construction: the `ref`
    // callback fires before effects, and the mount effect below has to run it
    // too for the case the ref callback cannot see (a pane becoming visible, a
    // scene id changing). Re-stripping and re-registering an unchanged node
    // was pure churn, and on a scene with thirty regions it was thirty of
    // them (G1-21).
    if (
      previous !== null &&
      wanted &&
      previous.key === key &&
      previous.node === node
    ) {
      decorate(previous);
      return;
    }
    if (previous !== null) {
      strip(previous.node);
      state.unregisterInstance(previous.key, previous.node);
    }
    registered.current = null;
    // `wanted` carries `node !== null`, so this narrows `node` too.
    if (!wanted) return;
    const instance: RegionInstance = {
      key,
      regionId,
      sceneId,
      instanceId,
      node,
    };
    registered.current = instance;
    // What a canvas drag picks up and reflows against (4.7). Stamped here
    // rather than by hand at each of the thirty call sites: the element that
    // draws a region inherits that region's group by being registered.
    const group = canvasOrderGroupForRegion(regionId);
    if (group !== null) {
      node.setAttribute("data-layout-group", group);
      node.setAttribute("data-layout-draggable", "1");
    }
    state.registerInstance(instance);
    flag(node, "data-ghost", ghostRef.current);
    decorate(instance);
  }, [regionId, instanceId, viewTabId, visible]);

  const ref = useCallback(
    (node: HTMLElement | null) => {
      nodeRef.current = node;
      sync();
    },
    [sync],
  );

  useEffect(() => {
    sync();
    const unsubscribe = useLayoutEditorStore.subscribe((state, previous) => {
      if (state.session !== previous.session) {
        sync();
        return;
      }
      if (
        state.hovered !== previous.hovered ||
        state.pointed !== previous.pointed ||
        state.selected !== previous.selected ||
        state.instances !== previous.instances
      ) {
        const instance = registered.current;
        if (instance !== null) decorate(instance);
      }
    });
    return () => {
      unsubscribe();
      const instance = registered.current;
      if (instance !== null) {
        strip(instance.node);
        useLayoutEditorStore
          .getState()
          .unregisterInstance(instance.key, instance.node);
      }
      registered.current = null;
      unnameNode(named);
    };
    // `sync` and nothing else: it is a `useCallback` over exactly the inputs
    // this effect would otherwise restate, so listing them again said "re-run
    // when the region or the instance changes" twice and implied the cleanup
    // depended on the CURRENT render's copies of them. It does not - taking a
    // name off is a fact about the node that wore it, which the ref carries
    // (R3-17).
  }, [sync]);

  // After the commit that mounted the materialised control, not from the store
  // subscription above: the node the flag belongs on is the one this render
  // just produced. Keyed on the flag itself rather than run on every render,
  // which is what a ~30-region scene pays for a value that changes on a hover
  // (G1-21).
  useEffect(() => {
    ghostRef.current = ghost;
    const node = registered.current?.node ?? null;
    if (node === null) return;
    flag(node, "data-ghost", ghost);
  }, [ghost]);

  return { ref, editing, ghost };
}

/**
 * Whether a region the user has HIDDEN should appear anyway, right now (L-14).
 *
 * Separate from {@link useLayoutRegion} because the mount decision and the
 * registration are usually in different components: the strip decides whether
 * the Home item exists, the Home item registers the region. Both ask this, and
 * they cannot disagree.
 *
 * Only for a materialisation that is genuinely passive - a view over data the
 * app already holds. A region whose control fetches, streams or claims a
 * keyboard action stays absent while hidden and appears in the index with its
 * state word instead (4.9): a preview may not start work.
 */
export function useRegionGhost(regionId: RegionId): boolean {
  const hidden = regionValuesHidden(useRegionValues(regionId));
  const requested = useLayoutEditorStore((state) =>
    regionGhostRequested(state, regionId),
  );
  return hidden && requested;
}

/**
 * The live attributes 4.2's CSS keys off.
 *
 * `data-hover` and `data-selected` land on EVERY instance of the region, which
 * is what makes both tiles' copies light up together (L-23). `data-layout-anchor`
 * lands on exactly one node per role, because two elements sharing an
 * `anchor-name` resolve to the last in tree order and would anchor an overlay
 * to a background tile (C-12). The roles are separate names because the chip
 * follows the pointer while the pinned card stays on the open section.
 */
function decorate(instance: RegionInstance): void {
  const state = useLayoutEditorStore.getState();
  const editing = state.session !== null;
  const hovered = editing && decoratedHoverRegion(state) === instance.regionId;
  const selected = editing && state.selected === instance.regionId;
  flag(instance.node, "data-hover", hovered);
  flag(instance.node, "data-selected", selected);
  const roles: string[] = [];
  if (hovered && isAnchorInstance(state, instance)) roles.push("hover");
  if (selected && isAnchorInstance(state, instance)) roles.push("selected");
  if (roles.length === 0) instance.node.removeAttribute("data-layout-anchor");
  else instance.node.setAttribute("data-layout-anchor", roles.join(" "));
}

/**
 * The region the hover decoration is on, which is never the selected one
 * (C-08).
 *
 * A selected region used to wear all three signals at once - the travelling
 * ring, the 1px hover outline and the floating name chip - because the pointer
 * is still over the region it just selected. The prototype clears the hover
 * inside `selectRegion`, which works there because it sets hover on
 * `pointerover`; here hover is set on `pointermove`, so a one-off clear would
 * be undone by the next pixel of movement. Deriving it instead makes the ring
 * the single signal for as long as the selection stands, however the pointer
 * moves over it.
 *
 * Shared by the two readers rather than restated: the attributes this module
 * stamps, and the chip `layout-canvas.ts` shows.
 */
export function decoratedHoverRegion(
  state: Pick<LayoutEditorState, "hovered" | "selected">,
): RegionId | null {
  return state.hovered === state.selected ? null : state.hovered;
}

function isAnchorInstance(
  state: LayoutEditorState,
  instance: RegionInstance,
): boolean {
  let byRegion = anchorsByState.get(state);
  if (byRegion === undefined) {
    byRegion = new Map();
    anchorsByState.set(state, byRegion);
  }
  let anchor = byRegion.get(instance.regionId);
  if (anchor === undefined) {
    anchor = preferredRegionInstance(state, instance.regionId);
    byRegion.set(instance.regionId, anchor);
  }
  return anchor === instance;
}

/**
 * Each region's anchor, resolved once per store state. One store change runs
 * `decorate` for every instance of a region, and each resolution hit-tests
 * the region's instances, so resolving per instance was N^2 layout reads for
 * the transcript's N timestamps on a single hover (B7).
 */
const anchorsByState = new WeakMap<
  LayoutEditorState,
  Map<RegionId, RegionInstance | null>
>();

function flag(node: HTMLElement, attribute: string, on: boolean): void {
  if (on) node.setAttribute(attribute, "1");
  else node.removeAttribute(attribute);
}

/**
 * Put the region's NAME on `node`, taking it off whichever node wore it
 * before.
 *
 * Separate from {@link strip} because the two have different lifetimes: the
 * name is a fact about the element (this is the mic chip), the rest is a fact
 * about the session decorating it. Ending a session takes the decoration off
 * and leaves the name, so the right-click that worked a moment ago still knows
 * what it is over (L-129).
 */
function nameNode(
  named: RefObject<HTMLElement | null>,
  node: HTMLElement,
  regionId: RegionId,
  instanceId: string | null,
): void {
  const previous = named.current;
  if (previous !== null && previous !== node) unname(previous);
  named.current = node;
  node.setAttribute("data-layout-region", regionId);
  if (instanceId === null) node.removeAttribute("data-layout-instance");
  else node.setAttribute("data-layout-instance", instanceId);
}

/**
 * Take the name off whichever node is wearing it, which is a fact about THAT
 * node and needs nothing from the render that asks for it (R3-17).
 */
function unnameNode(named: RefObject<HTMLElement | null>): void {
  const previous = named.current;
  named.current = null;
  if (previous !== null) unname(previous);
}

function unname(node: HTMLElement): void {
  node.removeAttribute("data-layout-region");
  node.removeAttribute("data-layout-instance");
}

/** Leaves the app's own element wearing nothing but its name. */
function strip(node: HTMLElement): void {
  node.removeAttribute("data-layout-anchor");
  node.removeAttribute("data-layout-group");
  node.removeAttribute("data-layout-draggable");
  node.removeAttribute("data-hover");
  node.removeAttribute("data-selected");
  node.removeAttribute("data-ghost");
}
