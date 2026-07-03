import { useNavigate } from "@tanstack/react-router";
import { useCallback, type MouseEvent } from "react";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { epicNodeRefForNodeId } from "@/lib/epic-selectors";
import {
  navigateToTabIntent,
  openOrFocusEpicIntent,
} from "@/lib/tab-navigation";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicNodeRef } from "@/stores/epics/canvas/types";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";

/**
 * The click handler a legacy `<traycer-*>` reference component runs, or `null`
 * when the reference is not openable. A `null` handler is the single signal the
 * component uses to fall back to plain label text - so missing ids, an absent
 * epic-session context, and a same-epic node that does not resolve all degrade
 * the chip to inert text rather than a dead click.
 */
export type TraycerReferenceOpenHandler =
  ((event: MouseEvent<HTMLElement>) => void) | null;

/**
 * What `useTraycerReferenceOpenHandler` resolves in a single render pass:
 *
 * - `onOpen` - the click handler (or `null` when the reference is not
 *   openable, the single signal the chip uses to degrade to plain text).
 * - `sameEpicNodeRef` - the resolved `EpicNodeRef` for a `same-epic-node`
 *   target, `null` for `navigate` (cross-epic) and `none`. This is the ONLY
 *   case a chip may become a drag source: drag eligibility is narrower than
 *   click (which is also non-null for cross-epic navigation), so the resolved
 *   ref is surfaced here for the chip to gate on.
 */
export interface TraycerReferenceOpenState {
  readonly onOpen: TraycerReferenceOpenHandler;
  readonly sameEpicNodeRef: EpicNodeRef | null;
}

/**
 * What a click on the reference should do, resolved once in render:
 *
 * - `none` - not openable (missing ids, no epic-session context, a same-epic
 *   node that does not resolve / has no active host). The handler is `null` and
 *   the chip renders plain text.
 * - `same-epic-node` - open the resolved node as a replaceable preview tile in
 *   the open epic's current tab.
 * - `navigate` - navigate to the target epic and focus it, reusing
 *   `focusArtifactId` for a node (D1); `traycer-epic` carries `undefined`.
 */
type OpenTarget =
  | { readonly kind: "none" }
  | {
      readonly kind: "same-epic-node";
      readonly epicId: string;
      readonly ref: EpicNodeRef;
    }
  | {
      readonly kind: "navigate";
      readonly epicId: string;
      readonly focusArtifactId: string | undefined;
    };

/**
 * Builds the open/navigate handler shared by every legacy `<traycer-*>`
 * reference component. The tags embed the real ids, so opening is render-time
 * only - there is no migration and no new route params.
 *
 * - `nodeId` is the embedded spec / ticket / chat id; pass `null` for
 *   `<traycer-epic>`, which focuses the epic without an artifact.
 * - SAME epic (`epicId` === the currently-open epic): resolve `nodeId` against
 *   the open-epic projection via `epicNodeRefForNodeId` and open it as a
 *   replaceable preview tile. A `null` ref (not yet projected / not openable)
 *   yields a `null` handler so the chip stays plain text.
 * - CROSS epic: navigate to the target epic and reuse `focusArtifactId =
 *   nodeId` (D1 - the auto-open path already opens chat tiles, so chats reuse
 *   `focusArtifactId`; no `focusChatId`) with a fresh `focusedAt` (G2) so a
 *   re-click after closing the tab re-opens it. `<traycer-epic>` passes no
 *   artifact id and only focuses the epic.
 *
 * These components live in the global `DEFAULT_COMPONENTS` map and may render
 * where no `<EpicSessionProvider>` exists. Without the handle (or an active
 * host for a node ref) the handler is `null` and the component renders plain
 * text.
 */
