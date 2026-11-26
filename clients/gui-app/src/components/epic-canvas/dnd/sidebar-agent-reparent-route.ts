import { useCallback, useSyncExternalStore } from "react";
import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";
import { readPoolComputerUnavailable } from "@/hooks/host/use-pool-computer-unavailable";
import { useServingPeerHostId } from "@/lib/host/serving-decision";
import {
  resolveProjectedReparentNode,
  type ProjectedReparentNode,
} from "@/lib/reparent-projection-rules";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";
import {
  routeChatWrite,
  type ChatWriteRoute,
} from "@/stores/epics/open-epic/chat-write-routing";
import { readEpicDocRecordArms } from "@/stores/epics/open-epic/doc-record-arms";
import type { OpenEpicState } from "@/stores/epics/open-epic/store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { ownValue } from "@/lib/own-value";

type ReparentRoute = ChatWriteRoute | "doc";

/** A doc-resident terminal agent has no registry row for the owner RPC to update. */
export function agentReparentRoute(
  state: OpenEpicState,
  node: ProjectedReparentNode,
  ownerHostId: string | null,
): ReparentRoute {
  if (node.type === "terminal-agent") {
    const agent = ownValue(state.tuiAgents.byId, node.id);
    return agent === undefined || agent.docResident ? "doc" : "registry-rpc";
  }
  if (node.type !== "chat") return "doc";
  return routeChatWrite({
    chat: ownValue(state.chats.byId, node.id),
    docArm: readEpicDocRecordArms(ownerHostId),
  });
}

export function reparentOwnerHostId(
  state: OpenEpicState,
  node: ProjectedReparentNode,
  sessionHostId: string | null,
): string | null {
  if (node.family !== "agent") return sessionHostId;
  const record =
    node.type === "terminal-agent"
      ? ownValue(state.tuiAgents.byId, node.id)
      : ownValue(state.chats.byId, node.id);
  return record?.hostId ?? sessionHostId;
}

export function readPoolAgentReparentBlocked(
  route: ReparentRoute,
  ownerHostId: string | null,
): boolean {
  return (
    route !== "doc" &&
    readPoolComputerUnavailable(route === "unavailable" ? null : ownerHostId)
  );
}

export function usePoolSidebarReparentBlocked(
  nodeId: string,
  sessionHostId: string | null,
): boolean {
  const onPool = useServingPeerHostId() === POOL_HOST_ID;
  const handle = useMaybeOpenEpicHandle();
  const store = onPool && handle !== null ? handle.store : null;
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (store === null) return () => undefined;
      const stopProjection = store.subscribe(onChange);
      const stopLeases = useSelectionAuthorityStore.subscribe(onChange);
      return () => {
        stopProjection();
        stopLeases();
      };
    },
    [store],
  );
  const getSnapshot = useCallback(() => {
    if (store === null) return false;
    const state = store.getState();
    const node = resolveProjectedReparentNode(state.tree, nodeId);
    if (node?.family !== "agent") return false;
    const ownerHostId = reparentOwnerHostId(state, node, sessionHostId);
    return readPoolAgentReparentBlocked(
      agentReparentRoute(state, node, ownerHostId),
      ownerHostId,
    );
  }, [nodeId, sessionHostId, store]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
