/**
 * Ticket 21 slice 4: `TabGroupView`'s hosted-chat counterpart to
 * `ActiveTabBody` - a pure geometry anchor and environment publisher, no
 * chat content of its own. The real `ChatTile`/`ChatMessages` body paints
 * inside `StableTileSurfaceHost`'s fixed plane (slice 3); this slot only
 * marks WHERE that body should be positioned and publishes the environment
 * it needs to render itself correctly there.
 *
 * This slot's OWN plain placeholder element - occupying the exact rect the
 * removed `ActiveTabBody` used to - publishes as `services.geometryAnchorElement`,
 * the geometry coordinator's measurement anchor. It is NOT the same thing as
 * `services.panePortalContainer`: that field carries the REAL ambient
 * `PanePortalContainerContext` value (`SurfacePresentationBoundary`'s
 * top-level portal host for kept-mounted popovers/composer overlays),
 * captured here via `usePanePortalContainer()` and republished so a hosted
 * chat's bridge can re-provide the genuine context value instead of this
 * slot's own geometry element (design-review slice-4 finding 5).
 *
 * Cold until the real Epic session handle is available
 * (`useMaybeOpenEpicHandle` returns `null` before `EpicSessionGate` opens):
 * no publish happens, so `StableTileSurfaceHost` keeps the record dormant
 * per the design's cold/ready contract - never a throwing `useOpenEpicHandle`
 * call from a store-selected-but-not-yet-ready record.
 */
import { use, useLayoutEffect, useState, type ReactNode } from "react";
import {
  PaneSurfaceActivityContext,
  usePaneFocusProbe,
  usePanePortalContainer,
  usePaneVisible,
} from "@/components/epic-tabs/pane-visibility-context";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";
import {
  publishTileSurfaceEnvironment,
  retractTileSurfacePresentation,
} from "@/components/epic-canvas/surface-host/tile-surface-environment-registry";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";
import { usePaneActivationFocusIntent } from "@/components/epic-canvas/pane-activation";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";

export interface TileSurfaceSlotProps {
  readonly node: EpicCanvasTileRef;
  readonly epicId: string;
  readonly paneId: string;
  readonly viewTabId: string;
  readonly tabSelected: boolean;
  readonly canvasPaneActive: boolean;
}

export function TileSurfaceSlot(props: TileSurfaceSlotProps): ReactNode {
  const { node, epicId, paneId, viewTabId, tabSelected, canvasPaneActive } =
    props;
  const [slotElement, setSlotElement] = useState<HTMLDivElement | null>(null);
  const topLevelVisible = usePaneVisible();
  const topLevelFocused = use(PaneSurfaceActivityContext).focused;
  const isPaneFocusedNow = usePaneFocusProbe();
  const panePortalContainer = usePanePortalContainer();
  const paneActivationFocusIntent = usePaneActivationFocusIntent();
  const openEpicHandle = useMaybeOpenEpicHandle();
  const hostClient = useEpicSessionHostClient();

  useLayoutEffect(() => {
    if (slotElement === null) return;
    if (openEpicHandle === null) return;
    publishTileSurfaceEnvironment({
      identity: {
        instanceId: node.instanceId,
        tileKind: node.type,
        contentId: node.id,
        epicId,
        hostId: node.hostId,
      },
      placement: { epicId, viewTabId, paneId, hostId: node.hostId },
      presentation: { topLevelVisible, topLevelFocused },
      canvasActivity: { tabSelected, canvasPaneActive },
      paneActivation: { focusIntent: paneActivationFocusIntent },
      services: {
        openEpicHandle,
        hostClient,
        geometryAnchorElement: slotElement,
        panePortalContainer,
        isPaneFocusedNow,
      },
    });
  }, [
    slotElement,
    openEpicHandle,
    hostClient,
    node.instanceId,
    node.type,
    node.id,
    node.hostId,
    epicId,
    viewTabId,
    paneId,
    topLevelVisible,
    topLevelFocused,
    tabSelected,
    canvasPaneActive,
    paneActivationFocusIntent,
    panePortalContainer,
    isPaneFocusedNow,
  ]);

  // The publish above is the ONLY writer of this record's
  // `canvasActivity.tabSelected`, so the claim has to be withdrawn by the same
  // writer - the registry cannot re-derive it, and no ancestor outlives every
  // transition that ends it. Three shapes end a claim, and only this cleanup
  // sees all three: the slot re-pointed at a different instance (a canvas that
  // mounts one tile at a time reconciles rather than remounts, so the outgoing
  // instance loses its writer without anything unmounting), the pane torn
  // down, and the whole canvas navigated away from while membership still
  // retains its chats. A claim left standing after any of them keeps the
  // record painting - and since every record of a pane is positioned at that
  // pane's rect, it paints stacked on whatever holds the rect now, with no
  // republish left to correct it.
  //
  // Scoped to the identity of the claim (`instanceId` + the anchor that
  // carries it) rather than to the publish effect's full dependency list: a
  // mere republish - focus, visibility, a new portal container - must not
  // round-trip presentation through `false`.
  const claimedInstanceId = node.instanceId;
  useLayoutEffect(() => {
    return () => {
      retractTileSurfacePresentation(claimedInstanceId, slotElement);
    };
  }, [claimedInstanceId, slotElement]);

  return (
    <div
      ref={setSlotElement}
      data-testid="tile-surface-slot"
      data-tile-instance-id={node.instanceId}
      className="h-full w-full"
    />
  );
}
