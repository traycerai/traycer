import { useMemo } from "react";
import type {
  AgentMessagePeer,
  AgentMessagePeerOrigin,
} from "@traycer/protocol/host/agent/message-peer";
import { useChatContainerId } from "@/components/chat/chat-container-context";
import { useMaybeChatTranscript } from "@/components/chat/chat-transcript-context";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import {
  useEpicAgentReference,
  useMaybeOpenEpicId,
  useRegisteredEpicLiveAgents,
} from "@/lib/epic-selectors";

/** Same-task titles stay live; historical cross-task cards resolve on their host. */
export function useA2AMessagePeer(
  agentId: string,
  origin: AgentMessagePeerOrigin | null,
): AgentMessagePeer | null {
  const epicId = useMaybeOpenEpicId();
  // A bot's transcript keys its routing records by the bot, not a task.
  const containerId = useChatContainerId();
  const local = useEpicAgentReference(agentId);
  const hostId = useTabHostId();
  const transcript = useMaybeChatTranscript();
  const exactLocal = local?.id === agentId;
  const { peer, unsupported } = useResolvedMessagePeer({
    epicId: containerId,
    chatId: transcript?.chatId ?? null,
    agentId,
    origin,
    enabled: !exactLocal,
  });
  // A bot's session lives in the bot's container, which no task registers.
  const refs = useMemo(
    () =>
      peer === null || peer.bot !== null
        ? []
        : [{ epicId: peer.epicId, agentId: peer.agentId }],
    [peer],
  );
  const [live] = useRegisteredEpicLiveAgents(refs);

  // A local prefix match cannot establish the destination task. A missing
  // or ambiguous conversation stays unlinked; only older hosts keep the
  // pre-existing prefix behavior when this lookup is unsupported.
  const canUseLocal = exactLocal || transcript === null || unsupported;
  if (local !== null && epicId !== null && canUseLocal) {
    return {
      epicId,
      agentId: local.id,
      hostId: local.hostId ?? hostId,
      title: local.title.trim().length > 0 ? local.title : null,
      surface: "harnessId" in local ? "tui" : "gui",
      bot: null,
    };
  }
  if (peer === null) return null;
  return { ...peer, title: peerTitle(peer, live?.title) };
}

/**
 * A bot's session is named by the bot, whose current title the host read; a
 * task agent by its live title.
 */
function peerTitle(
  peer: AgentMessagePeer,
  liveTitle: string | null | undefined,
): string | null {
  const name = peer.bot === null ? liveTitle : peer.bot.title;
  return name?.trim() ? name : peer.title;
}

/**
 * One shared lookup per conversation peer, then a message-specific fork
 * fallback. Disabled while the conversation (its container or chat) is unknown.
 */
function useResolvedMessagePeer(input: {
  readonly epicId: string | null;
  readonly chatId: string | null;
  readonly agentId: string;
  readonly origin: AgentMessagePeerOrigin | null;
  readonly enabled: boolean;
}): { readonly peer: AgentMessagePeer | null; readonly unsupported: boolean } {
  const { epicId, chatId, agentId, origin, enabled } = input;
  const client = useTabHostClient();
  const active = enabled && epicId !== null && chatId !== null;
  const params = { epicId: epicId ?? "", chatId: chatId ?? "", agentId };
  const query = useHostQuery({
    client,
    method: "agent.resolveMessagePeer",
    params: { ...params, origin: null },
    cacheKeyIdentity: undefined,
    options: {
      enabled: active,
      staleTime: 30_000,
      poll: true,
    },
  });
  // Forks preserve receiver message ids, while their own chat id has no rows
  // in the original conversation. Only pay for per-message lookup on a miss.
  const inherited = useHostQuery({
    client,
    method: "agent.resolveMessagePeer",
    params: { ...params, origin },
    cacheKeyIdentity: undefined,
    options: {
      enabled: active && origin !== null && query.data?.peer === null,
      staleTime: 30_000,
      poll: true,
    },
  });
  const peer = query.data?.peer ?? inherited.data?.peer ?? null;
  return { peer, unsupported: query.error?.code === "E_HOST_UNSUPPORTED" };
}
