import { SendHorizontal, Wrench } from "lucide-react";
import { useState } from "react";
import { v4 as uuidv4 } from "uuid";
import type { AgentMessageSend } from "@traycer/protocol/persistence/epic/content-blocks";
import type { SegmentEndState } from "@/stores/composer/chat-store";
import { SegmentEndStateBadge } from "./segment-end-state-badge";
import { LivePulse } from "@/components/ui/live-pulse";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useEpicArtifact, useOpenEpicId } from "@/lib/epic-selectors";
import {
  resolveToolInputDetail,
  type ToolInputDetail,
} from "@traycer/protocol/host/agent/gui/tool-input-detail";
import type {
  ArtifactProjection,
  ChatProjection,
  TuiAgentProjection,
} from "@/stores/epics/open-epic/types";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { cn, formatSingleLine } from "@/lib/utils";
import { AgentReferenceMarkdown } from "./agent-reference-markdown";
import { SegmentCard } from "./segment-card";
import { SegmentPanel } from "./segment-panel";
import { SegmentRow } from "./segment-row";
import { ToolInputPanel } from "./tool-input-panel";
import { StreamingActivityFooter } from "./streaming-activity-footer";

interface ToolSegmentProps {
  toolName: string;
  // Precomputed on the host (raw input not persisted): the ≤80-char header
  // line and the optional expand body.
  inputSummary: string | null;
  inputDetail: ToolInputDetail | null;
  error: string | null;
  agentMessageSend: AgentMessageSend | null;
  isStreaming: boolean;
  // Terminal outcome when the turn ended mid-call (else null): drives a neutral
  // "stopped"/"superseded" badge instead of a spinner.
  endState: SegmentEndState;
  // Latest harness progress line for an in-flight call (null when none).
  progress: string | null;
  // Wall-clock start (epoch ms) driving the elapsed heartbeat while streaming.
  startedAt: number;
  variant: "card" | "row";
}

interface ToolBadgeProps {
  readonly hasError: boolean;
  readonly isStreaming: boolean;
  readonly endState: SegmentEndState;
}

type ReceiverNode = ArtifactProjection | ChatProjection | TuiAgentProjection;

interface ReceiverOpenTarget {
  readonly type: "chat" | "terminal-agent";
  readonly hostId: string;
}

function receiverDisplayName(
  receiverNode: ReceiverNode | null,
  receiverAgentId: string,
): string {
  if (receiverNode !== null && receiverNode.title.length > 0) {
    return receiverNode.title;
  }
  return `${receiverAgentId.slice(0, 8)}...`;
}

function receiverOpenTarget(
  receiverNode: ReceiverNode | null,
  fallbackHostId: string | null,
): ReceiverOpenTarget | null {
  if (receiverNode === null) return null;
  if ("harnessId" in receiverNode) {
    return { type: "terminal-agent", hostId: receiverNode.hostId };
  }
  if ("kind" in receiverNode) return null;
  const hostId = receiverNode.hostId ?? fallbackHostId;
  if (hostId === null) return null;
  return { type: "chat", hostId };
}

function ToolBadge({ hasError, isStreaming, endState }: ToolBadgeProps) {
  if (hasError) {
    return (
      <span className="shrink-0 rounded border border-destructive/40 bg-destructive/10 px-1 text-overline font-medium uppercase text-destructive">
        error
      </span>
    );
  }
  if (isStreaming) {
    return (
      <LivePulse
        size="xs"
        tone="active"
        ariaLabel="Tool running"
        className={undefined}
      />
    );
  }
  return <SegmentEndStateBadge endState={endState} />;
}

export function ToolSegment(props: ToolSegmentProps) {
  if (props.agentMessageSend !== null) {
    return <A2ASendToolSegment {...props} send={props.agentMessageSend} />;
  }
  return <GenericToolSegment {...props} />;
}

