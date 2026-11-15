import { useRef, type ReactNode } from "react";
import type { BotFeedbackDraftProjection } from "@traycer/protocol/persistence/epic/messages";
import type { ChatFeedbackDraftDecideResponse } from "@traycer/protocol/host/chat/feedback-draft";
import {
  FeedbackDraftView,
  type FeedbackDraftReadOnlyReason,
} from "@/components/chat/segments/feedback-draft-card";
import {
  useHostClientForHostId,
  useHostDirectoryEntryForHostId,
} from "@/hooks/host/use-host-client-for-host-id";
import {
  useChatFeedbackDraftDecideMutation,
  useChatFeedbackDraftSupported,
} from "@/hooks/chats/use-chat-feedback-draft";
import { useHostCapabilityProbe } from "@/hooks/host/use-host-capability-probe";
import { newFeedbackDraftClientActionId } from "@/lib/chats/feedback-draft-client-action-id";

/** A projected draft acts only on its original block, under the person's sign-in. */
export function BotFeedbackDraftCard(
  props: BotFeedbackDraftProjection,
): ReactNode {
  const { source } = props;
  const client = useHostClientForHostId(source.hostId);
  const supported = useChatFeedbackDraftSupported(source.hostId);
  const entry = useHostDirectoryEntryForHostId(source.hostId);
  useHostCapabilityProbe({
    client,
    stale:
      supported !== true &&
      (props.draft.state === "pending" || props.draft.state === "failed"),
    incarnation: [
      source.hostId,
      entry?.version ?? null,
      entry?.transportDialability ?? null,
    ],
  });
  const decide = useChatFeedbackDraftDecideMutation(client, source.blockId);
  const attempt = useRef<string | null>(null);
  const response = decide.data;
  const returned = response?.feedbackDraft ?? null;
  // A newer terminal projection must not regress to an older pending response.
  const draft =
    props.draft.state === "pending" || props.draft.state === "failed"
      ? (returned ?? props.draft)
      : props.draft;
  return (
    <FeedbackDraftView
      id={source.blockId}
      draft={draft}
      headerFindUnitId={null}
      live={{
        blockRef: source,
        client,
        readOnly: sourceReadOnlyReason(
          response,
          supported,
          client !== null,
          decide.isError,
        ),
        isPending: decide.isPending || supported === null,
        decide: (decision, includeDiagnostics) => {
          // An unknown transport result reuses the same click identity.
          attempt.current ??= newFeedbackDraftClientActionId();
          decide.mutate(
            {
              epicId: source.epicId,
              chatId: source.chatId,
              blockId: source.blockId,
              decision,
              includeDiagnostics: decision === "send" && includeDiagnostics,
              clientActionId: attempt.current,
            },
            {
              onSuccess: () => {
                attempt.current = null;
              },
            },
          );
        },
      }}
    />
  );
}

function sourceReadOnlyReason(
  response: ChatFeedbackDraftDecideResponse | undefined,
  supported: boolean | null,
  connected: boolean,
  transportError: boolean,
): FeedbackDraftReadOnlyReason | null {
  if (response?.kind === "error" && response.code === "not-allowed")
    return "not-allowed";
  if (supported === false) return "host-unsupported";
  if (!connected || transportError) return "source-unavailable";
  if (
    response?.kind === "error" &&
    (response.code === "session-unavailable" ||
      response.code === "not-draft-block")
  )
    return "source-unavailable";
  return null;
}
