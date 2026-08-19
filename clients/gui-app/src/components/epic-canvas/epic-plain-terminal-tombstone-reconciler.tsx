import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import { reconcileRetainedPlainTerminalTombstones } from "@/lib/terminals/plain-terminal-presentation-invalidation";
import {
  useEpicCanvasStore,
  type EpicCanvasStore,
} from "@/stores/epics/canvas/store";
import { isUnsupportedEpicTerminalRef } from "@/stores/epics/canvas/types";

function supportedEpicTerminalHostIdsForEpic(
  epicId: string,
  state: Pick<
    EpicCanvasStore,
    "tabsById" | "canvasByTabId" | "closedTilePayloadsByTabId"
  >,
): readonly string[] {
  const hostIds = new Set<string>();
  for (const tab of Object.values(state.tabsById)) {
    if (tab?.epicId !== epicId) continue;
    for (const ref of Object.values(
      state.canvasByTabId[tab.tabId]?.tilesByInstanceId ?? {},
    )) {
      if (ref?.type === "terminal" && !isUnsupportedEpicTerminalRef(ref)) {
        hostIds.add(ref.hostId);
      }
    }
    for (const payload of Object.values(
      state.closedTilePayloadsByTabId[tab.tabId] ?? {},
    )) {
      const ref = payload?.node;
      if (ref?.type === "terminal" && !isUnsupportedEpicTerminalRef(ref)) {
        hostIds.add(ref.hostId);
      }
    }
  }
  return [...hostIds].sort();
}

function epicPresentationSignatureForEpic(
  epicId: string,
  state: Pick<
    EpicCanvasStore,
    "tabsById" | "canvasByTabId" | "closedTilePayloadsByTabId"
  >,
): string {
  const ids: string[] = [];
  for (const tab of Object.values(state.tabsById)) {
    if (tab?.epicId !== epicId) continue;
    for (const [instanceId, ref] of Object.entries(
      state.canvasByTabId[tab.tabId]?.tilesByInstanceId ?? {},
    )) {
      if (ref?.type === "terminal" && !isUnsupportedEpicTerminalRef(ref)) {
        ids.push(`live:${tab.tabId}:${instanceId}:${ref.hostId}:${ref.id}`);
      }
    }
    for (const [instanceId, payload] of Object.entries(
      state.closedTilePayloadsByTabId[tab.tabId] ?? {},
    )) {
      const ref = payload?.node;
      if (ref?.type === "terminal" && !isUnsupportedEpicTerminalRef(ref)) {
        ids.push(`closed:${tab.tabId}:${instanceId}:${ref.hostId}:${ref.id}`);
      }
    }
  }
  return ids.sort().join("|");
}

/**
 * Epic-tab retained-tombstone ingress. Mounted outside EpicSessionGate so
 * a closed-only late payload is consumed even when the open handle is
 * unavailable and no live terminal tile remains.
 */
export function EpicPlainTerminalTombstoneReconciler(props: {
  readonly epicId: string;
}): null {
  const queryClient = useQueryClient();
  const presentationSignature = useEpicCanvasStore((state) =>
    epicPresentationSignatureForEpic(props.epicId, state),
  );

  useEffect(() => {
    const hostIds = supportedEpicTerminalHostIdsForEpic(
      props.epicId,
      useEpicCanvasStore.getState(),
    );
    for (const hostId of hostIds) {
      reconcileRetainedPlainTerminalTombstones({
        queryClient,
        queryKey: hostQueryKeys.plainTerminals(hostId, {
          kind: "epic",
          epicId: props.epicId,
        }),
        hostId,
      });
    }
  }, [props.epicId, queryClient, presentationSignature]);

  return null;
}