function GenericToolSegment(props: ToolSegmentProps) {
  const {
    toolName,
    inputSummary,
    inputDetail,
    error,
    isStreaming,
    endState,
    progress,
    startedAt,
  } = props;
  const { variant } = props;
  const hasError = error !== null && error.length > 0;
  const [open, setOpen] = useState<boolean>(false);
  const summary = inputSummary;
  // Heartbeat while the call runs: latest progress line + a ticking elapsed
  // counter, so a long tool/MCP call shows life instead of a frozen row. This
  // renders in the ROW variant (beneath the nested row, on group-expand) - the
  // only path GenericToolSegment is reached on. A top-level tool's "still
  // working" cue is the group-header elapsed (GroupElapsed); its progress shows
  // here when the activity group is expanded.
  const streamingFooter = isStreaming ? (
    <StreamingActivityFooter startedAt={startedAt} progress={progress} />
  ) : null;

  const header = (
    <>
      <Wrench
        className="size-3.5 shrink-0 text-muted-foreground/80"
        aria-hidden
      />
      <span className="shrink-0 font-mono text-code-sm font-medium text-foreground/85">
        {toolName}
      </span>
      {summary !== null ? (
        <>
          <span aria-hidden className="shrink-0 text-muted-foreground/40">
            ·
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-code-sm text-muted-foreground">
            {summary}
          </span>
        </>
      ) : (
        <span aria-hidden className="flex-1" />
      )}
      <ToolBadge
        hasError={hasError}
        isStreaming={isStreaming}
        endState={endState}
      />
    </>
  );

  // Hybrid input rendering: null when the header summary already captures the
  // whole call (segment stays header-only, non-expandable); otherwise a
  // humanized command/fields view - never a raw JSON dump. Operates on the
  // precomputed detail rather than re-deriving from raw input (no longer stored).
  const expandDetail = resolveToolInputDetail(inputDetail, summary);
  const expandable = expandDetail !== null || hasError;

  const body = open ? (
    <div className="flex flex-col gap-2">
      {expandDetail !== null ? <ToolInputPanel detail={expandDetail} /> : null}
      {hasError ? (
        <SegmentPanel
          label="Error"
          copyValue={error}
          tone="destructive"
          bodyChrome="framed"
          className={undefined}
        >
          <pre className="m-0 px-3 py-2 font-mono text-code-sm whitespace-pre-wrap text-destructive">
            {error}
          </pre>
        </SegmentPanel>
      ) : null}
    </div>
  ) : null;

  if (variant === "row") {
    // The streaming footer (progress + elapsed) sits beneath the row via
    // SegmentRow's `footer` slot - visible whether or not the group is expanded.
    return (
      <SegmentRow
        open={open}
        onOpenChange={setOpen}
        header={header}
        body={body}
        tone={hasError ? "destructive" : "default"}
        stickyHeader
        expandable={expandable}
        className={undefined}
        footer={streamingFooter}
      />
    );
  }
  return (
    <SegmentCard
      open={open}
      onOpenChange={setOpen}
      header={header}
      headerAction={null}
      // The card variant is never reached for a streaming generic tool (those
      // group into an activity row); the heartbeat lives in the row branch.
      collapsedPreview={null}
      body={body}
      tone={hasError ? "destructive" : "default"}
      headerPosition="normal"
      bodyOverflow="hidden"
      expandable={expandable}
      className={undefined}
    />
  );
}

