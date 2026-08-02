import { useState } from "react";
import type {
  ChatForkChatNotice,
  ChatForkDecisionOption,
  ChatForkEvent,
  ChatForkResolveChatOutcome,
} from "@traycer/protocol/host/chat-fork/schemas";
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
import {
  useChatForkCandidateHeadQuery,
  useChatForkEventQuery,
  useChatForkReadCandidateHeadSupported,
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
        {confirmation !== null ? (
          <ForkResolvedConfirmation
            results={confirmation.results}
            onRetry={() => setConfirmation(null)}
            onDone={() => handleOpenChange(false)}
          />
        ) : event === null ? (
          <ForkDialogEmptyState isLoading={eventQuery.isLoading} />
        ) : (
          <ForkDialogBody
            event={event}
            onResolved={(results) =>
              setConfirmation({ episodeId: event.episodeId, results })
            }
          />
        )}
      </DialogContent>
    </Dialog>
  );
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
        {event.options.map((option) => (
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

function formatCapturedAt(capturedAtMs: number): string {
  return new Date(capturedAtMs).toLocaleString();
}

function ChatForkChatComparison(props: { readonly chat: ChatForkChatNotice }) {
  const { chat } = props;
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3 text-sm">
      <div className="font-medium">Chat {chat.chatId}</div>
      <div className="grid grid-cols-2 gap-3">
        <ChatForkCandidateSummaryCard
          title="Published"
          taskId={chat.taskId}
          chatId={chat.chatId}
          candidate={chat.incumbent}
        />
        {chat.candidate === null ? (
          <div className="text-muted-foreground">
            No candidate is available for this chat.
          </div>
        ) : (
          <ChatForkCandidateSummaryCard
            title="Candidate"
            taskId={chat.taskId}
            chatId={chat.chatId}
            candidate={chat.candidate}
          />
        )}
      </div>
    </div>
  );
}

function ChatForkCandidateSummaryCard(props: {
  readonly title: string;
  readonly taskId: string;
  readonly chatId: string;
  readonly candidate: ChatForkChatNotice["incumbent"];
}) {
  const { candidate } = props;
  const [inspecting, setInspecting] = useState(false);
  const readSupported = useChatForkReadCandidateHeadSupported();
  const candidateHeadQuery = useChatForkCandidateHeadQuery({
    taskId: props.taskId,
    chatId: props.chatId,
    headSha256: candidate.headSha256,
    enabled: inspecting,
  });

  return (
    <div className="flex flex-col gap-1">
      <div className="font-medium">{props.title}</div>
      <div className="text-muted-foreground">
        {candidate.throughRecordSeq} turn{candidate.throughRecordSeq === 1 ? "" : "s"}
      </div>
      <div className="text-muted-foreground">
        Last activity {formatCapturedAt(candidate.capturedAt)}
      </div>
      <div className="text-muted-foreground">
        {candidate.partCount} part{candidate.partCount === 1 ? "" : "s"}
      </div>
      {/* Both candidates are equally inspectable - the link-to-inspect ruling
          does not single out either side. Hidden entirely (not disabled)
          when the host predates `readCandidateHead`: that RPC degrades
          independently of get/resolve, so the dialog stays functional with
          only the stats above. */}
      {readSupported && !inspecting && (
        <Button
          type="button"
          variant="link"
          className="h-auto justify-start p-0 text-xs"
          onClick={() => setInspecting(true)}
        >
          View
        </Button>
      )}
      {inspecting && (
        <ChatForkCandidateHeadPreview
          isLoading={candidateHeadQuery.isLoading}
          isError={candidateHeadQuery.isError}
          outcome={candidateHeadQuery.data?.outcome ?? null}
        />
      )}
    </div>
  );
}

function ChatForkCandidateHeadPreview(props: {
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly outcome:
    | { readonly status: "ok"; readonly head: string }
    | { readonly status: "not-found" }
    | null;
}) {
  if (props.isLoading) {
    return (
      <AgentSpinningDots
        className={undefined}
        testId={undefined}
        variant={undefined}
      />
    );
  }
  // An RPC failure (network, 401/403 from a denied/expired session) is NOT
  // the same state as "not-found" - conflating them told the user their
  // candidate was gone when the real answer was "couldn't ask". `isError`
  // arrives from the query's own error channel, never inferred from a
  // missing `outcome`.
  if (props.isError) {
    return (
      <p className="text-xs text-destructive">
        Couldn't load this candidate. Try again.
      </p>
    );
  }
  if (props.outcome === null || props.outcome.status === "not-found") {
    return (
      <p className="text-xs text-muted-foreground">
        This candidate is no longer available to inspect.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      {/*
       * NOTE: this renders the candidate's raw head record, not a readable
       * transcript. The settled ruling calls for inspecting the CHAT, which
       * needs the same assembly pipeline `useCloudChatRead` uses (resolve a
       * head -> fetch parts -> render). That pipeline take an IDENTITY and
       * always resolves the chat's CURRENT (incumbent) head; wiring it to a
       * specific candidate head needs a small adapter port, not new RPCs -
       * but actually mounting the assembled result needs whatever component
       * renders `AssembledChat` today, which this pass did not locate under
       * time budget. Flagged to the assigning agent rather than guessed at.
       */}
      <p className="text-[11px] text-muted-foreground">
        Raw record (not a readable transcript - see the implementation
        report)
      </p>
      <pre className="max-h-32 overflow-auto rounded bg-muted p-2 text-xs">
        {props.outcome.head}
      </pre>
    </div>
  );
}

function ForkResolvedConfirmation(props: {
  readonly results: readonly ChatForkResolveChatOutcome[];
  readonly onRetry: () => void;
  readonly onDone: () => void;
}) {
  const allResolved = props.results.every((r) => r.status === "resolved");
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {allResolved ? "Decision recorded" : "Still finalizing"}
        </DialogTitle>
        <DialogDescription>
          {allResolved
            ? "The divergent history for each chat is preserved as a new chat rather than discarded."
            : "The host detected this fork but hasn't finished filing it yet. Try again in a moment."}
        </DialogDescription>
      </DialogHeader>
      <ul className="flex flex-col gap-2 text-sm">
        {props.results.map((result) => (
          <li key={`${result.taskId}:${result.chatId}`}>
            {result.status === "resolved" ? (
              result.cloneChatId === null ? (
                <span>Chat {result.chatId}: nothing to preserve.</span>
              ) : (
                <span>
                  Chat {result.chatId} → cloned as {result.cloneChatId}
                </span>
              )
            ) : result.status === "not-ready" ? (
              <span>Chat {result.chatId}: not filed yet.</span>
            ) : (
              <span>Chat {result.chatId}: this changed since you chose - retry.</span>
            )}
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
