import { useMemo } from "react";
import type {
  AgentMessagePeer,
  AgentMessagePeerOrigin,
} from "@traycer/protocol/host/agent/message-peer";
import { useMaybeChatTranscript } from "@/components/chat/chat-transcript-context";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import {
  useEpicAgentReference,
  useOpenEpicId,
  useRegisteredEpicLiveAgents,
} from "@/lib/epic-selectors";

/** Same-task titles stay live; historical cross-task cards resolve on their host. */
export function useA2AMessagePeer(
  agentId: string,
  origin: AgentMessagePeerOrigin | null,
): AgentMessagePeer | null {
  const epicId = useOpenEpicId();
  const local = useEpicAgentReference(agentId);
  const hostId = useTabHostId();
  const transcript = useMaybeChatTranscript();
  const exactLocal = local?.id === agentId;
  const { peer, unsupported } = useResolvedMessagePeer({
    epicId,
    chatId: transcript?.chatId ?? "",
    agentId,
    origin,
    enabled: !exactLocal && transcript !== null,
  });
  const refs = useMemo(
    () =>
      peer === null ? [] : [{ epicId: peer.epicId, agentId: peer.agentId }],
    [peer],
  );
  const [live] = useRegisteredEpicLiveAgents(refs);

  // A local prefix match cannot establish the destination task. A missing
  // or ambiguous conversation stays unlinked; only older hosts keep the
  // pre-existing prefix behavior when this lookup is unsupported.
  const canUseLocal = exactLocal || transcript === null || unsupported;
  if (local !== null && canUseLocal) {
    return {
      epicId,
      agentId: local.id,
      hostId: local.hostId ?? hostId,
      title: local.title.length > 0 ? local.title : null,
      surface: "harnessId" in local ? "tui" : "gui",
    };
  }
  if (peer === null) return null;
  return { ...peer, title: live?.title ?? peer.title };
}

/** One shared lookup per conversation peer, then a message-specific fork fallback. */
function useResolvedMessagePeer(input: {
  readonly epicId: string;
  readonly chatId: string;
  readonly agentId: string;
  readonly origin: AgentMessagePeerOrigin | null;
  readonly enabled: boolean;
}): { readonly peer: AgentMessagePeer | null; readonly unsupported: boolean } {
  const { epicId, chatId, agentId, origin, enabled } = input;
  const client = useTabHostClient();
  const params = { epicId, chatId, agentId };
  const query = useHostQuery({
    client,
    method: "agent.resolveMessagePeer",
    params: { ...params, origin: null },
    cacheKeyIdentity: undefined,
    options: {
      enabled,
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
      enabled: enabled && origin !== null && query.data?.peer === null,
      staleTime: 30_000,
      poll: true,
    },
  });
  const peer = query.data?.peer ?? inherited.data?.peer ?? null;
  return { peer, unsupported: query.error?.code === "E_HOST_UNSUPPORTED" };
}
