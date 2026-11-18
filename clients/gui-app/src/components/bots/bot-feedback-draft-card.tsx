import { useRef, useState, type ReactNode } from "react";
import type { BotFeedbackDraftProjection } from "@traycer/protocol/persistence/epic/messages";
import type {
  ChatFeedbackDraftDecideRequest,
  ChatFeedbackDraftDecideResponse,
} from "@traycer/protocol/host/chat/feedback-draft";
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
import { Button } from "@/components/ui/button";
import { hostTransportKeyFor } from "@/lib/host/transport-key";
import { useRemoteSessionPollReadiness } from "@/hooks/agent/use-host-reachability";
import { newFeedbackDraftClientActionId } from "@/lib/chats/feedback-draft-client-action-id";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { HostRpcRegistry } from "@/lib/host";

type FeedbackDraft = BotFeedbackDraftProjection["draft"];

/** A projected draft acts only on its original block, under the person's sign-in. */
export function BotFeedbackDraftCard(
  props: BotFeedbackDraftProjection,
): ReactNode {
  const { source } = props;
  const client = useHostClientForHostId(source.hostId);
  const supported = useChatFeedbackDraftSupported(source.hostId);
  const entry = useHostDirectoryEntryForHostId(source.hostId);
  const readySession = useRemoteSessionPollReadiness(source.hostId);
  const available =
    client !== null && hostTransportKeyFor(entry, readySession) !== null;
  const probe = useHostCapabilityProbe({
    client,
    stale: probeIsStale(available, supported, props.draft),
    incarnation: probeIncarnation(source.hostId, entry),
  });
  const decision = useFeedbackDraftDecision(client, source.blockId);
  const view = sourceView({
    projected: props.draft,
    decision,
    supported,
    available,
    probeFailed: probe.isError,
  });
  const { uncertain } = decision;
  return (
    <>
      <FeedbackDraftView
        id={source.blockId}
        draft={view.draft}
        headerFindUnitId={null}
        live={{
          blockRef: source,
          client,
          readOnly: view.readOnly,
          isPending: view.isPending,
          decide: (choice, includeDiagnostics) =>
            decision.submit({
              epicId: source.epicId,
              chatId: source.chatId,
              blockId: source.blockId,
              decision: choice,
              includeDiagnostics: choice === "send" && includeDiagnostics,
              clientActionId: decision.clickIdentity(),
            }),
        }}
      />
      {view.retry && uncertain !== null ? (
        <Button
          size="sm"
          variant="outline"
          disabled={decision.isPending}
          onClick={() => decision.submit(uncertain)}
        >
          {uncertain.decision === "send" ? "Retry Send" : "Retry Skip"}
        </Button>
      ) : null}
    </>
  );
}

interface FeedbackDraftDecision {
  readonly response: ChatFeedbackDraftDecideResponse | undefined;
  readonly isPending: boolean;
  readonly isError: boolean;
  /** The last request whose outcome the host never confirmed. */
  readonly uncertain: ChatFeedbackDraftDecideRequest | null;
  readonly submit: (request: ChatFeedbackDraftDecideRequest) => void;
  /** An unknown transport result reuses the same click identity. */
  readonly clickIdentity: () => string;
}

function useFeedbackDraftDecision(
  client: HostClient<HostRpcRegistry> | null,
  blockId: string,
): FeedbackDraftDecision {
  const decide = useChatFeedbackDraftDecideMutation(client, blockId);
  const attempt = useRef<string | null>(null);
  const [uncertain, setUncertain] =
    useState<ChatFeedbackDraftDecideRequest | null>(null);
  return {
    response: decide.data,
    isPending: decide.isPending,
    isError: decide.isError,
    uncertain,
    submit: (request) => {
      decide.mutate(request, {
        onError: () => setUncertain(request),
        onSuccess: (result) => {
          if (
            result.kind === "error" &&
            result.code === "session-unavailable"
          ) {
            setUncertain(request);
          } else {
            setUncertain(null);
            attempt.current = null;
          }
        },
      });
    },
    clickIdentity: () => (attempt.current ??= newFeedbackDraftClientActionId()),
  };
}

function isOpen(draft: FeedbackDraft): boolean {
  return draft.state === "pending" || draft.state === "failed";
}

function probeIsStale(
  available: boolean,
  supported: boolean | null,
  draft: FeedbackDraft,
): boolean {
  return available && supported !== true && isOpen(draft);
}

function probeIncarnation(
  hostId: string,
  entry: HostDirectoryEntry | null,
): ReadonlyArray<unknown> {
  return [hostId, entry?.version ?? null, entry?.transportDialability ?? null];
}

function sourceView(input: {
  readonly projected: FeedbackDraft;
  readonly decision: FeedbackDraftDecision;
  readonly supported: boolean | null;
  readonly available: boolean;
  readonly probeFailed: boolean;
}): {
  readonly draft: FeedbackDraft;
  readonly readOnly: FeedbackDraftReadOnlyReason | null;
  readonly isPending: boolean;
  readonly retry: boolean;
} {
  const { projected, decision, supported, available, probeFailed } = input;
  // A newer terminal projection must not regress to an older pending response.
  const draft = isOpen(projected)
    ? (decision.response?.feedbackDraft ?? projected)
    : projected;
  const probeUnanswered = supported === null && probeFailed;
  return {
    draft,
    readOnly: sourceReadOnlyReason(
      decision.response,
      supported,
      available,
      decision.uncertain !== null || decision.isError || probeUnanswered,
    ),
    isPending: decision.isPending || (supported === null && !probeFailed),
    retry:
      decision.uncertain !== null &&
      available &&
      supported === true &&
      isOpen(draft),
  };
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
