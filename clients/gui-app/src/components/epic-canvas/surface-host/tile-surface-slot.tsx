/**
 * Cold until the real Epic session handle is available (`useMaybeOpenEpicHandle` returns `null` before `EpicSessionGate` opens): no publish happens, so `StableTileSurfaceHost` keeps the record dormant per the design's cold/ready contract - never a throwing `useOpenEpicHandle` call from a store-selected-but-not-yet-ready record.
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

  // The publish above is the ONLY writer of this record's `canvasActivity.tabSelected`, so the claim has to be withdrawn by the same writer - the registry cannot re-derive it, and no ancestor outlives every transition that ends it.
  // Three shapes end a claim, and only this cleanup sees all three: the slot re-pointed at a different instance (a canvas that mounts one tile at a time reconciles rather than remounts, so the outgoing instance loses its writer without anything unmounting), the pane torn down, and the whole canvas navigated away from while membership still retains its chats.
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
