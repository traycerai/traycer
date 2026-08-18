import { SendHorizontal, Wrench } from "lucide-react";
import { useCallback, useMemo } from "react";
import type { ReactNode } from "react";
import { v4 as uuidv4 } from "uuid";
import type {
  AgentMessageSend,
  BackgroundTaskOutput,
  ImageGenerationResult,
  ToolCallManagedCommand,
} from "@traycer/protocol/persistence/epic/content-blocks";
import type { SegmentEndState } from "@/stores/composer/chat-store";
import { deriveA2ASendCollapsibleKey } from "@/components/chat/chat-collapsible-key";
import { chatFindA2ASendBodyUnitId } from "@/components/chat/chat-find";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { SegmentEndStateBadge } from "./segment-end-state-badge";
import { LivePulse } from "@/components/ui/live-pulse";
import { useEpicAgentReference, useOpenEpicId } from "@/lib/epic-selectors";
import {
  resolveToolInputDetail,
  type ToolInputDetail,
} from "@traycer/protocol/host/agent/gui/tool-input-detail";
import type {
  ChatProjection,
  TuiAgentProjection,
} from "@/stores/epics/open-epic/types";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { cn, formatSingleLine } from "@/lib/utils";
import { AgentHeaderLink } from "./agent-header-link";
import { AgentMessageBody } from "./agent-message-body";
import { ReplyExpectedBadge } from "./reply-expected-badge";
import { SegmentCard } from "./segment-card";
import { SegmentPanel } from "./segment-panel";
import { SegmentRow } from "./segment-row";
import { ToolInputPanel } from "./tool-input-panel";
import { StreamingActivityFooter } from "./streaming-activity-footer";
import {
  useA2ASendOpen,
  useSetA2ASendOpen,
} from "@/stores/chats/a2a-open-store-context";
import {
  useChatCollapsibleTileInstanceId,
  useChatFindForcedOpen,
  useSetChatFindForcedOpen,
} from "@/stores/chats/chat-find-force-store-context";
import { useToolOpenStore } from "@/stores/chats/tool-open-store";
import {
  scopedChatOpenId,
  useChatOpenStoreScope,
} from "@/stores/chats/open-store-scope";
import { ElapsedTime } from "./segment-elapsed";
import { ImageGenerationCard } from "./image-generation-card";
import { ManagedCommandRestartSegment } from "./managed-command-restart-segment";
import { ManagedCommandStartSegment } from "./managed-command-start-segment";

interface ToolSegmentProps {
  id: string;
  toolName: string;
  // The shell a `traycer_run_shell` call created, stamped on the block at
  // completion. Non-null routes this call to the shell start card.
  managedCommand: ToolCallManagedCommand | null;
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
  // True when `status === "errored"` was an explicit stop (deadline-killed
  // Monitor, user-stopped command) rather than a genuine failure. Authoritative
  // signal from the host; `isStoppedToolError` below still sniffs the legacy
  // `"stopped: ..."` error-string convention as a fallback for blocks persisted
  // before this field existed.
  stopped: boolean;
  // Latest harness progress line for an in-flight call (null when none).
  progress: string | null;
  backgroundOutput: BackgroundTaskOutput | null;
  backgroundTask: boolean | null;
  // Wall-clock start (epoch ms) driving the elapsed heartbeat while streaming.
  startedAt: number;
  durationMs: number | null;
  imageResults: ReadonlyArray<ImageGenerationResult>;
  variant: "card" | "row";
  headerFindUnitId: string | null;
}

interface ToolBadgeProps {
  readonly state: ToolBadgeState;
  readonly endState: SegmentEndState;
}

interface GenericToolHeaderProps {
  readonly toolName: string;
  readonly summary: string | null;
  readonly progress: string | null;
  readonly badgeState: ToolBadgeState;
  readonly endState: SegmentEndState;
  readonly elapsed: ToolHeaderElapsed;
  readonly layout: ToolHeaderLayout;
}

interface ToolSegmentBodyProps {
  readonly expandDetail: ToolInputDetail | null;
  readonly error: string | null;
  readonly hasError: boolean;
  readonly backgroundOutput: BackgroundTaskOutput | null;
  readonly toolName: string;
}

type ReceiverNode = ChatProjection | TuiAgentProjection;

interface ReceiverOpenTarget {
  readonly type: "chat" | "terminal-agent";
  readonly hostId: string;
}

type ToolBadgeState =
  "background-complete" | "end-state" | "error" | "stopped" | "streaming";

type ToolHeaderLayout = "inline" | "stacked";

