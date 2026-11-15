import { MessageSquare } from "lucide-react";
import { useContext, useMemo, type ReactNode } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useRegisteredEpicLiveAgents } from "@/lib/epic-selectors";
import { useOptionalHostClient, type HostRpcRegistry } from "@/lib/host";
import { resolvePoolTierHostClient } from "@/lib/host/binding-host-client";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";
import { extractText } from "./extract-react-node-text";
import { TraycerReferenceChip } from "./traycer-reference-chip";
import { useTraycerReferenceOpenHandler } from "./use-traycer-reference-open";

interface TraycerChatReferenceProps {
  "data-epic-id"?: string;
  "data-chat-id"?: string;
  "data-title"?: string;
  children?: ReactNode;
}

/**
 * `<traycer-chat>` - opens the agent its ids name. Same-epic opens a chat
 * preview tile; cross-epic navigates and focuses the chat via
 * `focusArtifactId` (no `focusChatId`).
 *
 * The chip is drawn with the agent's own title, never with what the writer
 * put inside the tag: that text is shown only while no title is known.
 */
export function TraycerChatReference(props: TraycerChatReferenceProps) {
  const epicId = props["data-epic-id"];
  const chatId = props["data-chat-id"];
  const { onOpen, sameEpicNodeRef } = useTraycerReferenceOpenHandler({
    epicId,
    nodeId: chatId,
    requiresNode: true,
  });
  return (
    <TraycerReferenceChip
      icon={<MessageSquare className="size-3.5" aria-hidden />}
      title={props["data-title"]}
      refKind="chat"
      onOpen={onOpen}
      sameEpicNodeRef={sameEpicNodeRef}
      epicId={epicId}
    >
      {epicId === undefined || chatId === undefined ? (
        labelAsWritten(props.children)
      ) : (
        <ChatReferenceLabel taskId={epicId} chatId={chatId}>
          {props.children}
        </ChatReferenceLabel>
      )}
    </TraycerReferenceChip>
  );
}

/** What stands in for a title nothing has named. */
const UNNAMED_AGENT_LABEL = "Agent";
const UNTITLED_AGENT_LABEL = "Untitled agent";

function labelAsWritten(written: ReactNode): ReactNode {
  return extractText(written).trim().length === 0
    ? UNNAMED_AGENT_LABEL
    : written;
}

/**
 * The agent's title: a task mounted in this window answers from its live
 * projection, and only an agent no mounted task holds is looked up.
 */
function ChatReferenceLabel(props: {
  readonly taskId: string;
  readonly chatId: string;
  readonly children: ReactNode;
}): ReactNode {
  const { taskId, chatId } = props;
  const refs = useMemo(
    () => [{ epicId: taskId, agentId: chatId }],
    [taskId, chatId],
  );
  const [live] = useRegisteredEpicLiveAgents(refs);
  const queryClient = useContext(QueryClientContext);
  const hostClient = useOptionalHostClient();
  if (live !== null) {
    return live.title ?? UNTITLED_AGENT_LABEL;
  }
  // Markdown also renders with no host or query client behind it (the layout
  // editor's sample transcript).
  if (queryClient === undefined || hostClient === null) {
    return labelAsWritten(props.children);
  }
  return (
    <LookedUpChatReferenceLabel
      taskId={taskId}
      chatId={chatId}
      hostClient={hostClient}
    >
      {props.children}
    </LookedUpChatReferenceLabel>
  );
}

function LookedUpChatReferenceLabel(props: {
  readonly taskId: string;
  readonly chatId: string;
  /** The app-wide host: the title is the account's, not one machine's. */
  readonly hostClient: HostClient<HostRpcRegistry>;
  readonly children: ReactNode;
}): ReactNode {
  const { taskId, chatId, hostClient } = props;
  const servingClient = useMemo(
    () => resolvePoolTierHostClient(hostClient),
    [hostClient],
  );
  const viewerUserId = useAuthStore(
    (state) => state.contextMetadata?.userId ?? null,
  );
  const cloudAuthorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  const params = useMemo(() => ({ taskId, chatId }), [taskId, chatId]);
  const lookup = useHostQuery<HostRpcRegistry, "epic.getChatTitle">({
    // The answer is the viewer's: which row the cloud picks, and whether it
    // may be read at all, differ between two accounts on one installation.
    cacheKeyIdentity: viewerUserId === null ? undefined : [viewerUserId],
    client: servingClient,
    method: "epic.getChatTitle",
    params,
    preflight: cloudVerdictPreflight("epic.getChatTitle"),
    options: {
      enabled: cloudAuthorized && viewerUserId !== null,
      refetchOnWindowFocus: false,
    },
  });
  const chat = lookup.data?.chat;
  if (chat === undefined || chat === null) {
    return labelAsWritten(props.children);
  }
  return chat.title ?? UNTITLED_AGENT_LABEL;
}
