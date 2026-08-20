/**
 * Timeline row → its source, opened in the epic.
 *
 * Two steps, always in this order: open (or focus) the owning agent's tile via
 * `openTileInEpic`, then - only for a GUI anchor - park a transcript jump the
 * chat tile picks up. The jump is parked rather than called because the target
 * tile may not be mounted yet at the moment of the click.
 *
 * WHAT EACH ORIGIN KIND DOES:
 *
 * - `gui_block` / `gui_message` → open the owning chat and scroll its
 *   transcript to the anchored block / delivered message.
 * - `tui_session` → open the terminal agent. That IS the whole behavior; a
 *   terminal has no in-transcript anchor to scroll to.
 * - `origin: null` → open the owning agent's tile, no scroll, NO ERROR. This is
 *   a common and legitimate shape (some TUI rows carry no anchor at all), not a
 *   failure.
 *
 * The one case with nothing to do is a row whose agent this epic does not
 * project at all (a half-edge to an agent outside the epic): there is no tile
 * to open, so the row simply carries no jump affordance.
 */
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { v4 as uuidv4 } from "uuid";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { useHostDirectory } from "@/lib/host";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { useRemoteSessionsPollReadiness } from "@/hooks/host/use-remote-sessions-poll-readiness";
import { dialableHostEndpointFor } from "@/lib/host/transport-key";
import { isCommGraphOriginAvailable } from "@/lib/comm-graph/comm-graph-origin-availability";
import {
  makeOpenableNodeRef,
  type EpicArtifactRef,
} from "@/stores/epics/canvas/types";
import { useChatTranscriptJumpStore } from "@/stores/chats/chat-transcript-jump-store";
import type { CommGraphEvent } from "@/lib/comm-graph/comm-graph-events";
import type { CommGraphAgentNode } from "@/lib/comm-graph/comm-graph-model";
import {
  commGraphJumpAgentId,
  commGraphJumpTarget,
} from "@/lib/comm-graph/comm-graph-jump";

export interface CommGraphJump {
  /** Whether this event's owning host is currently reachable. */
  readonly canOpenAgentForEvent: (event: CommGraphEvent) => boolean;
  readonly canJump: (event: CommGraphEvent) => boolean;
  readonly jump: (event: CommGraphEvent) => void;
  /**
   * SENDER-side jump: open the sending chat scrolled to its own "Sent
   * message" card. No captured anchor exists for that side (origin refs are
   * receiver-side; the sender's block id never reaches the host), so the
   * target is resolved by the chat tile AT JUMP TIME from the block's
   * `agentMessageSend` enrichment - receiver + verbatim text, which both the
   * block and the comm-event row durably carry. Available only for message
   * rows whose sender is a projected GUI chat: a terminal sender has no
   * transcript to resolve against, and a notice was never "sent" by anyone.
   */
  readonly canJumpToSender: (event: CommGraphEvent) => boolean;
  readonly jumpToSender: (event: CommGraphEvent) => void;
  /**
   * Created-row jump: open the created agent scrolled to the START of its
   * transcript - the one deterministic landing a creation has (for an
   * A2A-created child, the first message IS its task). Available only when
   * the created agent is a projected GUI chat; a terminal child has no
   * transcript, so its endpoint degrades to a plain tile open.
   */
  readonly canJumpToCreated: (event: CommGraphEvent) => boolean;
  readonly jumpToCreated: (event: CommGraphEvent) => void;
  /**
   * Opens an agent's own tile - the detail panel's header affordance, and the
   * degrade for every endpoint with no anchor of its own. A notice row's IDLE
   * agent is deliberately only ever this: the broker OBSERVED it going quiet,
   * so nothing in its transcript is the notice, and its tail is whatever it
   * happens to be doing now rather than the row that was clicked.
   */
  readonly openAgent: (agent: CommGraphAgentNode) => void;
}

/**
 * A LEGACY chat record that predates `Chat.hostId` has no host to bind to. It
 * opens against the same placeholder the tile itself uses rather than borrowing
 * the app's active host - guessing would silently point the tab at whichever
 * host happened to be selected.
 */
function openableRefForAgent(agent: CommGraphAgentNode): EpicArtifactRef {
  return makeOpenableNodeRef({
    id: agent.id,
    instanceId: uuidv4(),
    type: agent.kind,
    name: agent.name,
    hostId: agent.hostId ?? UNKNOWN_HOST_PLACEHOLDER,
  });
}