export function useTraycerReferenceOpenHandler(input: {
  readonly epicId: string | undefined;
  readonly nodeId: string | undefined;
  /**
   * Whether this reference type opens a node (spec / ticket / chat). When
   * `true`, a missing or empty `nodeId` makes the reference non-openable. When
   * `false` (`traycer-epic`), the reference focuses the epic with no node.
   */
  readonly requiresNode: boolean;
}): TraycerReferenceOpenState {
  const handle = useMaybeOpenEpicHandle();
  const activeHostId = useReactiveActiveHostId();
  const navigate = useNavigate();

  const target = resolveOpenTarget({
    epicId: input.epicId,
    nodeId: input.nodeId,
    requiresNode: input.requiresNode,
    handle,
    activeHostId,
  });

  const handler = useCallback(
    (event: MouseEvent<HTMLElement>): void => {
      event.preventDefault();
      event.stopPropagation();
      switch (target.kind) {
        case "none":
          return;
        case "same-epic-node": {
          // Open the resolved node as a replaceable preview tile in the epic's
          // current tab.
          const canvas = useEpicCanvasStore.getState();
          const tabId = canvas.resolveTargetTabForEpic(
            target.epicId,
            undefined,
          );
          canvas.openTilePreviewInTab(tabId, target.ref);
          return;
        }
        case "navigate":
          // `focusArtifactId` opens chat tiles too (D1); `traycer-epic` passes
          // `undefined`. A fresh `focusedAt` (G2) re-opens a closed tab on
          // re-click.
          navigateToTabIntent(
            navigate,
            openOrFocusEpicIntent({
              epicId: target.epicId,
              focus: {
                focusedAt: Date.now(),
                focusArtifactId: target.focusArtifactId,
                focusThreadId: undefined,
                migrationSource: undefined,
              },
            }),
          );
          return;
      }
    },
    [target, navigate],
  );

  // Only a resolved `same-epic-node` surfaces a ref; `navigate` and `none`
  // yield `null`, so the chip can gate drag to the same-epic case alone.
  const sameEpicNodeRef = target.kind === "same-epic-node" ? target.ref : null;

  if (target.kind === "none") return { onOpen: null, sameEpicNodeRef: null };
  return { onOpen: handler, sameEpicNodeRef };
}

/**
 * Resolve, once in render, what a click should do. All "not openable" cases
 * collapse to `none`; the redundant guard layers the handler used to repeat are
 * encoded here a single time.
 */
function resolveOpenTarget(input: {
  readonly epicId: string | undefined;
  readonly nodeId: string | undefined;
  readonly requiresNode: boolean;
  readonly handle: OpenEpicStoreHandle | null;
  readonly activeHostId: string | null;
}): OpenTarget {
  const { epicId, nodeId, requiresNode, handle, activeHostId } = input;

  // An empty embedded id is treated as missing.
  const normalizedNodeId =
    nodeId === undefined || nodeId.length === 0 ? null : nodeId;

  // Base usability: an epic id, an open-epic handle, and - for node refs - a
  // node id.
  if (epicId === undefined || epicId.length === 0) return { kind: "none" };
  if (handle === null) return { kind: "none" };
  if (requiresNode && normalizedNodeId === null) return { kind: "none" };

  // SAME-epic NODE: resolve the node against the open-epic projection and open
  // it as a preview tile. A node that does not resolve (deleted / not yet
  // projected / not openable) or a missing active host degrades to plain text.
  // An epic-only reference (no node id) falls through to navigate even for the
  // open epic, re-focusing it harmlessly rather than dead-clicking.
  if (epicId === handle.epicId && normalizedNodeId !== null) {
    if (activeHostId === null) return { kind: "none" };
    const ref = epicNodeRefForNodeId(
      handle.store.getState(),
      normalizedNodeId,
      activeHostId,
    );
    if (ref === null) return { kind: "none" };
    return { kind: "same-epic-node", epicId, ref };
  }

  // CROSS epic (or same-epic epic-only focus): navigate + focus. `traycer-epic`
  // carries no artifact id (D1).
  return {
    kind: "navigate",
    epicId,
    focusArtifactId: normalizedNodeId ?? undefined,
  };
}
