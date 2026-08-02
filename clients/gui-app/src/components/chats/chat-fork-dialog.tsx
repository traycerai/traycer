import { useState } from "react";
import type {
  ChatForkChatNotice,
  ChatForkDecisionOption,
  ChatForkEvent,
  ChatForkResolveChatOutcome,
} from "@traycer/protocol/host/chat-fork/schemas";
import type { CloudChatIdentity } from "@traycer/protocol/host/epic/cloud-chat";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { cn } from "@/lib/utils";
import { useAppDialogStore } from "@/stores/dialogs/app-dialog-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { CloudChatDialog } from "@/components/epic-canvas/sidebar/cloud-chat-dialog";
import { useRelativeTimestamp } from "@/lib/relative-time";
import {
  useChatForkEventQuery,
  useChatForkResolveMutation,
} from "@/hooks/chats/use-chat-fork-queries";

/**
 * Ticket 09's fork-resolution dialog.
 *
 * ## The three settled rulings this component implements
 *
 * 1. Non-blocking: mounted once, globally (`AppShell`), open state lives in
 *    `useAppDialogStore` - never forced open by data arriving.
 * 2. Candidates described BY CONTENT, never by device: every field rendered
 *    below comes straight off `ChatForkCandidateSummary` (when / how far /
 *    how much) - `diagnostic` is the only sentence mentioning machine
 *    provenance, and it is rendered as a CAUSE, not an identity. Both
 *    candidates are labeled by what they ARE ("Published" / "Candidate"),
 *    never by which machine holds them.
 * 3. Dismissible; the indicator persists: closing (`Escape`, overlay click,
 *    or the header's close control) only clears local dialog-open state.
 *    Nothing here mutates host or server state on dismiss, and the
 *    underlying `host.chatFork.get` query - the indicator's own data source -
 *    is untouched, so the indicator keeps showing and this dialog reopens
 *    with the same data.
 */
