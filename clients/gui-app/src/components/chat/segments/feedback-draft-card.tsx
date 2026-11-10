import { v4 as uuidv4 } from "uuid";
import { useContext, useId, useState, type ReactNode } from "react";
import { MessageSquareText } from "lucide-react";
import { create, useStore } from "zustand";
import type { ToolCallFeedbackDraftStamp } from "@traycer/protocol/persistence/epic/content-blocks";
import type { ChatFeedbackDraftDecision } from "@traycer/protocol/host/chat/feedback-draft";
import { useChatAttachmentScope } from "@/components/chat/chat-attachment-scope-context";
import { ChatStatusReadOnlyContext } from "@/components/chat/chat-status-capabilities";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  type FeedbackDraftBlockRef,
  useChatFeedbackDraftDecideMutation,
  useChatFeedbackDraftPreviewQuery,
  useChatFeedbackDraftSupported,
} from "@/hooks/chats/use-chat-feedback-draft";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import type { HostRpcRegistry } from "@/lib/host";
import { useExistingChatSessionHandle } from "@/lib/registries/chat-session-registry";
import type { ChatSessionState } from "@/stores/chats/chat-session-store";
import {
  scopedChatOpenId,
  useChatOpenStoreScope,
} from "@/stores/chats/open-store-scope";
import { useToolOpenStore } from "@/stores/chats/tool-open-store";
import { SegmentCard } from "./segment-card";

const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  tool_problem: "Tool problem",
  missing_capability: "Missing capability",
  unmet_user_expectation: "Didn't work as expected",
  suggestion: "Suggestion",
};

/** The category's label; one this build has not heard of reads generically. */
function feedbackDraftCategoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? "Feedback";
}

/**
 * Why this reader cannot send the draft, or `null` when they can. Checked in
 * order: a transcript with no live chat, a reader who may not act on the
 * chat, a host that cannot send.
 */
export type FeedbackDraftReadOnlyReason =
  | "no-chat"
  | "not-allowed"
  | "host-unsupported";

const READ_ONLY_COPY: Record<FeedbackDraftReadOnlyReason, string> = {
  "no-chat": "Open this chat in the desktop app to send it.",
  "not-allowed": "Only someone who can act in this chat can send it.",
  "host-unsupported": "Update Traycer on this computer to send it.",
};

const SETTLED_BADGE: Record<
  Exclude<ToolCallFeedbackDraftStamp["state"], "pending" | "failed">,
  string
> = {
  sent: "Sent",
  skipped: "Skipped",
  unknown: "Reviewed",
};

interface FeedbackDraftCardProps {
  readonly id: string;
  readonly draft: ToolCallFeedbackDraftStamp;
  readonly headerFindUnitId: string | null;
}

/**
 * Feedback an agent drafted about Traycer, on the tool call that drafted it.
 * Nothing is sent until the reader presses Send. A pending (or failed) draft
 * shows its fields and the Send and Skip actions; a settled one collapses to
 * its header and state.
 */
export function FeedbackDraftCard(props: FeedbackDraftCardProps): ReactNode {
  const scope = useChatAttachmentScope();
  const readOnly = useContext(ChatStatusReadOnlyContext);
  if (scope === null || readOnly) {
    return <FeedbackDraftView {...props} live={null} />;
  }
  return (
    <LiveFeedbackDraftCard
      {...props}
      blockRef={{
        epicId: scope.epicId,
        chatId: scope.chatId,
        blockId: props.id,
      }}
      hostId={scope.hostId}
    />
  );
}

type ChatActSlice = Pick<ChatSessionState, "access">;
const noSessionActSlice = create<ChatActSlice>()(() => ({ access: null }));