function A2ASendToolSegment(
  props: ToolSegmentProps & { readonly send: AgentMessageSend },
) {
  const { error, isStreaming, endState, send, variant } = props;
  const [open, setOpen] = useState<boolean>(false);
  const hasError = error !== null && error.length > 0;
  const receiverNode = useEpicArtifact(send.receiverAgentId);
  const activeHostId = useReactiveActiveHostId();
  const epicId = useOpenEpicId();
  const receiverName = receiverDisplayName(receiverNode, send.receiverAgentId);
  const openTarget = receiverOpenTarget(receiverNode, activeHostId);
  const openReceiverTab = () => {
    if (openTarget === null) return;
    const canvas = useEpicCanvasStore.getState();
    const tabId = canvas.resolveTargetTabForEpic(epicId, undefined);
    canvas.openTileInTab(tabId, {
      id: send.receiverAgentId,
      instanceId: uuidv4(),
      type: openTarget.type,
      name: receiverName,
      hostId: openTarget.hostId,
    });
  };

  const receiver = (
    <span className="min-w-0 flex-1 truncate text-ui-sm">
      <span className="text-muted-foreground">to agent </span>
      <span className="font-medium text-foreground/85">{receiverName}</span>
    </span>
  );

  const header = (
    <>
      <SendHorizontal
        className={cn(
          "size-3.5 shrink-0",
          hasError ? "text-destructive" : "text-primary",
        )}
        aria-hidden
      />
      <span className="shrink-0 text-ui-sm font-medium text-foreground/85">
        Sent message
      </span>
      <span aria-hidden className="shrink-0 text-muted-foreground/40">
        ·
      </span>
      {receiver}
      <ToolBadge
        hasError={hasError}
        isStreaming={isStreaming}
        endState={endState}
      />
    </>
  );

  const preview = <AgentMessagePreview message={send.message} tone="primary" />;
  const body = open ? (
    <div className="flex flex-col gap-2">
      {openTarget !== null ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={openReceiverTab}
            className="w-fit rounded px-1.5 py-0.5 text-ui-sm font-medium text-primary underline-offset-2 transition-colors hover:bg-primary/10 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            Open receiving agent
          </button>
          {send.expectReply ? (
            <>
              <span aria-hidden className="text-muted-foreground/40">
                ·
              </span>
              <span className="shrink-0 rounded border border-primary/30 bg-primary/10 px-1.5 text-overline font-medium uppercase text-primary">
                reply expected
              </span>
            </>
          ) : null}
        </div>
      ) : null}
      <SegmentPanel
        label="Message"
        copyValue={send.message}
        tone="default"
        bodyChrome="framed"
        className={undefined}
      >
        <div className="max-h-[min(40vh,24rem)] overflow-auto px-3 py-2">
          <AgentReferenceMarkdown
            isStreaming={false}
            markdown={send.message}
            proseSize="compact"
          />
        </div>
      </SegmentPanel>
      {hasError ? (
        <SegmentPanel
          label="Error"
          copyValue={error}
          tone="destructive"
          bodyChrome="framed"
          className={undefined}
        >
          <pre className="m-0 px-3 py-2 font-mono text-code-sm whitespace-pre-wrap text-destructive">
            {error}
          </pre>
        </SegmentPanel>
      ) : null}
    </div>
  ) : null;

  if (variant === "row") {
    return (
      <SegmentRow
        open={open}
        onOpenChange={setOpen}
        header={header}
        body={body}
        tone={hasError ? "destructive" : "default"}
        stickyHeader
        expandable
        className={undefined}
        footer={null}
      />
    );
  }
  return (
    <SegmentCard
      open={open}
      onOpenChange={setOpen}
      header={header}
      headerAction={null}
      collapsedPreview={preview}
      body={body}
      tone={hasError ? "destructive" : "primary"}
      headerPosition="normal"
      bodyOverflow="hidden"
      expandable
      className={undefined}
    />
  );
}

function AgentMessagePreview(props: {
  readonly message: string;
  readonly tone: "default" | "primary";
}) {
  const { message, tone } = props;
  const preview = formatSingleLine(message, {
    maxLength: 180,
    ellipsis: "…",
  });
  if (preview.length === 0) return null;
  return (
    <p
      className={cn(
        "m-0 line-clamp-2 text-ui-sm leading-6",
        tone === "primary" ? "text-foreground/85" : "text-muted-foreground",
      )}
    >
      {preview}
    </p>
  );
}
