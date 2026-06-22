/**
 * Sidebar-reparent preview + spring-load for a `sidebar-node` drag. Split out
 * of `root-dnd-provider.tsx` so the provider stays a thin lifecycle dispatcher
 * (mirroring `root-dnd-collision.ts` / `root-dnd-commits.ts`): everything that
 * resolves, validates, highlights, or clears the row/panel reparent preview -
 * and the auto-expand spring-load timer - lives here. The provider owns the
 * gesture-scoped refs and feeds them in.
 */
import type { RefObject } from "react";
import type { Doc } from "yjs";
import {
  PANEL_NODE_FAMILY,
  SIDEBAR_NODE_DND_TYPE,
  readEpicCanvasDropTargetData,
  type EpicCanvasDragSourceData,
  type EpicCanvasDropTargetData,
} from "@/components/epic-canvas/dnd/dnd";
import { useEpicDndStore } from "@/components/epic-canvas/dnd/dnd-store";
import type { ResolvedEpicCanvasDrop } from "@/components/epic-canvas/dnd/root-dnd-commits";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
import { canReparent } from "@/lib/epic-y-mutations";
import { resolveReparentNode } from "@/lib/reparent-rules";
import { useEpicSidebarExpansionStore } from "@/stores/epics/epic-sidebar-expansion-store";
import type { RootCreatePanelId } from "@/stores/epics/left-panel-store";

export type SidebarReparentTarget = Extract<
  EpicCanvasDropTargetData,
  { readonly kind: "sidebar-reparent-row" | "sidebar-reparent-panel" }
>;

export function readSidebarReparentTarget(
  value: unknown,
): SidebarReparentTarget | null {
  const target = readEpicCanvasDropTargetData(value);
  if (target === null) return null;
  if (
    target.kind === "sidebar-reparent-row" ||
    target.kind === "sidebar-reparent-panel"
  ) {
    return target;
  }
  return null;
}

/** The reparent drop the commit reads at drag end (Decision C/D). */
export interface LastReparentDrop {
  readonly epicId: string;
  readonly sourceNodeId: string;
  /** The new parent (a row's nodeId) or null to un-nest to root. */
  readonly newParentId: string | null;
  readonly panelId: RootCreatePanelId;
  /** Scopes the post-commit expand of `newParentId` (see commit). */
  readonly viewTabId: string;
}

export interface SpringLoadEntry {
  readonly nodeId: string;
  readonly timer: number;
}

/**
 * The provider's gesture-scoped reparent refs, bundled so the preview helpers
 * take one object instead of three positional ref params. `lastResolved` is the
 * canvas drop ref (cleared when a reparent wins); `lastReparent` is the reparent
 * commit ref; `springLoad` tracks the pending auto-expand timer.
 */
export interface ReparentRefs {
  readonly lastResolved: RefObject<ResolvedEpicCanvasDrop | null>;
  readonly lastReparent: RefObject<LastReparentDrop | null>;
  readonly springLoad: RefObject<SpringLoadEntry | null>;
}

/** ~450ms hover on a collapsible parent auto-expands it mid-drag. */
const SPRING_LOAD_DELAY_MS = 450;

export function clearSpringLoad(
  springLoadRef: RefObject<SpringLoadEntry | null>,
): void {
  if (springLoadRef.current !== null) {
    window.clearTimeout(springLoadRef.current.timer);
    springLoadRef.current = null;
  }
}

/**
 * Spring-load: while a VALID reparent row stays hovered, arm a timer that
 * expands it so the dragger can reach nested children mid-drag. Gated on
 * "has children" (read from the projected tree); `expand` is idempotent, so an
 * already-expanded parent is a harmless no-op. Re-arms only when the hovered
 * nodeId changes; cleared on target change / drag end / cancel.
 */
function armSpringLoadForRow(
  target: Extract<
    EpicCanvasDropTargetData,
    { readonly kind: "sidebar-reparent-row" }
  >,
  springLoadRef: RefObject<SpringLoadEntry | null>,
): void {
  if (springLoadRef.current?.nodeId === target.nodeId) return;
  clearSpringLoad(springLoadRef);
  const handle = getOpenEpicRegistry().peek(target.epicId);
  if (handle === null) return;
  const childrenByParent = handle.store.getState().tree.childrenByParent;
  if (!Object.hasOwn(childrenByParent, target.nodeId)) return;
  if (childrenByParent[target.nodeId].length === 0) return;
  const { nodeId, panelId, viewTabId } = target;
  const timer = window.setTimeout(() => {
    springLoadRef.current = null;
    useEpicSidebarExpansionStore.getState().expand(viewTabId, panelId, nodeId);
  }, SPRING_LOAD_DELAY_MS);
  springLoadRef.current = { nodeId, timer };
}

export function clearSidebarReparentPreview(refs: ReparentRefs): void {
  useEpicDndStore.getState().sidebarReparentPreviewChanged({
    targetNodeId: null,
    rootPanelId: null,
  });
  refs.lastReparent.current = null;
  clearSpringLoad(refs.springLoad);
}

/**
 * Whether the dragged node may reparent onto this target, given the live doc.
 * Row targets defer entirely to `canReparent`; panel (root) drops additionally
 * require the node's family to match the panel so a cross-panel empty-space
 * hover reads as no-drop.
 */
function isSidebarReparentValid(
  doc: Doc,
  sourceNodeId: string,
  target: SidebarReparentTarget,
  newParentId: string | null,
): boolean {
  if (
    target.kind === "sidebar-reparent-panel" &&
    resolveReparentNode(doc, sourceNodeId)?.family !==
      PANEL_NODE_FAMILY[target.panelId]
  ) {
    return false;
  }
  return canReparent(doc, sourceNodeId, newParentId).ok;
}

/**
 * Reparent preview for a `sidebar-node` over a sidebar-reparent target. Reads
 * the live doc (`peek`), pre-flights validity, and on success lights the
 * row/panel highlight while CLEARING every canvas-side preview channel (and
 * vice-versa) so the two never co-render. Records / clears the commit ref the
 * drag-end handler reads.
 */
export function updateSidebarReparentPreview(
  source: Extract<
    EpicCanvasDragSourceData,
    { readonly kind: typeof SIDEBAR_NODE_DND_TYPE }
  >,
  target: SidebarReparentTarget,
  refs: ReparentRefs,
): void {
  const dndStore = useEpicDndStore.getState();
  // A sidebar target always wins over any canvas/header preview channel.
  dndStore.headerStripDropIndexChanged(null);
  dndStore.dropPreviewChanged(null);
  refs.lastResolved.current = null;

  const newParentId =
    target.kind === "sidebar-reparent-row" ? target.nodeId : null;
  const handle = getOpenEpicRegistry().peek(source.epicId);
  const doc = handle === null ? null : handle.store.getState().doc;
  if (
    doc === null ||
    !isSidebarReparentValid(doc, source.nodeId, target, newParentId)
  ) {
    clearSidebarReparentPreview(refs);
    return;
  }

  dndStore.sidebarReparentPreviewChanged({
    targetNodeId: target.kind === "sidebar-reparent-row" ? target.nodeId : null,
    rootPanelId:
      target.kind === "sidebar-reparent-panel" ? target.panelId : null,
  });
  refs.lastReparent.current = {
    epicId: source.epicId,
    sourceNodeId: source.nodeId,
    newParentId,
    panelId: target.panelId,
    viewTabId: target.viewTabId,
  };
  if (target.kind === "sidebar-reparent-row") {
    armSpringLoadForRow(target, refs.springLoad);
  } else {
    clearSpringLoad(refs.springLoad);
  }
}