type ToolHeaderElapsed =
  | { readonly kind: "hidden" }
  | { readonly kind: "live"; readonly startedAt: number }
  | { readonly kind: "static"; readonly durationMs: number };

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
  const hostId = receiverNode.hostId ?? fallbackHostId;
  if (hostId === null) return null;
  return { type: "chat", hostId };
}

function ToolBadge({ state, endState }: ToolBadgeProps) {
  if (state === "error") {
    return (
      <span className="shrink-0 rounded border border-destructive/40 bg-destructive/10 px-1 text-overline font-medium uppercase text-destructive">
        error
      </span>
    );
  }
  if (state === "streaming") {
    return (
      <LivePulse
        size="xs"
        tone="active"
        ariaLabel="Tool running"
        className={undefined}
      />
    );
  }
  if (state === "stopped") {
    return <SegmentEndStateBadge endState={null} stopped />;
  }
  if (state === "background-complete") {
    return <ToolStateBadge label="completed" />;
  }
  return <SegmentEndStateBadge endState={endState} stopped={false} />;
}

function ToolStateBadge({ label }: { readonly label: string }) {
  return (
    <span className="shrink-0 rounded border border-border bg-muted px-1 text-overline font-medium uppercase text-muted-foreground">
      {label}
    </span>
  );
}

// Authoritative `stopped` field takes precedence; the legacy `"stopped: ..."`
// error-string prefix is a fallback for blocks persisted before the field
// existed (it parses as `stopped: false` via the schema default).
function isStoppedToolError(stopped: boolean, error: string | null): boolean {
  if (stopped) return true;
  return error !== null && error.toLowerCase().startsWith("stopped:");
}

function toolCardTone(
  hasError: boolean,
  isStreaming: boolean,
): "default" | "destructive" | "primary" {
  if (hasError) return "destructive";
  if (isStreaming) return "primary";
  return "default";
}

function hasBackgroundOutput(output: BackgroundTaskOutput | null): boolean {
  if (output === null) return false;
  if (output.stdout.length > 0) return true;
  if (output.stderr.length > 0) return true;
  return output.truncated;
}

function resolveToolBadgeState(props: {
  readonly hasError: boolean;
  readonly isBackgroundComplete: boolean;
  readonly isStreaming: boolean;
  readonly isStopped: boolean;
}): ToolBadgeState {
  if (props.hasError) return "error";
  if (props.isStreaming) return "streaming";
  if (props.isStopped) return "stopped";
  if (props.isBackgroundComplete) return "background-complete";
  return "end-state";
}

function resolveToolHeaderElapsed(props: {
  readonly durationMs: number | null;
  readonly isStreaming: boolean;
  readonly startedAt: number;
  readonly variant: ToolSegmentProps["variant"];
}): ToolHeaderElapsed {
  // A RUNNING row shows its elapsed inline, like the card always has. It used
  // to be pushed into the streaming footer, which put the number on a second
  // line under the header and read as a separate entry in the group.
  if (props.isStreaming) {
    return { kind: "live", startedAt: props.startedAt };
  }
  // A SETTLED row shows no total - unchanged, not newly dropped: the elapsed
  // only ever appeared while streaming, because it lived in the streaming
  // footer. Note the group header above does NOT make up for it; its summary
  // counts commands and files and carries a duration only for thinking. This is
  // a deliberate density call for a list of finished rows, not a deferral.
  if (props.variant !== "card") return { kind: "hidden" };
  if (props.durationMs !== null) {
    return { kind: "static", durationMs: props.durationMs };
  }
  return { kind: "hidden" };
}

function renderToolStreamingFooter(props: {
  readonly isStreaming: boolean;
  readonly progress: string | null;
  readonly stackedHeader: boolean;
}): ReactNode {
  if (!props.isStreaming || props.stackedHeader) return null;
  // Nothing to say, no second line. The footer carries only the progress line
  // now that the elapsed counter lives in the header, so a tool that reports no
  // progress (every command, and most tools) renders no footer at all.
  const { progress } = props;
  if (progress === null || progress.length === 0) return null;
  return <StreamingActivityFooter progress={progress} />;
}

