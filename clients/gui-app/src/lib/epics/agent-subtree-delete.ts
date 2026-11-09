import type { OpenEpicState } from "@/stores/epics/open-epic/store";
import { selectNestedAgentsKnown } from "@/lib/epic-tree-cascade";
import { resolveChatWriteRoute } from "@/hooks/epic/use-chat-write-route";
import { readRecordWriteServingHostId } from "@/hooks/epic/use-epic-record-mutation-client";
import { readSelectionFleetSnapshot } from "@/lib/host/owner-gone-write-routing";
import { isSurfacePinDeposed } from "@/stores/host/surface-host-selection-store";
import { agentActivityTiers } from "@/lib/agent-activity";
import { getEpicAgentActivity } from "@/stores/agent-activity-store";
import { getChatSessionRegistry } from "@/lib/registries/chat-session-registry";
import { chatActivityIndicator } from "@/stores/chats/chat-run-activity";
import { displayTitle } from "@/lib/display-title";

export interface AgentDeleteTarget {
  readonly id: string;
  readonly kind: "chat" | "terminal-agent";
  readonly name: string;
  readonly hostId: string | null;
}

/** IDs come from the canonical agent-only subtree, never a filtered panel. */
export function agentSubtreeDeleteTargets(
  state: OpenEpicState,
  ids: readonly string[],
  sessionHostId: string | null,
): readonly AgentDeleteTarget[] {
  return ids.flatMap((id) => {
    if (!Object.hasOwn(state.tree.nodeById, id)) return [];
    const node = state.tree.nodeById[id];
    const kind = node.type === "chat" ? "chat" : "terminal-agent";
    let ownerHostId: string | null = null;
    if (kind === "chat" && Object.hasOwn(state.chats.byId, id)) {
      ownerHostId = state.chats.byId[id].hostId;
    } else if (
      kind === "terminal-agent" &&
      Object.hasOwn(state.tuiAgents.byId, id)
    ) {
      ownerHostId = state.tuiAgents.byId[id].hostId;
    }
    return [
      {
        id,
        kind,
        name: displayTitle(node.title, "agent"),
        hostId: ownerHostId ?? sessionHostId,
      },
    ];
  });
}

/** The same raw running tier as the archive gate, before attention-kind folding. */
export function agentSubtreeDeleteBlockedReason(
  state: OpenEpicState,
  epicId: string,
  ids: readonly string[],
  sessionHostId: string | null,
): string | null {
  if (!selectNestedAgentsKnown(state))
    return "Nested agents are still loading.";
  const awareness = agentActivityTiers(getEpicAgentActivity(epicId));
  const fleet = readSelectionFleetSnapshot();
  for (const target of agentSubtreeDeleteTargets(state, ids, sessionHostId)) {
    const session =
      target.kind === "chat" && target.hostId !== null
        ? getChatSessionRegistry().peek(epicId, target.id, target.hostId)
        : null;
    const running =
      (session === null
        ? null
        : chatActivityIndicator(session.store.getState())) ??
      awareness.get(target.id) ??
      false;
    if (running !== false)
      return `“${target.name}” is working. You can still delete only the selected agent.`;
    if (
      target.kind === "chat" &&
      resolveChatWriteRoute({
        chatsById: state.chats.byId,
        isChatRow: true,
        nodeId: target.id,
        sessionHostId,
      }) === "unavailable"
    ) {
      return `“${target.name}” isn't adopted by its host yet, so it can't be deleted from here.`;
    }
    if (target.hostId === null)
      return `The host for “${target.name}” isn't available.`;
    const servingHostId = readRecordWriteServingHostId(
      target.hostId,
      target.kind === "chat" ? "epic.deleteChat" : "epic.deleteTuiAgent",
      sessionHostId,
    );
    if (
      servingHostId !== target.hostId ||
      isSurfacePinDeposed(target.hostId, fleet)
    ) {
      return `“${target.name}” is on an offline host. Delete it separately or wait for its host to reconnect.`;
    }
  }
  return null;
}