function LiveFeedbackDraftCard(
  props: FeedbackDraftCardProps & {
    readonly blockRef: FeedbackDraftBlockRef;
    readonly hostId: string;
  },
): ReactNode {
  const { blockRef, hostId } = props;
  const handle = useExistingChatSessionHandle(
    blockRef.epicId,
    blockRef.chatId,
    hostId,
  );
  const canAct = useStore(
    handle === null ? noSessionActSlice : handle.store,
    (state) => (state.access === null ? null : state.access.canAct),
  );
  const supported = useChatFeedbackDraftSupported(hostId);
  const client = useHostClientForHostId(hostId);
  const decide = useChatFeedbackDraftDecideMutation(client, blockRef.blockId);
  const readOnly = liveReadOnlyReason(canAct, supported);
  // The settled stamp also arrives as a row update; until it does, the
  // response is what the card shows.
  const settled = decide.data === undefined ? null : decide.data.feedbackDraft;
  const draft =
    settled !== null && props.draft.state === "pending" ? settled : props.draft;
  return (
    <FeedbackDraftView
      id={props.id}
      draft={draft}
      headerFindUnitId={props.headerFindUnitId}
      live={{
        blockRef,
        client,
        readOnly,
        // Unknown standing (the chat is still connecting) holds the buttons
        // without claiming the reader may not act.
        isPending: decide.isPending || canAct === null,
        decide: (decision, includeDiagnostics) => {
          decide.mutate({
            ...blockRef,
            decision,
            includeDiagnostics,
            clientActionId: newClientActionId(),
          });
        },
      }}
    />
  );
}

/**
 * `crypto.randomUUID` throws outside a secure context (plain http), and
 * `uuid`'s bare `v4()` calls it too; random bytes from `getRandomValues`
 * work in either.
 */
function newClientActionId(): string {
  return uuidv4({ random: crypto.getRandomValues(new Uint8Array(16)) });
}

function liveReadOnlyReason(
  canAct: boolean | null,
  supported: boolean | null,
): FeedbackDraftReadOnlyReason | null {
  if (canAct === false) return "not-allowed";
  if (supported === false) return "host-unsupported";
  return null;
}

interface LiveDraftActions {
  readonly blockRef: FeedbackDraftBlockRef;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly readOnly: FeedbackDraftReadOnlyReason | null;
  readonly isPending: boolean;
  readonly decide: (
    decision: ChatFeedbackDraftDecision,
    includeDiagnostics: boolean,
  ) => void;
}

function FeedbackDraftView(
  props: FeedbackDraftCardProps & { readonly live: LiveDraftActions | null },
): ReactNode {
  const { draft, live } = props;
  const openScope = useChatOpenStoreScope();
  const storedOpen = useToolOpenStore((state) =>
    state.openIds.has(scopedChatOpenId(openScope, props.id)),
  );
  const setToolOpen = useToolOpenStore((state) => state.setOpen);
  const awaiting = draft.state === "pending" || draft.state === "failed";
  const header = (
    <>
      <MessageSquareText
        aria-hidden
        className="size-3.5 shrink-0 text-muted-foreground"
      />
      <span className="truncate">
        Feedback for Traycer · {feedbackDraftCategoryLabel(draft.category)}
        {draft.toolName === null ? null : ` · ${draft.toolName}`}
      </span>
      {draft.state === "pending" || draft.state === "failed" ? null : (
        <Badge variant="muted">{SETTLED_BADGE[draft.state]}</Badge>
      )}
    </>
  );
  return (
    <SegmentCard
      open={awaiting || storedOpen}
      onOpenChange={(next) => setToolOpen(openScope, props.id, next)}
      header={header}
      headerAction={null}
      collapsedPreview={null}
      body={<FeedbackDraftBody draft={draft} live={live} />}
      footer={null}
      tone={awaiting ? "primary" : "default"}
      headerPosition="normal"
      bodyOverflow="hidden"
      // An awaiting draft stays open: its fields and actions are the point.
      expandable
      headerFindUnitId={props.headerFindUnitId}
      bodyFindUnitId={null}
      className={undefined}
    />
  );
}

function FeedbackDraftBody(props: {
  readonly draft: ToolCallFeedbackDraftStamp;
  readonly live: LiveDraftActions | null;
}): ReactNode {
  const { draft, live } = props;
  const awaiting = draft.state === "pending" || draft.state === "failed";
  return (
    <div className="flex flex-col gap-2 px-2.5 py-2">
      {awaiting ? (
        <p className="text-muted-foreground">
          Drafted a note for the Traycer team. It hasn't been sent; you can
          review it below.
        </p>
      ) : null}
      <dl className="flex flex-col gap-1.5">
        <FeedbackDraftField label="Trying to do" value={draft.goal} />
        <FeedbackDraftField label="What happened" value={draft.observed} />
        {draft.suggestion === null ? null : (
          <FeedbackDraftField label="Suggestion" value={draft.suggestion} />
        )}
      </dl>
      {draft.state === "sent" ? (
        <p className="text-muted-foreground">Sent to the Traycer team.</p>
      ) : null}
      {draft.state === "failed" ? (
        <p className="text-destructive">
          Not sent
          {draft.failureReason === null ? "" : `: ${draft.failureReason}`}. You
          can try again.
        </p>
      ) : null}
      {awaiting ? <FeedbackDraftActions draft={draft} live={live} /> : null}
    </div>
  );
}