export function ChatForkDialog() {
  const activeDialog = useAppDialogStore((state) => state.activeDialog);
  const closeDialog = useAppDialogStore((state) => state.closeDialog);
  const open = activeDialog === "chat-fork";

  const eventQuery = useChatForkEventQuery();
  const event = eventQuery.data?.event ?? null;
  const [confirmation, setConfirmation] = useState<{
    readonly episodeId: string;
    readonly results: readonly ChatForkResolveChatOutcome[];
  } | null>(null);

  const handleOpenChange = (next: boolean) => {
    if (next) return;
    closeDialog();
    // Local UI state only - never consumes the event. A re-open (from the
    // indicator) after a dismiss reads the exact same `host.chatFork.get`
    // data, because nothing here has told the host anything happened.
    setConfirmation(null);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <ChatForkDialogBody
          confirmation={confirmation}
          event={event}
          isLoading={eventQuery.isLoading}
          onRetry={() => setConfirmation(null)}
          onDone={() => handleOpenChange(false)}
          onResolved={(results) => {
            if (event === null) return;
            setConfirmation({ episodeId: event.episodeId, results });
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function ChatForkDialogBody(props: {
  readonly confirmation: {
    readonly episodeId: string;
    readonly results: readonly ChatForkResolveChatOutcome[];
  } | null;
  readonly event: ChatForkEvent | null;
  readonly isLoading: boolean;
  readonly onRetry: () => void;
  readonly onDone: () => void;
  readonly onResolved: (results: readonly ChatForkResolveChatOutcome[]) => void;
}) {
  if (props.confirmation !== null) {
    return (
      <ForkResolvedConfirmation
        results={props.confirmation.results}
        onRetry={props.onRetry}
        onDone={props.onDone}
      />
    );
  }
  if (props.event === null) {
    return <ForkDialogEmptyState isLoading={props.isLoading} />;
  }
  return <ForkDialogBody event={props.event} onResolved={props.onResolved} />;
}

function ForkDialogEmptyState(props: { readonly isLoading: boolean }) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Fork resolution</DialogTitle>
      </DialogHeader>
      <p className="text-sm text-muted-foreground">
        {props.isLoading
          ? "Loading..."
          : "There's nothing to resolve right now."}
      </p>
    </>
  );
}

function ForkDialogBody(props: {
  readonly event: ChatForkEvent;
  readonly onResolved: (results: readonly ChatForkResolveChatOutcome[]) => void;
}) {
  const { event } = props;
  const [selectedLabel, setSelectedLabel] = useState<
    ChatForkDecisionOption["label"] | null
  >(null);
  const resolveMutation = useChatForkResolveMutation();

  const submit = () => {
    if (selectedLabel === null) return;
    resolveMutation.mutate(
      { episodeId: event.episodeId, label: selectedLabel },
      {
        onSuccess: (data) => {
          if (data.outcome === "stale") return;
          props.onResolved(data.results);
        },
      },
    );
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Fork resolution</DialogTitle>
        <DialogDescription>{event.diagnostic}</DialogDescription>
      </DialogHeader>

      <div className="flex max-h-[50vh] flex-col gap-4 overflow-y-auto">
        {event.chats.map((chat) => (
          <ChatForkChatComparison key={`${chat.taskId}:${chat.chatId}`} chat={chat} />
        ))}
      </div>

      <div className="flex flex-col gap-2">
        {event.options
          // An option that covers no chat at all decides nothing, and
          // offering it invites a choice with no effect. Since the host now
          // covers every chat under both options - a candidate-less chat
          // keeps its incumbent under `keep-this-host-lineage`, disclosed in
          // that option's own `detail` - this only ever fires for an empty
          // episode.
          .filter((option) => Object.keys(option.winners).length > 0)
          .map((option) => (
            <label
              key={option.label}
              className={cn(
                "flex cursor-pointer flex-col gap-1 rounded-md border p-3 text-sm",
                selectedLabel === option.label && "border-primary bg-accent/40",
              )}
            >
              <span className="flex items-center gap-2 font-medium">
                <input
                  type="radio"
                  name="chat-fork-option"
                  checked={selectedLabel === option.label}
                  onChange={() => setSelectedLabel(option.label)}
                />
                {option.label === "keep-cloud-lineage"
                  ? "Keep the published history"
                  : "Keep the candidate's history"}
              </span>
              <span className="text-muted-foreground">{option.detail}</span>
            </label>
          ))}
      </div>

      <DialogFooter>
        <Button
          type="button"
          disabled={selectedLabel === null || resolveMutation.isPending}
          onClick={submit}
        >
          {resolveMutation.isPending ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
          ) : (
            "Confirm choice"
          )}
        </Button>
      </DialogFooter>
    </>
  );
}

function ChatForkChatComparison(props: { readonly chat: ChatForkChatNotice }) {
  const { chat } = props;
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3 text-sm">
      <div className="font-medium">Chat {chat.chatId}</div>
      <div className="grid grid-cols-2 gap-3">
        <PublishedCandidateCard
          taskId={chat.taskId}
          chatId={chat.chatId}
          candidate={chat.incumbent}
        />
        {chat.candidate === null ? (
          <div className="text-muted-foreground">
            No candidate is available for this chat.
          </div>
        ) : (
          <QuarantinedCandidateCard candidate={chat.candidate} />
        )}
      </div>
    </div>
  );
}

/**
 * "When / how far / how much" - 07's own comparison framing, human-formatted
 * (relative time, plain counts). This is the WHOLE comparison for the
 * challenger side (the user ruled it needs to be identified, not inspected);
 * the published side additionally links to a full readable view.
 */
function CandidateStats(props: {
  readonly candidate: ChatForkChatNotice["incumbent"];
}) {
  const { candidate } = props;
  const lastActivity = useRelativeTimestamp(candidate.capturedAt);
  return (
    <>
      <div className="text-muted-foreground">
        {candidate.throughRecordSeq} turn{candidate.throughRecordSeq === 1 ? "" : "s"}
      </div>
      <div className="text-muted-foreground">Last activity {lastActivity}</div>
      <div className="text-muted-foreground">
        {candidate.partCount} part{candidate.partCount === 1 ? "" : "s"}
      </div>
    </>
  );
}

