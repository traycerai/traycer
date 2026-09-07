import { useNavigate } from "@tanstack/react-router";
import { useCallback, type MouseEvent } from "react";
import { useCanvasHostId } from "@/components/epic-canvas/hooks/use-canvas-host-id";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { modifiersFromMouseEvent } from "@/lib/canvas/tile-open/intent";
import { epicNodeRefForNodeId } from "@/lib/epic-selectors";
import {
  navigateToTabIntent,
  openOrFocusEpicIntent,
} from "@/lib/tab-navigation";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";
import type { EpicNodeRef } from "@/stores/epics/canvas/types";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";

/**
 * null handler is the signal to render plain text, not a dead click.
 */
export type TraycerReferenceOpenHandler =
  | ((event: MouseEvent<HTMLElement>) => void)
  | null;

/** onOpen is null when not openable. sameEpicNodeRef is the only drag-eligible case; click also works for cross-epic navigate. */
export interface TraycerReferenceOpenState {
  readonly onOpen: TraycerReferenceOpenHandler;
  readonly sameEpicNodeRef: EpicNodeRef | null;
}

/** none: handler null, chip is plain text. same-epic-node: preview tile. navigate: target epic; traycer-epic carries undefined focusArtifactId. */
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

/** Shared open handler for legacy `<traycer-*>` tags. Same epic: open a preview tile; cross epic: `focusArtifactId = nodeId` with a fresh `focusedAt`. Without an epic-session handle (or an active host for a node ref) the handler is `null` and the chip is plain text. */
export function useTraycerReferenceOpenHandler(input: {
  readonly epicId: string | undefined;
  readonly nodeId: string | undefined;
  /** true: missing nodeId is non-openable. false (traycer-epic): focus epic with no node. */
  readonly requiresNode: boolean;
}): TraycerReferenceOpenState {
  const handle = useMaybeOpenEpicHandle();
  const activeHostId = useCanvasHostId();
  const navigate = useNavigate();
  const { openTile } = useEpicTileNavigation();

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
          // A single click on the reference: the resolver turns that into the
          // epic's current tab, with the preview/permanent call left to the
          // placement settings.
          openTile({
            node: target.ref,
            target: { epicId: target.epicId },
            gesture: "single",
            modifiers: modifiersFromMouseEvent(event),
            placement: null,
            dedupe: true,
            source: "direct_ui",
          });
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
            undefined,
          );
          return;
      }
    },
    [target, navigate, openTile],
  );

  // Only a resolved `same-epic-node` surfaces a ref; `navigate` and `none`
  // yield `null`, so the chip can gate drag to the same-epic case alone.
  const sameEpicNodeRef = target.kind === "same-epic-node" ? target.ref : null;

  if (target.kind === "none") return { onOpen: null, sameEpicNodeRef: null };
  return { onOpen: handler, sameEpicNodeRef };
}

/**
 * Resolve click once in render. All not-openable cases collapse to none.
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

  // Same-epic node: preview tile, or plain text if it does not resolve.
  // Epic-only (no node id) falls through to navigate even for the open epic.
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