function FeedbackDraftField(props: {
  readonly label: string;
  readonly value: string;
}): ReactNode {
  return (
    <div className="flex flex-col">
      <dt className="text-ui-xs text-muted-foreground">{props.label}</dt>
      <dd className="break-words whitespace-pre-wrap">{props.value}</dd>
    </div>
  );
}

function FeedbackDraftActions(props: {
  readonly draft: ToolCallFeedbackDraftStamp;
  readonly live: LiveDraftActions | null;
}): ReactNode {
  const { draft, live } = props;
  const [includeDiagnostics, setIncludeDiagnostics] = useState(
    draft.suggestDiagnostics,
  );
  const [viewing, setViewing] = useState(false);
  const checkboxId = useId();
  const sessionReadOnly = useContext(ChatStatusReadOnlyContext);
  const readOnly: FeedbackDraftReadOnlyReason | null =
    live === null ? "no-chat" : live.readOnly;
  if (live === null || readOnly !== null) {
    return (
      <p className="text-muted-foreground">
        {sessionReadOnly
          ? "This session is read-only."
          : READ_ONLY_COPY[readOnly ?? "no-chat"]}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-2">
        <Checkbox
          id={checkboxId}
          checked={includeDiagnostics}
          onCheckedChange={(next) => setIncludeDiagnostics(next === true)}
          disabled={live.isPending}
        />
        <div className="flex min-w-0 flex-col">
          <Label htmlFor={checkboxId}>Include diagnostic data</Label>
          <span className="text-ui-xs text-muted-foreground">
            {draft.suggestDiagnostics
              ? "The agent suggested this. You can untick it."
              : "Logs from this machine and app and host details, as in Report an issue."}{" "}
            <Button
              variant="link"
              size="inline-xs"
              onClick={() => setViewing(true)}
            >
              View
            </Button>
          </span>
        </div>
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={live.isPending}
          onClick={() => live.decide("send", includeDiagnostics)}
        >
          Send
          {live.isPending ? (
            <AgentSpinningDots
              className="size-3"
              testId={undefined}
              variant={undefined}
            />
          ) : null}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={live.isPending}
          onClick={() => live.decide("skip", false)}
        >
          Skip
        </Button>
      </div>
      <FeedbackDraftPreviewDialog
        open={viewing}
        onOpenChange={setViewing}
        live={live}
      />
    </div>
  );
}

function FeedbackDraftPreviewDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (next: boolean) => void;
  readonly live: LiveDraftActions;
}): ReactNode {
  const { open, live } = props;
  const preview = useChatFeedbackDraftPreviewQuery(
    live.client,
    live.blockRef,
    open,
  );
  const data = preview.data?.kind === "preview" ? preview.data : null;
  return (
    <Dialog open={open} onOpenChange={props.onOpenChange}>
      <DialogContent layout="banded">
        <DialogHeader>
          <DialogTitle>Diagnostic data</DialogTitle>
          <DialogDescription>
            What Send attaches when the box is ticked.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-2 px-5 py-4">
          {preview.isPending ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
          ) : null}
          {!preview.isPending && data === null ? (
            <p className="text-muted-foreground">
              The diagnostic data could not be read.
            </p>
          ) : null}
          {data === null ? null : (
            <div className="flex min-h-0 flex-col gap-2 overflow-auto">
              <dl className="flex flex-col gap-1">
                {data.details.map((detail) => (
                  <FeedbackDraftField
                    key={detail.label}
                    label={detail.label}
                    value={detail.value}
                  />
                ))}
              </dl>
              <pre className="max-h-80 overflow-auto font-mono text-ui-xs whitespace-pre-wrap">
                {data.logTail}
              </pre>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