export function ToolSegment(props: ToolSegmentProps) {
  if (props.toolName === "image_generation" && props.variant === "card") {
    return (
      <ImageGenerationCard
        id={props.id}
        inputSummary={props.inputSummary}
        inputDetail={props.inputDetail}
        error={props.error}
        isStreaming={props.isStreaming}
        endState={props.endState}
        stopped={props.stopped}
        imageResults={props.imageResults}
      />
    );
  }
  if (props.agentMessageSend !== null) {
    return <A2ASendToolSegment {...props} send={props.agentMessageSend} />;
  }
  // A shell is not a tool call that finished - it is an object that outlives
  // the turn - so the call site renders it as one, live status and all. Keyed
  // off the stamped payload rather than the tool name: the name alone would
  // also match a call from a host too old to correlate, which has no shell to
  // point at and belongs in the generic row. A restart is the other kind of
  // stamped call: not the shell's live card but the immutable record of one
  // relaunch, at the place in the transcript where it happened.
  if (props.managedCommand !== null) {
    if (props.managedCommand.event === "restarted") {
      return (
        <ManagedCommandRestartSegment
          id={props.id}
          restart={props.managedCommand}
          variant={props.variant}
          headerFindUnitId={props.headerFindUnitId}
        />
      );
    }
    return (
      <ManagedCommandStartSegment
        id={props.id}
        managedCommand={props.managedCommand}
        command={runShellCommand(props.inputDetail)}
        variant={props.variant}
        headerFindUnitId={props.headerFindUnitId}
      />
    );
  }
  return <GenericToolSegment {...props} />;
}

/**
 * The command a `traycer_run_shell` call asked for, off the block's own input.
 * `deriveToolInputDetail` short-circuits on the `command` field for this tool,
 * so the detail is always the `command` kind when the input was captured at
 * all - anything else is a block from before that, and has no command to show.
 */
function runShellCommand(detail: ToolInputDetail | null): string | null {
  if (detail === null || detail.kind !== "command") return null;
  return detail.command;
}