export function useCommGraphJump(
  epicId: string,
  agents: ReadonlyArray<CommGraphAgentNode>,
  events: ReadonlyArray<CommGraphEvent>,
): CommGraphJump {
  const tileNavigation = useEpicTileNavigation();
  const directory = useHostDirectory();
  const requestJump = useChatTranscriptJumpStore((s) => s.requestJump);

  const agentById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent])),
    [agents],
  );
  const subscribeToDirectory = useCallback(
    (listener: () => void) => {
      const subscription = directory.onChange(listener);
      return () => subscription.dispose();
    },
    [directory],
  );
  const relevantHostIds = useMemo(() => {
    const hostIds = new Set(events.map((event) => event.hostId));
    for (const agent of agents) {
      if (agent.hostId !== null) hostIds.add(agent.hostId);
    }
    return Array.from(hostIds).sort();
  }, [agents, events]);
  // Dialability now depends on the pull-only session cache, so the directory
  // subscription alone cannot see a session dying or appearing under an
  // `offline`/plan-restricted origin. This second subscription re-renders on a
  // readiness flip; the snapshot read below then re-runs with the new answer,
  // so jump affordances follow the route's real state instead of freezing at
  // whatever was true on the last directory emit.
  const hasReadySessionFor = useRemoteSessionsPollReadiness(relevantHostIds);
  const getDirectorySnapshot = useCallback(() => {
    return relevantHostIds
      .map((hostId) => {
        const endpoint = dialableHostEndpointFor(
          directory.findById(hostId),
          hasReadySessionFor(hostId),
        );
        return `${hostId}:${endpoint?.websocketUrl ?? "offline"}`;
      })
      .join("|");
  }, [directory, hasReadySessionFor, relevantHostIds]);
  const directorySnapshot = useSyncExternalStore(
    subscribeToDirectory,
    getDirectorySnapshot,
    () => "",
  );
  const isOriginAvailable = useCallback(
    (event: CommGraphEvent): boolean => {
      void directorySnapshot;
      return isCommGraphOriginAvailable(
        directory,
        event,
        hasReadySessionFor(event.hostId),
      );
    },
    [directory, directorySnapshot, hasReadySessionFor],
  );

  const canJump = useCallback(
    (event: CommGraphEvent): boolean => {
      if (!isOriginAvailable(event)) return false;
      const target = commGraphJumpTarget(event);
      if (target === null) return false;
      return agentById.has(commGraphJumpAgentId(target));
    },
    [agentById, isOriginAvailable],
  );

  const jump = useCallback(
    (event: CommGraphEvent): void => {
      if (!isOriginAvailable(event)) return;
      const target = commGraphJumpTarget(event);
      if (target === null) return;
      const agent = agentById.get(commGraphJumpAgentId(target));
      if (agent === undefined) return;
      tileNavigation.openTileInEpic(epicId, openableRefForAgent(agent));
      if (target.kind === "chat-block") {
        requestJump(target.chatId, { kind: "block", blockId: target.blockId });
        return;
      }
      if (target.kind === "chat-message") {
        requestJump(target.chatId, {
          kind: "message",
          messageId: target.messageId,
        });
      }
    },
    [agentById, epicId, isOriginAvailable, requestJump, tileNavigation],
  );

  const canJumpToSender = useCallback(
    (event: CommGraphEvent): boolean => {
      if (!isOriginAvailable(event)) return false;
      if (event.kind !== "a2a_message") return false;
      if (event.senderAgentId === null || event.receiverAgentId === null) {
        return false;
      }
      if (event.messageText === null) return false;
      return agentById.get(event.senderAgentId)?.kind === "chat";
    },
    [agentById, isOriginAvailable],
  );

  const jumpToSender = useCallback(
    (event: CommGraphEvent): void => {
      if (!isOriginAvailable(event)) return;
      if (
        event.kind !== "a2a_message" ||
        event.senderAgentId === null ||
        event.receiverAgentId === null ||
        event.messageText === null
      ) {
        return;
      }
      const sender = agentById.get(event.senderAgentId);
      if (sender === undefined || sender.kind !== "chat") return;
      tileNavigation.openTileInEpic(epicId, openableRefForAgent(sender));
      requestJump(event.senderAgentId, {
        kind: "sent-message",
        receiverAgentId: event.receiverAgentId,
        messageText: event.messageText,
        timestamp: event.timestamp,
      });
    },
    [agentById, epicId, isOriginAvailable, requestJump, tileNavigation],
  );

  const canJumpToCreated = useCallback(
    (event: CommGraphEvent): boolean => {
      if (!isOriginAvailable(event)) return false;
      if (event.kind !== "agent_created") return false;
      if (event.receiverAgentId === null) return false;
      return agentById.get(event.receiverAgentId)?.kind === "chat";
    },
    [agentById, isOriginAvailable],
  );

  const jumpToCreated = useCallback(
    (event: CommGraphEvent): void => {
      if (!isOriginAvailable(event)) return;
      if (event.kind !== "agent_created" || event.receiverAgentId === null) {
        return;
      }
      const created = agentById.get(event.receiverAgentId);
      if (created === undefined || created.kind !== "chat") return;
      tileNavigation.openTileInEpic(epicId, openableRefForAgent(created));
      requestJump(event.receiverAgentId, { kind: "first-message" });
    },
    [agentById, epicId, isOriginAvailable, requestJump, tileNavigation],
  );

  const openAgent = useCallback(
    (agent: CommGraphAgentNode): void => {
      tileNavigation.openTileInEpic(epicId, openableRefForAgent(agent));
    },
    [epicId, tileNavigation],
  );

  return {
    canOpenAgentForEvent: isOriginAvailable,
    canJump,
    jump,
    canJumpToSender,
    jumpToSender,
    canJumpToCreated,
    jumpToCreated,
    openAgent,
  };
}
