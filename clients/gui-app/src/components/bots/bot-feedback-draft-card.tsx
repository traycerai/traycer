import { useState, type ReactNode } from "react";
import type { RequestContext } from "@traycer/protocol/auth/request-context";
import type { BotFeedbackDraftProjection } from "@traycer/protocol/persistence/epic/messages";
import type {
  ChatFeedbackDraftDecideRequest,
  ChatFeedbackDraftDecideResponse,
} from "@traycer/protocol/host/chat/feedback-draft";
import {
  FeedbackDraftView,
  type FeedbackDraftReadOnlyReason,
} from "@/components/chat/segments/feedback-draft-card";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import {
  useHostClientForHostId,
  useHostDirectoryEntryForHostId,
} from "@/hooks/host/use-host-client-for-host-id";
import {
  useChatFeedbackDraftDecideMutation,
  useChatFeedbackDraftDecisionState,
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
  const decision = useFeedbackDraftDecision(client, source);
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
          decide: decision.decide,
        }}
      />
      {view.retry && uncertain !== null ? (
        <Button
          size="sm"
          variant="outline"
          disabled={decision.isPending}
          onClick={decision.retry}
        >
          {uncertain.decision === "send" ? "Retry Send" : "Retry Skip"}
          {decision.isPending ? (
            <AgentSpinningDots
              className="size-3"
              testId={undefined}
              variant={undefined}
            />
          ) : null}
        </Button>
      ) : null}
    </>
  );
}

type Decision = ChatFeedbackDraftDecideRequest["decision"];

/** A request and the account session it was sent in. */
interface SentDecision {
  readonly request: ChatFeedbackDraftDecideRequest;
  readonly context: RequestContext | null;
}

interface FeedbackDraftDecision {
  /** This card's own last answer: its refusals and read-only reasons. */
  readonly response: ChatFeedbackDraftDecideResponse | undefined;
  readonly isError: boolean;
  /** Any surface's decision on the source draft in flight, this session. */
  readonly isPending: boolean;
  /** The stamp any surface's answer gave the source draft, this session. */
  readonly settled: FeedbackDraft | null;
  /** The last request whose outcome the host never confirmed, this session. */
  readonly uncertain: ChatFeedbackDraftDecideRequest | null;
  readonly decide: (decision: Decision, includeDiagnostics: boolean) => void;
  readonly retry: () => void;
}

/**
 * Decides the SOURCE draft through the decision store every surface shares,
 * so a decision made on the task card or the notification row shows here and
 * this card's shows there. It never settles that store: the projection is a
 * mirror, not the draft's authority.
 *
 * Each Send or Skip click is a new click id. Only Retry repeats one: it
 * resends the exact request whose outcome never arrived, so the host replays
 * that click's outcome if it did land. The host matches a repeat by id
 * alone, whatever decision it names, which is why a different click never
 * borrows the id. Retry is offered and sent only in the account session the
 * request was sent in.
 */
function useFeedbackDraftDecision(
  client: HostClient<HostRpcRegistry> | null,
  source: BotFeedbackDraftProjection["source"],
): FeedbackDraftDecision {
  const decide = useChatFeedbackDraftDecideMutation(client, source);
  const shared = useChatFeedbackDraftDecisionState(client, source);
  const [uncertain, setUncertain] = useState<SentDecision | null>(null);
  const currentContext = (): RequestContext | null =>
    client === null ? null : client.getRequestContext();
  const inSession = (context: RequestContext | null): boolean =>
    context !== null && context === currentContext();
  const submit = (request: ChatFeedbackDraftDecideRequest): void => {
    const sent: SentDecision = { request, context: currentContext() };
    decide.mutate(request, {
      onError: () => setUncertain(sent),
      onSuccess: (result) => {
        setUncertain(
          result.kind === "error" && result.code === "session-unavailable"
            ? sent
            : null,
        );
      },
    });
  };
  const visible =
    uncertain !== null && inSession(uncertain.context) ? uncertain : null;
  return {
    response: decide.data,
    isError: decide.isError,
    isPending: shared.isPending,
    settled: shared.settled,
    uncertain: visible === null ? null : visible.request,
    decide: (choice, includeDiagnostics) =>
      submit({
        epicId: source.epicId,
        chatId: source.chatId,
        blockId: source.blockId,
        decision: choice,
        includeDiagnostics: choice === "send" && includeDiagnostics,
        clientActionId: newFeedbackDraftClientActionId(),
      }),
    retry: () => {
      if (uncertain === null) return;
      if (!inSession(uncertain.context)) {
        setUncertain(null);
        return;
      }
      submit(uncertain.request);
    },
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
  // A newer terminal projection must not regress to an older pending answer.
  const draft = isOpen(projected) ? (decision.settled ?? projected) : projected;
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