/**
 * The Published/incumbent side: simply the chat's current head, already
 * reachable through the ordinary cloud-chat read surface - the same
 * `CloudChatDialog` the sidebar's "other devices" list uses. The challenger
 * side gets no equivalent read at all (see `QuarantinedCandidateCard`): the
 * user ruled it only needs to be identified, not inspected.
 */
function PublishedCandidateCard(props: {
  readonly taskId: string;
  readonly chatId: string;
  readonly candidate: ChatForkChatNotice["incumbent"];
}) {
  const [viewing, setViewing] = useState(false);
  // The owner arbitrating a fork is always looking at their OWN two
  // lineages - `resolveOwnRepair` is owner-authenticated for exactly that
  // reason - so the signed-in user IS the incumbent's owner. Read
  // synchronously off the auth store rather than a query: by the time a
  // fork event exists, the session is already authenticated.
  const ownerUserId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  const identity: CloudChatIdentity | null =
    ownerUserId === null
      ? null
      : { taskId: props.taskId, chatId: props.chatId, ownerUserId };

  return (
    <div className="flex flex-col gap-1">
      <div className="font-medium">Published</div>
      <CandidateStats candidate={props.candidate} />
      {identity !== null && (
        <Button
          type="button"
          variant="link"
          className="h-auto justify-start p-0 text-xs"
          onClick={() => setViewing(true)}
        >
          View
        </Button>
      )}
      <CloudChatDialog
        identity={identity}
        summary={null}
        open={viewing}
        onOpenChange={setViewing}
      />
    </div>
  );
}

/**
 * The quarantined-candidate side: identified by its summary metadata alone
 * (see `CandidateStats`) - the user ruled this side needs no inspectable
 * content, only enough to tell it apart from the published side.
 */
function QuarantinedCandidateCard(props: {
  readonly candidate: ChatForkChatNotice["incumbent"];
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="font-medium">Candidate</div>
      <CandidateStats candidate={props.candidate} />
    </div>
  );
}

function ForkResolvedConfirmation(props: {
  readonly results: readonly ChatForkResolveChatOutcome[];
  readonly onRetry: () => void;
  readonly onDone: () => void;
}) {
  // `every` on an empty array is vacuously true - an episode whose chats all
  // came back filtered out (e.g. every result was null and dropped upstream)
  // must not render as a decision when nothing was actually recorded.
  const allResolved =
    props.results.length > 0 &&
    props.results.every((r) => r.status === "resolved");
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {allResolved ? "Decision recorded" : "Still finalizing"}
        </DialogTitle>
        <DialogDescription>
          {allResolved
            ? "The divergent history for each chat is preserved as a new chat rather than discarded."
            : "This fork was detected but hasn't finished filing yet. Try again in a moment."}
        </DialogDescription>
      </DialogHeader>
      <ul className="flex flex-col gap-2 text-sm">
        {props.results.map((result) => (
          <li key={`${result.taskId}:${result.chatId}`}>
            <ForkResolvedResultLine result={result} />
          </li>
        ))}
      </ul>
      <DialogFooter>
        {allResolved ? (
          <Button type="button" onClick={props.onDone}>
            Done
          </Button>
        ) : (
          <Button type="button" onClick={props.onRetry}>
            Try again
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

function ForkResolvedResultLine(props: {
  readonly result: ChatForkResolveChatOutcome;
}) {
  const { result } = props;
  if (result.status === "not-ready") {
    return <span>Chat {result.chatId}: not filed yet.</span>;
  }
  if (result.status === "stale") {
    return (
      <span>Chat {result.chatId}: this changed since you chose - retry.</span>
    );
  }
  if (result.cloneChatId === null) {
    return <span>Chat {result.chatId}: nothing to preserve.</span>;
  }
  return (
    <span>
      Chat {result.chatId} → cloned as {result.cloneChatId}
    </span>
  );
}
