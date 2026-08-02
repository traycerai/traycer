import { useState } from "react";
import type {
  ChatForkChatNotice,
  ChatForkDecisionOption,
  ChatForkEvent,
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
 *    provenance, and it is rendered as a CAUSE, not an identity.
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
    readonly results: ReadonlyArray<{
      readonly taskId: string;
      readonly chatId: string;
      readonly cloneChatId: string | null;
    }>;
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
  readonly onResolved: (
    results: ReadonlyArray<{
      readonly taskId: string;
      readonly chatId: string;
      readonly cloneChatId: string | null;
    }>,
  ) => void;
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
          props.onResolved(
            data.results.map((r) => ({
              taskId: r.taskId,
              chatId: r.chatId,
              cloneChatId: r.cloneChatId,
            })),
          );
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
                : "Keep this device's history"}
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
            This device has no readable candidate for this chat.
          </div>
        ) : (
          <ChatForkCandidateSummaryCard
            title="This device"
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
      {props.title === "This device" && (
        <>
          <Button
            type="button"
            variant="link"
            className="h-auto justify-start p-0 text-xs"
            onClick={() => setInspecting(true)}
          >
            {inspecting ? "Refresh view" : "View"}
          </Button>
          {inspecting && (
            <ChatForkCandidateHeadPreview
              isLoading={candidateHeadQuery.isLoading}
              outcome={candidateHeadQuery.data?.outcome ?? null}
            />
          )}
        </>
      )}
    </div>
  );
}

function ChatForkCandidateHeadPreview(props: {
  readonly isLoading: boolean;
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
  if (props.outcome === null || props.outcome.status === "not-found") {
    return (
      <p className="text-xs text-muted-foreground">
        This candidate is no longer available to inspect.
      </p>
    );
  }
  return (
    <pre className="max-h-32 overflow-auto rounded bg-muted p-2 text-xs">
      {props.outcome.head}
    </pre>
  );
}

function ForkResolvedConfirmation(props: {
  readonly results: ReadonlyArray<{
    readonly taskId: string;
    readonly chatId: string;
    readonly cloneChatId: string | null;
  }>;
  readonly onDone: () => void;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Decision recorded</DialogTitle>
        <DialogDescription>
          The divergent history for each chat is preserved as a new chat
          rather than discarded.
        </DialogDescription>
      </DialogHeader>
      <ul className="flex flex-col gap-2 text-sm">
        {props.results.map((result) => (
          <li key={`${result.taskId}:${result.chatId}`}>
            {result.cloneChatId === null ? (
              <span>Chat {result.chatId}: nothing to preserve.</span>
            ) : (
              <span>
                Chat {result.chatId} → cloned as {result.cloneChatId}
              </span>
            )}
          </li>
        ))}
      </ul>
      <DialogFooter>
        <Button type="button" onClick={props.onDone}>
          Done
        </Button>
      </DialogFooter>
    </>
  );
}