function GenericToolSegment(props: ToolSegmentProps) {
  const {
    toolName,
    inputSummary,
    inputDetail,
    error,
    isStreaming,
    endState,
    stopped,
    progress,
    backgroundOutput,
    backgroundTask,
    startedAt,
    durationMs,
    id,
  } = props;
  const { variant } = props;
  const isStopped = isStoppedToolError(stopped, error);
  const hasError = error !== null && error.length > 0 && !isStopped;
  const isBackgroundComplete =
    (backgroundTask || backgroundOutput !== null) &&
    !isStreaming &&
    !hasError &&
    !isStopped;
  const badgeState = resolveToolBadgeState({
    hasError,
    isBackgroundComplete,
    isStreaming,
    isStopped,
  });
  const openScope = useChatOpenStoreScope();
  const open = useToolOpenStore((state) =>
    state.openIds.has(scopedChatOpenId(openScope, id)),
  );
  const setToolOpen = useToolOpenStore((state) => state.setOpen);
  const setOpen = (next: boolean): void => setToolOpen(openScope, id, next);
  const summary = inputSummary;
  const stackedHeader = variant === "card" && isStreaming;
  const headerLayout: ToolHeaderLayout = stackedHeader ? "stacked" : "inline";
  const headerElapsed = resolveToolHeaderElapsed({
    durationMs,
    isStreaming,
    startedAt,
    variant,
  });
  const streamingFooter = renderToolStreamingFooter({
    isStreaming,
    progress,
    stackedHeader,
  });

  const header = (
    <GenericToolHeader
      toolName={toolName}
      summary={summary}
      progress={progress}
      badgeState={badgeState}
      endState={endState}
      elapsed={headerElapsed}
      layout={headerLayout}
    />
  );

  // Hybrid input rendering: null when the header summary already captures the
  // whole call (segment stays header-only, non-expandable); otherwise a
  // humanized command/fields view - never a raw JSON dump. Operates on the
  // precomputed detail rather than re-deriving from raw input (no longer stored).
  const expandDetail = resolveToolInputDetail(inputDetail, summary);
  const expandable =
    expandDetail !== null || hasError || hasBackgroundOutput(backgroundOutput);

  const body = open ? (
    <ToolSegmentBody
      expandDetail={expandDetail}
      error={isStopped ? null : error}
      hasError={hasError}
      backgroundOutput={backgroundOutput}
      toolName={toolName}
    />
  ) : null;

  if (variant === "row") {
    // The streaming footer is the progress LINE only - the elapsed counter went
    // to the header row. It sits beneath the row via SegmentRow's `footer` slot,
    // visible whether or not the group is expanded, and is absent entirely when
    // the tool reports no progress.
    return (
      <SegmentRow
        headerAction={null}
        open={open}
        onOpenChange={setOpen}
        header={header}
        body={body}
        tone={hasError ? "destructive" : "default"}
        stickyHeader
        expandable={expandable}
        headerFindUnitId={props.headerFindUnitId}
        bodyFindUnitId={null}
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
      collapsedPreview={null}
      body={body}
      tone={toolCardTone(hasError, isStreaming)}
      headerPosition="normal"
      bodyOverflow="hidden"
      expandable={expandable}
      headerFindUnitId={props.headerFindUnitId}
      bodyFindUnitId={null}
      className={undefined}
    />
  );
}

function GenericToolHeader(props: GenericToolHeaderProps) {
  const status = (
    <span className="ml-auto flex shrink-0 items-center gap-1.5">
      <ToolHeaderElapsedLabel elapsed={props.elapsed} />
      <ToolBadge state={props.badgeState} endState={props.endState} />
    </span>
  );

  if (props.layout === "stacked") {
    const runningLine = runningToolLine(props.summary, props.progress);
    return (
      <>
        <Wrench
          className="mt-[0.2rem] size-3.5 shrink-0 text-muted-foreground/80"
          aria-hidden
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5 self-stretch">
          <span className="flex w-full min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate font-mono text-code-sm font-medium text-foreground/85">
              {props.toolName}
            </span>
            {status}
          </span>
          <span className="flex w-full min-w-0 items-start gap-1.5 pl-2 text-muted-foreground">
            <span
              aria-hidden
              className="mt-[0.2rem] h-2.5 w-3 shrink-0 rounded-bl-sm border-b border-l border-muted-foreground/35"
            />
            <span className="min-w-0 flex-1 truncate font-mono text-code-sm">
              {runningLine}
            </span>
          </span>
        </span>
      </>
    );
  }

  return (
    <>
      <Wrench
        className="size-3.5 shrink-0 text-muted-foreground/80"
        aria-hidden
      />
      <span className="shrink-0 font-mono text-code-sm font-medium text-foreground/85">
        {props.toolName}
      </span>
      {props.summary !== null ? (
        <>
          <span aria-hidden className="shrink-0 text-muted-foreground/40">
            ·
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-code-sm text-muted-foreground">
            {props.summary}
          </span>
        </>
      ) : (
        <span aria-hidden className="flex-1" />
      )}
      {status}
    </>
  );
}

// `data-find-skip`: the counter now sits INSIDE the row's find anchor, and it is
// ephemeral chrome the projection never indexes. Without the skip a find query
// on the digits would paint a highlight inside an anchor that counted no match,
// so paint and count would disagree.
function ToolHeaderElapsedLabel(props: {
  readonly elapsed: ToolHeaderElapsed;
}) {
  if (props.elapsed.kind === "live") {
    return (
      <span data-find-skip className="contents">
        <ElapsedTime
          startedAt={props.elapsed.startedAt}
          durationMs={null}
          isStreaming
        />
      </span>
    );
  }
  if (props.elapsed.kind === "static") {
    return (
      <span data-find-skip className="contents">
        <ElapsedTime
          startedAt={null}
          durationMs={props.elapsed.durationMs}
          isStreaming={false}
        />
      </span>
    );
  }
  return null;
}

function runningToolLine(
  summary: string | null,
  progress: string | null,
): string {
  if (progress !== null && progress.trim().length > 0) return progress;
  if (summary !== null && summary.trim().length > 0) {
    return `Running ${summary}`;
  }
  return "Running";
}

function ToolSegmentBody(props: ToolSegmentBodyProps) {
  const isMcpTool = props.toolName.startsWith("mcp__");
  const backgroundStdout = props.backgroundOutput?.stdout ?? "";
  const backgroundStderr = props.backgroundOutput?.stderr ?? "";
  return (
    <div className="flex flex-col gap-2">
      {props.expandDetail !== null ? (
        <ToolInputPanel detail={props.expandDetail} />
      ) : null}
      <BackgroundOutputPanels
        stdout={
          isMcpTool
            ? mcpResultDisplayContent(backgroundStdout)
            : backgroundStdout
        }
        stdoutLabel={isMcpTool ? "Result" : "Output"}
        stderr={backgroundStderr}
        truncated={props.backgroundOutput?.truncated === true}
      />
      {props.hasError ? (
        <SegmentPanel
          label="Error"
          copyValue={props.error}
          tone="destructive"
          bodyChrome="framed"
          className={undefined}
        >
          <pre className="m-0 px-3 py-2 font-mono text-code-sm whitespace-pre-wrap text-destructive">
            {props.error}
          </pre>
        </SegmentPanel>
      ) : null}
    </div>
  );
}

// A backgrounded MCP call's captured output is the tool's result payload, not
// shell output. When the tail parses as a JSON object/array, re-indent it so
// the panel shows structure instead of a single wrapped line; anything else
// (plain text, or a tail truncated mid-document) renders verbatim.
function mcpResultDisplayContent(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return stdout;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null) return stdout;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return stdout;
  }
}

function BackgroundOutputPanels(props: {
  readonly stdout: string;
  readonly stdoutLabel: string;
  readonly stderr: string;
  readonly truncated: boolean;
}) {
  return (
    <>
      {props.stdout.length > 0 ? (
        <SegmentPanel
          label={props.stdoutLabel}
          copyValue={props.stdout}
          tone="default"
          bodyChrome="framed"
          className={undefined}
        >
          <pre className="m-0 px-3 py-2 font-mono text-code-sm whitespace-pre-wrap text-foreground/90">
            {props.stdout}
          </pre>
        </SegmentPanel>
      ) : null}
      {props.stderr.length > 0 ? (
        <SegmentPanel
          label="Error output"
          copyValue={props.stderr}
          tone="destructive"
          bodyChrome="framed"
          className={undefined}
        >
          <pre className="m-0 px-3 py-2 font-mono text-code-sm whitespace-pre-wrap text-destructive">
            {props.stderr}
          </pre>
        </SegmentPanel>
      ) : null}
      {props.truncated ? (
        <div className="px-1 text-ui-xs text-muted-foreground">
          Output truncated
        </div>
      ) : null}
    </>
  );
}

function A2ASendToolSegment(
  props: ToolSegmentProps & { readonly send: AgentMessageSend },
) {
  const { id, error, isStreaming, endState, send, variant } = props;
  const bodyFindUnitId = chatFindA2ASendBodyUnitId(id);
  const tileInstanceId = useChatCollapsibleTileInstanceId();
  const collapsibleKey = useMemo(
    () => deriveA2ASendCollapsibleKey(tileInstanceId, id),
    [id, tileInstanceId],
  );
  const userOpen = useA2ASendOpen(id);
  const findForcedOpen = useChatFindForcedOpen(collapsibleKey);
  const open = userOpen || findForcedOpen;
  const setOpen = useSetA2ASendOpen();
  const setFindForcedOpen = useSetChatFindForcedOpen();
  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(id, next);
      if (!next) setFindForcedOpen(collapsibleKey, false);
    },
    [collapsibleKey, id, setFindForcedOpen, setOpen],
  );
  const hasError = error !== null && error.length > 0;
  const badgeState = resolveToolBadgeState({
    hasError,
    isBackgroundComplete: false,
    isStreaming,
    isStopped: false,
  });
  const receiverNode = useEpicAgentReference(send.receiverAgentId);
  const activeHostId = useTabHostId();
  const epicId = useOpenEpicId();
  const tileNavigation = useEpicTileNavigation();
  const receiverName = receiverDisplayName(receiverNode, send.receiverAgentId);
  const openTarget = receiverOpenTarget(receiverNode, activeHostId);
  const openReceiverTab = () => {
    if (openTarget === null || receiverNode === null) return;
    tileNavigation.openTileInEpic(epicId, {
      id: receiverNode.id,
      instanceId: uuidv4(),
      type: openTarget.type,
      name: receiverName,
      hostId: openTarget.hostId,
    });
  };

  const receiver = (
    <span className="flex min-w-0 flex-1 items-center gap-1.5 text-ui-sm">
      <span className="min-w-0 truncate">
        <span className="text-muted-foreground">to agent </span>
        <AgentHeaderLink
          name={receiverName}
          onOpen={openTarget !== null ? openReceiverTab : null}
        />
      </span>
      {send.expectReply ? <ReplyExpectedBadge /> : null}
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
      <ToolBadge state={badgeState} endState={endState} />
    </>
  );

  const preview = <AgentMessagePreview message={send.message} tone="primary" />;
  const body = open ? (
    <div className="flex flex-col gap-2">
      <AgentMessageBody
        value={send.message}
        bodyFindUnitId={bodyFindUnitId}
        isStreaming={isStreaming}
      />
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
        headerAction={null}
        open={open}
        onOpenChange={handleOpenChange}
        header={header}
        body={body}
        tone={hasError ? "destructive" : "default"}
        stickyHeader
        expandable
        headerFindUnitId={null}
        bodyFindUnitId={null}
        className={undefined}
        footer={null}
      />
    );
  }
  return (
    <SegmentCard
      open={open}
      onOpenChange={handleOpenChange}
      header={header}
      headerAction={null}
      collapsedPreview={preview}
      body={body}
      tone={hasError ? "destructive" : "primary"}
      headerPosition="normal"
      bodyOverflow="hidden"
      expandable
      headerFindUnitId={null}
      bodyFindUnitId={null}
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
