import { ChevronDown, Workflow as WorkflowIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useChatMeasuredOpenChange } from "@/components/chat/chat-measured-item-change-context";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { LivePulse } from "@/components/ui/live-pulse";
import { formatClockDuration } from "@/lib/format-duration";
import { cn } from "@/lib/utils";
import {
  scopedChatOpenId,
  useChatOpenStoreScope,
} from "@/stores/chats/open-store-scope";
import { useSubagentOpenStore } from "@/stores/chats/subagent-open-store";
import {
  deriveSubagentCollapsibleKey,
  type ChatCollapsibleKey,
} from "@/components/chat/chat-collapsible-key";
import {
  chatFindSegmentUnitId,
  chatFindSubagentBodyUnitId,
  chatFindSubagentHeaderUnitId,
} from "@/components/chat/chat-find";
import {
  useChatCollapsibleTileInstanceId,
  useChatFindForcedOpen,
  useSetChatFindForcedOpen,
} from "@/stores/chats/chat-find-force-store-context";
import type {
  WorkflowActivityEntry,
  WorkflowMeta,
} from "@traycer/protocol/persistence/epic/content-blocks";
import {
  adjacentDedupedProgressItems,
  cleanSubagentNotificationText,
  type ProgressUpdateItem,
} from "./subagent-display";
import { AgentReferenceMarkdown } from "./agent-reference-markdown";
import { ProviderNoticeSegment } from "./provider-notice-segment";
import { SubagentAvatar } from "./subagent-avatar";
import { ElapsedTime } from "./segment-elapsed";
import { SegmentCard } from "./segment-card";
import { SegmentPanel } from "./segment-panel";
import { SegmentRow } from "./segment-row";
import { SegmentEndStateBadge } from "./segment-end-state-badge";
import type {
  SegmentEndState,
  SubagentChildSegment,
} from "@/stores/composer/chat-store";

interface SubagentSegmentProps {
  id: string;
  name: string | null;
  agentType: string | null;
  task: string | null;
  progressUpdates: ReadonlyArray<string>;
  result: string | null;
  isStreaming: boolean;
  // Terminal outcome when the turn ended mid-run (else null): drives a neutral
  // "stopped"/"superseded" badge instead of a spinner.
  endState: SegmentEndState;
  // True when `status === "errored"` was an explicit stop rather than a
  // genuine failure - mirrors ToolSegment.stopped. Drives the same neutral
  // "stopped" badge in place of any destructive error treatment.
  stopped: boolean;
  // Immutable spawn time for the live elapsed heartbeat (null when unknown).
  startedAt: number | null;
  // Total run duration once finished; null while streaming / when unknown.
  durationMs: number | null;
  // Rich fleet data when this card is a workflow run's dual-written card
  // (§2.2) - null for an ordinary agent. Drives the dedicated workflow
  // rendering (header live line, Intent, Activity timeline, Result totals)
  // instead of the plain agent layout.
  workflowMeta: WorkflowMeta | null;
  // This agent's own nested children (tool calls, file changes, commands, AND
  // further nested agents), keyed by `parentId`. Only the `subagent`-kind
  // entries render, as the "Sub-agents" section - recursion is bounded only
  // by actual spawn depth.
  nested: ReadonlyArray<SubagentChildSegment>;
  variant: "card" | "row" | "promoted";
}

type CompactSubagentSegmentProps = Omit<
  SubagentSegmentProps,
  "variant" | "workflowMeta"
> & {
  variant: "card" | "row";
};

export function SubagentSegment(props: SubagentSegmentProps) {
  // Both child variants take the same props minus `variant`; spread the rest so
  // a new card field only needs adding to the interface, not to two hand-kept
  // forwarding lists.
  const { variant, workflowMeta, ...rest } = props;
  if (workflowMeta !== null) {
    return (
      <WorkflowCardSegment
        {...rest}
        workflowMeta={workflowMeta}
        variant={variant === "row" ? "row" : "card"}
      />
    );
  }
  if (variant === "promoted") {
    return <PromotedSubagentSegment {...rest} />;
  }
  return <CompactSubagentSegment {...rest} variant={variant} />;
}

function CompactSubagentSegment(props: CompactSubagentSegmentProps) {
  const {
    id,
    name,
    agentType,
    task,
    progressUpdates,
    result,
    isStreaming,
    endState,
    stopped,
    startedAt,
    durationMs,
    nested,
    variant,
  } = props;
  const collapsibleKey = useSubagentCollapsibleKey(id);
  const headerFindUnitId = chatFindSubagentHeaderUnitId(id);
  const bodyFindUnitId = chatFindSubagentBodyUnitId(id);
  const openScope = useChatOpenStoreScope();
  const userOpen = useSubagentOpenStore((s) =>
    s.openIds.has(scopedChatOpenId(openScope, id)),
  );
  const findForcedOpen = useChatFindForcedOpen(collapsibleKey);
  const open = userOpen || findForcedOpen;
  const setOpen = useSubagentOpenStore((s) => s.setOpen);
  const setFindForcedOpen = useSetChatFindForcedOpen();
  const handleOpenChange = useCallback(
    (newOpen: boolean) => {
      setOpen(openScope, id, newOpen);
      if (!newOpen) setFindForcedOpen(collapsibleKey, false);
    },
    [collapsibleKey, id, openScope, setFindForcedOpen, setOpen],
  );
  const displayProgressUpdates =
    useAdjacentDedupedProgressItems(progressUpdates);

  const displayTask = cleanSubagentNotificationText(task);
  const displayName = cleanSubagentNotificationText(name) ?? "Subagent";
  const displayAgentType = cleanSubagentNotificationText(agentType);
  const lastProgress = displayProgressUpdates.at(-1)?.text ?? null;
  // Collapsed line shows what's happening now (live progress) or the result -
  // never the task. Task + full progress live in the expanded body.
  const summary = result ?? lastProgress ?? (isStreaming ? "Starting…" : null);

  const header = (
    <>
      <SubagentAvatar
        seed={id}
        active={isStreaming}
        size={16}
        className={null}
      />
      <span className="shrink-0 font-mono text-code-sm font-medium text-foreground/85">
        {displayName}
      </span>
      {displayAgentType !== null ? (
        <Badge variant="secondary" className="shrink-0 capitalize">
          {displayAgentType}
        </Badge>
      ) : null}
      {summary !== null ? (
        <>
          <span aria-hidden className="shrink-0 text-muted-foreground/40">
            ·
          </span>
          <span
            data-find-skip
            className="min-w-0 flex-1 truncate text-ui-sm text-muted-foreground"
          >
            {summary}
          </span>
        </>
      ) : (
        <span aria-hidden className="flex-1" />
      )}
      <span data-find-skip className="contents">
        <ElapsedTime
          startedAt={startedAt}
          durationMs={durationMs}
          isStreaming={isStreaming}
        />
        <SegmentEndStateBadge endState={endState} stopped={stopped} />
      </span>
    </>
  );

  const body = (
    <div className="flex flex-col gap-2 text-ui-sm">
      {displayTask !== null ? (
        <div className="flex flex-col gap-1">
          <span
            data-find-skip
            className="select-none font-medium uppercase text-overline text-muted-foreground/80"
          >
            Task
          </span>
          <p className="m-0 whitespace-pre-wrap text-foreground/85">
            {displayTask}
          </p>
        </div>
      ) : null}
      {displayProgressUpdates.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span
            data-find-skip
            className="select-none font-medium uppercase text-overline text-muted-foreground/80"
          >
            Progress
          </span>
          <ul className="m-0 flex list-none flex-col gap-1 pl-0">
            {displayProgressUpdates.map((update) => (
              <li
                key={update.key}
                className="relative pl-4 text-foreground/80 before:absolute before:left-1 before:top-[0.55em] before:size-1 before:rounded-full before:bg-muted-foreground/60"
              >
                {update.text}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <SubagentChildProviderNotices nested={nested} />
      <SubagentChildrenSection nested={nested} />
      {result !== null ? (
        <SubagentResultPanel result={result} isStreaming={isStreaming} />
      ) : null}
    </div>
  );

  if (variant === "row") {
    return (
      <SegmentRow
        open={open}
        onOpenChange={handleOpenChange}
        header={header}
        body={body}
        tone="default"
        stickyHeader
        expandable
        headerFindUnitId={headerFindUnitId}
        bodyFindUnitId={bodyFindUnitId}
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
      collapsedPreview={null}
      body={body}
      tone="default"
      headerPosition="normal"
      bodyOverflow="hidden"
      expandable
      headerFindUnitId={headerFindUnitId}
      bodyFindUnitId={bodyFindUnitId}
      className={undefined}
    />
  );
}

function PromotedSubagentSegment(
  props: Omit<SubagentSegmentProps, "variant" | "workflowMeta">,
) {
  const {
    id,
    name,
    agentType,
    task,
    progressUpdates,
    result,
    isStreaming,
    endState,
    stopped,
    startedAt,
    durationMs,
    nested,
  } = props;
  const collapsibleKey = useSubagentCollapsibleKey(id);
  const headerFindUnitId = chatFindSubagentHeaderUnitId(id);
  const bodyFindUnitId = chatFindSubagentBodyUnitId(id);
  const openScope = useChatOpenStoreScope();
  const userOpen = useSubagentOpenStore((s) =>
    s.openIds.has(scopedChatOpenId(openScope, id)),
  );
  const findForcedOpen = useChatFindForcedOpen(collapsibleKey);
  const open = userOpen || findForcedOpen;
  const setOpen = useSubagentOpenStore((s) => s.setOpen);
  const setFindForcedOpen = useSetChatFindForcedOpen();
  const updateOpen = useCallback(
    (newOpen: boolean) => {
      setOpen(openScope, id, newOpen);
      if (!newOpen) setFindForcedOpen(collapsibleKey, false);
    },
    [collapsibleKey, id, openScope, setFindForcedOpen, setOpen],
  );
  const handleOpenChange = useChatMeasuredOpenChange(updateOpen);
  const displayName = cleanSubagentNotificationText(name) ?? "Subagent";
  const displayAgentType = cleanSubagentNotificationText(agentType);
  const displayTask = cleanSubagentNotificationText(task);
  const dedupedProgress = useAdjacentDedupedProgressItems(progressUpdates);
  const lastProgress = dedupedProgress.at(-1)?.text ?? null;
  // Collapsed line shows live progress only. Finished cards omit it because
  // the final result is visible in the expanded body and duplicates the title.
  const headerSummary = lastProgress ?? "Starting…";
  const showHeaderSummary = isStreaming;

  return (
    <Collapsible
      open={open}
      onOpenChange={handleOpenChange}
      className={cn(
        "rounded-md border text-ui-sm transition-colors",
        open ? "overflow-visible" : "overflow-hidden",
        isStreaming
          ? "border-primary/35 bg-primary/5"
          : "border-border/45 bg-muted/20",
      )}
    >
      <PromotedSubagentTrigger
        id={id}
        headerFindUnitId={headerFindUnitId}
        displayName={displayName}
        displayAgentType={displayAgentType}
        headerSummary={headerSummary}
        showHeaderSummary={showHeaderSummary}
        isStreaming={isStreaming}
        endState={endState}
        stopped={stopped}
        startedAt={startedAt}
        durationMs={durationMs}
        open={open}
      />
      <CollapsibleContent className="overflow-hidden">
        <div
          data-chat-find-unit={bodyFindUnitId}
          className={cn(
            "px-3 py-2.5",
            open ? null : "border-t border-border/35",
          )}
        >
          <SubagentDetails
            displayTask={displayTask}
            progressUpdates={dedupedProgress}
            result={result}
            isStreaming={isStreaming}
            nested={nested}
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

interface PromotedSubagentTriggerProps {
  readonly id: string;
  readonly headerFindUnitId: string;
  readonly displayName: string;
  readonly displayAgentType: string | null;
  readonly headerSummary: string;
  readonly showHeaderSummary: boolean;
  readonly isStreaming: boolean;
  readonly endState: SegmentEndState;
  readonly stopped: boolean;
  readonly startedAt: number | null;
  readonly durationMs: number | null;
  readonly open: boolean;
}

function useSubagentCollapsibleKey(renderId: string): ChatCollapsibleKey {
  const tileInstanceId = useChatCollapsibleTileInstanceId();
  return useMemo(
    () => deriveSubagentCollapsibleKey(tileInstanceId, renderId),
    [renderId, tileInstanceId],
  );
}

function PromotedSubagentTrigger(props: PromotedSubagentTriggerProps) {
  const {
    displayAgentType,
    displayName,
    durationMs,
    endState,
    headerFindUnitId,
    headerSummary,
    id,
    isStreaming,
    open,
    showHeaderSummary,
    startedAt,
    stopped,
  } = props;
  return (
    <CollapsibleTrigger
      aria-label="Subagent"
      data-find-include="true"
      data-chat-find-unit={headerFindUnitId}
      className={cn(
        "group/subagent flex w-full gap-2 px-3 py-2 text-left transition-colors",
        showHeaderSummary ? "items-start" : "items-center",
        // The sticky header floats over scrolled content, so its hover tint
        // must stay opaque - a translucent bg lets the content bleed through.
        open
          ? "sticky top-0 z-20 rounded-t-md border-b border-border/35 bg-background shadow-sm hover:bg-[color-mix(in_oklch,var(--muted)_35%,var(--background))]"
          : "hover:bg-muted/35",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
      )}
    >
      <SubagentAvatar
        seed={id}
        active={isStreaming}
        size={16}
        className={showHeaderSummary ? "mt-[0.2rem]" : null}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 self-stretch">
        <span className="flex w-full min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate font-mono text-code-sm font-medium text-foreground/90">
            {displayName}
          </span>
          {displayAgentType !== null ? (
            <Badge variant="secondary" className="shrink-0 capitalize">
              {displayAgentType}
            </Badge>
          ) : null}
          <span
            data-find-skip
            className="ml-auto flex shrink-0 items-center gap-1.5"
          >
            <ElapsedTime
              startedAt={startedAt}
              durationMs={durationMs}
              isStreaming={isStreaming}
            />
            {isStreaming ? (
              <LivePulse
                size="xs"
                tone="active"
                ariaLabel="Subagent running"
                className={undefined}
              />
            ) : null}
            <SegmentEndStateBadge endState={endState} stopped={stopped} />
            <ChevronDown
              aria-hidden
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground/70 transition-transform",
                "group-data-[state=open]/subagent:rotate-180",
              )}
            />
          </span>
        </span>
        {showHeaderSummary ? (
          <span className="flex w-full min-w-0 items-start gap-1.5 pl-2 text-muted-foreground">
            <span
              aria-hidden
              className="mt-[0.2rem] h-2.5 w-3 shrink-0 rounded-bl-sm border-b border-l border-muted-foreground/35"
            />
            <span data-find-skip className="min-w-0 flex-1 truncate">
              {headerSummary}
            </span>
          </span>
        ) : null}
      </span>
    </CollapsibleTrigger>
  );
}

interface SubagentDetailsProps {
  readonly displayTask: string | null;
  readonly progressUpdates: ReadonlyArray<ProgressUpdateItem>;
  readonly result: string | null;
  readonly isStreaming: boolean;
  readonly nested: ReadonlyArray<SubagentChildSegment>;
}

function SubagentDetails(props: SubagentDetailsProps) {
  const { displayTask, isStreaming, nested, progressUpdates, result } = props;
  return (
    <div className="flex flex-col gap-2 text-ui-sm">
      {displayTask !== null ? (
        <div className="flex flex-col gap-1">
          <span
            data-find-skip
            className="select-none font-medium uppercase text-overline text-muted-foreground/80"
          >
            Task
          </span>
          <p className="m-0 whitespace-pre-wrap text-foreground/85">
            {displayTask}
          </p>
        </div>
      ) : null}
      {progressUpdates.length > 0 || isStreaming ? (
        <div className="flex flex-col gap-1">
          <span
            data-find-skip
            className="select-none font-medium uppercase text-overline text-muted-foreground/80"
          >
            Progress
          </span>
          <ProgressTimeline
            updates={progressUpdates}
            isStreaming={isStreaming}
            emptyLabel="Starting..."
          />
        </div>
      ) : null}
      <SubagentChildProviderNotices nested={nested} />
      <SubagentChildrenSection nested={nested} />
      {result !== null ? (
        <SubagentResultPanel result={result} isStreaming={isStreaming} />
      ) : null}
    </div>
  );
}

/**
 * The "Sub-agents" section (Flow 1): nested agent CHILDREN only - the rest of
 * `nested` (tool/file_change/command) exists purely for spawn-tool-call
 * suppression and isn't separately rendered here, matching how a top-level
 * agent's own tool activity was never itemized either. Each nested agent
 * renders as a `row`-variant card and recurses through the SAME component, so
 * depth beyond one level falls out of this section rendering for free - the
 * indentation (`border-l` + `pl-3`) accumulates once per level.
 */
function SubagentChildrenSection(props: {
  readonly nested: ReadonlyArray<SubagentChildSegment>;
}) {
  const nestedAgents = props.nested.filter(
    (child): child is Extract<SubagentChildSegment, { kind: "subagent" }> =>
      child.kind === "subagent",
  );
  if (nestedAgents.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <span
        data-find-skip
        className="select-none font-medium uppercase text-overline text-muted-foreground/80"
      >
        Sub-agents
      </span>
      <div className="flex flex-col gap-1.5 border-l border-border/40 pl-3">
        {nestedAgents.map((agent) => (
          <SubagentSegment
            key={agent.id}
            id={agent.id}
            name={agent.name}
            agentType={agent.agentType}
            task={agent.task}
            progressUpdates={agent.progressUpdates}
            result={agent.result}
            isStreaming={agent.isStreaming}
            endState={agent.endState}
            stopped={agent.stopped}
            startedAt={agent.startedAt}
            durationMs={agent.durationMs}
            workflowMeta={agent.workflowMeta}
            nested={agent.children}
            variant="row"
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Provider notices (Codex model reroute / safety verification / buffering,
 * etc.) that arrived on THIS subagent's thread - unlike the tool/file_change/
 * command entries in `nested`, these DO render as visible rows, right where
 * the notice actually happened for this sub-agent.
 */
function SubagentChildProviderNotices(props: {
  readonly nested: ReadonlyArray<SubagentChildSegment>;
}) {
  const notices = props.nested.filter(
    (
      child,
    ): child is Extract<SubagentChildSegment, { kind: "provider_notice" }> =>
      child.kind === "provider_notice",
  );
  if (notices.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      {notices.map((notice) => (
        <ProviderNoticeSegment
          key={notice.id}
          status={notice.status}
          tone={notice.tone}
          title={notice.title}
          message={notice.message}
          details={notice.details}
          findUnitId={chatFindSegmentUnitId(notice.id)}
        />
      ))}
    </div>
  );
}

function SubagentResultPanel(props: {
  readonly result: string;
  readonly isStreaming: boolean;
}) {
  const { isStreaming, result } = props;
  return (
    <SegmentPanel
      label="Result"
      copyValue={result}
      tone="default"
      bodyChrome="framed"
      className={undefined}
    >
      <div className="px-3 py-2">
        <AgentReferenceMarkdown
          isStreaming={isStreaming}
          markdown={result}
          proseSize="compact"
          quotable={false}
        />
      </div>
    </SegmentPanel>
  );
}

interface ProgressTimelineProps {
  readonly updates: ReadonlyArray<ProgressUpdateItem>;
  readonly isStreaming: boolean;
  readonly emptyLabel: string;
}

function ProgressTimeline(props: ProgressTimelineProps) {
  const { emptyLabel, isStreaming, updates } = props;
  const newestKey = updates.at(-1)?.key ?? null;
  if (updates.length === 0) {
    if (!isStreaming) return null;
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <AgentSpinningDots
          className="text-current"
          testId={undefined}
          variant={undefined}
        />
        <span>{emptyLabel}</span>
      </div>
    );
  }

  return (
    <ol className="m-0 flex list-none flex-col gap-1 pl-0">
      {updates.map((update) => {
        const newest = update.key === newestKey;
        return (
          <li
            key={update.key}
            className={cn(
              "flex min-w-0 items-start gap-2",
              newest && isStreaming
                ? "text-foreground/90"
                : "text-muted-foreground",
            )}
          >
            <span className="mt-[0.35em] flex w-3 shrink-0 justify-center">
              {newest && isStreaming ? (
                <AgentSpinningDots
                  className="text-current"
                  testId={undefined}
                  variant={undefined}
                />
              ) : (
                <span className="size-1 rounded-full bg-current opacity-55" />
              )}
            </span>
            <span className="min-w-0 whitespace-pre-wrap">{update.text}</span>
          </li>
        );
      })}
    </ol>
  );
}

function useAdjacentDedupedProgressItems(
  progressUpdates: ReadonlyArray<string>,
): ReadonlyArray<ProgressUpdateItem> {
  return useMemo(
    () => adjacentDedupedProgressItems(progressUpdates),
    [progressUpdates],
  );
}

interface WorkflowCardSegmentProps extends Omit<
  SubagentSegmentProps,
  "variant" | "workflowMeta"
> {
  readonly workflowMeta: WorkflowMeta;
  readonly variant: "card" | "row";
}

/**
 * The dedicated workflow card (Flow 2) - rendered whenever a subagent block
 * carries `workflowMeta`, never as a separate segment/block-type branch. It
 * reuses the same segment-card primitives and open-store as an ordinary agent
 * card (a workflow IS a subagent block underneath), but replaces Task/Progress
 * with Intent/Activity and appends totals to the Result.
 */
function WorkflowCardSegment(props: WorkflowCardSegmentProps) {
  const {
    id,
    name,
    result,
    isStreaming,
    endState,
    stopped,
    startedAt,
    durationMs,
    workflowMeta,
    nested,
    variant,
  } = props;
  const collapsibleKey = useSubagentCollapsibleKey(id);
  const headerFindUnitId = chatFindSubagentHeaderUnitId(id);
  const bodyFindUnitId = chatFindSubagentBodyUnitId(id);
  const openScope = useChatOpenStoreScope();
  const userOpen = useSubagentOpenStore((s) =>
    s.openIds.has(scopedChatOpenId(openScope, id)),
  );
  const findForcedOpen = useChatFindForcedOpen(collapsibleKey);
  const open = userOpen || findForcedOpen;
  const setOpen = useSubagentOpenStore((s) => s.setOpen);
  const setFindForcedOpen = useSetChatFindForcedOpen();
  const handleOpenChange = useCallback(
    (newOpen: boolean) => {
      setOpen(openScope, id, newOpen);
      if (!newOpen) setFindForcedOpen(collapsibleKey, false);
    },
    [collapsibleKey, id, openScope, setFindForcedOpen, setOpen],
  );

  const displayName = cleanSubagentNotificationText(name) ?? "Workflow";
  const liveLine = workflowLiveLine(workflowMeta);
  // Collapsed line prefers the result once available, mirroring the plain
  // agent card; while running it carries the fleet's aggregate story instead
  // of a raw progress line (workflows have none - see workflowLiveLine).
  const summary = result ?? liveLine ?? (isStreaming ? "Starting…" : null);

  const header = (
    <>
      <span
        aria-hidden
        className="flex size-4 shrink-0 items-center justify-center rounded bg-gradient-to-br from-indigo-500 to-purple-500 text-white"
      >
        <WorkflowIcon className="size-2.5" />
      </span>
      <span className="shrink-0 text-code-sm font-medium text-foreground/85">
        {displayName}
      </span>
      <Badge variant="secondary" className="shrink-0 uppercase">
        Workflow
      </Badge>
      {summary !== null ? (
        <>
          <span aria-hidden className="shrink-0 text-muted-foreground/40">
            ·
          </span>
          <span
            data-find-skip
            className="min-w-0 flex-1 truncate text-ui-sm text-muted-foreground"
          >
            {summary}
          </span>
        </>
      ) : (
        <span aria-hidden className="flex-1" />
      )}
      <span data-find-skip className="contents">
        <ElapsedTime
          startedAt={startedAt}
          durationMs={durationMs}
          isStreaming={isStreaming}
        />
        {isStreaming ? (
          <LivePulse
            size="xs"
            tone="active"
            ariaLabel="Workflow running"
            className={undefined}
          />
        ) : null}
        <SegmentEndStateBadge endState={endState} stopped={stopped} />
      </span>
    </>
  );

  const body = (
    <div className="flex flex-col gap-2 text-ui-sm">
      {workflowMeta.intent !== null ? (
        <div className="flex flex-col gap-1">
          <span
            data-find-skip
            className="select-none font-medium uppercase text-overline text-muted-foreground/80"
          >
            Intent
          </span>
          <p className="m-0 whitespace-pre-wrap text-foreground/85">
            {workflowMeta.intent}
          </p>
        </div>
      ) : null}
      {workflowMeta.activity.length > 0 || isStreaming ? (
        <div className="flex flex-col gap-1">
          <span
            data-find-skip
            className="select-none font-medium uppercase text-overline text-muted-foreground/80"
          >
            Activity
          </span>
          <WorkflowActivityTimeline
            activity={workflowMeta.activity}
            isStreaming={isStreaming}
          />
        </div>
      ) : null}
      <SubagentChildProviderNotices nested={nested} />
      <SubagentChildrenSection nested={nested} />
      {result !== null ? (
        <>
          <SubagentResultPanel result={result} isStreaming={isStreaming} />
          {!isStreaming ? (
            <WorkflowResultTotals
              workflowMeta={workflowMeta}
              durationMs={durationMs}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );

  if (variant === "row") {
    return (
      <SegmentRow
        open={open}
        onOpenChange={handleOpenChange}
        header={header}
        body={body}
        tone="default"
        stickyHeader
        expandable
        headerFindUnitId={headerFindUnitId}
        bodyFindUnitId={bodyFindUnitId}
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
      collapsedPreview={null}
      body={body}
      tone="primary"
      headerPosition="normal"
      bodyOverflow="hidden"
      expandable
      headerFindUnitId={headerFindUnitId}
      bodyFindUnitId={bodyFindUnitId}
      className={undefined}
    />
  );
}

function latestActivityText(
  activity: ReadonlyArray<WorkflowActivityEntry>,
  kind: WorkflowActivityEntry["kind"],
): string | null {
  return activity.filter((entry) => entry.kind === kind).at(-1)?.text ?? null;
}

/**
 * The workflow card's live line (header + panel row): current phase, the most
 * recently active fleet-agent label, and finished/started counts. Derived
 * from the activity log itself, not a dedicated phase/activeLabel field -
 * those live only on the ephemeral BackgroundItem (panel row); the persisted
 * workflowMeta carries just the activity log + aggregate counts (§2.2), so
 * "current phase" / "current label" are the latest entry of each kind.
 */
function workflowLiveLine(meta: WorkflowMeta): string | null {
  const phase = latestActivityText(meta.activity, "phase");
  const label = latestActivityText(meta.activity, "label");
  const counts =
    meta.agentsFinished !== null && meta.agentsStarted !== null
      ? `${meta.agentsFinished} / ${meta.agentsStarted} agents done`
      : null;
  const parts = [
    phase,
    label !== null ? `working on ${label}` : null,
    counts,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}

interface WorkflowActivityTimelineProps {
  readonly activity: ReadonlyArray<WorkflowActivityEntry>;
  readonly isStreaming: boolean;
}

/**
 * Reads as "what the fleet has been doing", not a per-agent ledger: phase
 * transitions render as bold milestones, interleaved with the rotating
 * agent-label sightings in muted text - the newest entry gets the live spinner
 * while the run is still going.
 */
function WorkflowActivityTimeline(props: WorkflowActivityTimelineProps) {
  const { activity, isStreaming } = props;
  if (activity.length === 0) {
    if (!isStreaming) return null;
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <AgentSpinningDots
          className="text-current"
          testId={undefined}
          variant={undefined}
        />
        <span>Starting…</span>
      </div>
    );
  }
  const rows = workflowActivityRows(activity);
  const newestKey = rows.at(-1)?.key ?? null;
  return (
    <ol className="m-0 flex list-none flex-col gap-1 pl-0">
      {rows.map((row) => {
        const newest = row.key === newestKey;
        const isPhase = row.kind === "phase";
        return (
          <li
            key={row.key}
            className={cn(
              "flex min-w-0 items-start gap-2",
              workflowActivityRowToneClass(isPhase, newest, isStreaming),
            )}
          >
            <span className="mt-[0.35em] flex w-3 shrink-0 justify-center">
              {newest && isStreaming ? (
                <AgentSpinningDots
                  className="text-current"
                  testId={undefined}
                  variant={undefined}
                />
              ) : (
                <span
                  className={cn(
                    "size-1 rounded-full bg-current",
                    isPhase ? "opacity-90" : "opacity-55",
                  )}
                />
              )}
            </span>
            <span className="min-w-0 whitespace-pre-wrap">{row.text}</span>
          </li>
        );
      })}
    </ol>
  );
}

interface WorkflowActivityRow extends WorkflowActivityEntry {
  readonly key: string;
}

// Activity entries carry no stable id and can legitimately repeat (a label
// sighted again later, non-consecutively) - key on content + nth-occurrence,
// mirroring the same pattern `adjacentDedupedProgressItems` uses for progress
// lines, so React reconciles in place instead of by array index.
function workflowActivityRows(
  activity: ReadonlyArray<WorkflowActivityEntry>,
): ReadonlyArray<WorkflowActivityRow> {
  const seenCounts = new Map<string, number>();
  return activity.map((entry) => {
    const identity = `${entry.kind}:${entry.text}`;
    const count = (seenCounts.get(identity) ?? 0) + 1;
    seenCounts.set(identity, count);
    return { ...entry, key: `${identity}:${count}` };
  });
}

function workflowActivityRowToneClass(
  isPhase: boolean,
  newest: boolean,
  isStreaming: boolean,
): string {
  if (isPhase) return "font-medium text-foreground/90";
  if (newest && isStreaming) return "text-foreground/90";
  return "text-muted-foreground";
}

function formatWorkflowTokens(value: number): string {
  return value.toLocaleString();
}

/**
 * Totals line under the Result panel once the run has settled: agents run,
 * tokens, and total duration (Flow 2, point 3). Omits whichever pieces the
 * host never populated instead of showing a placeholder.
 */
function WorkflowResultTotals(props: {
  readonly workflowMeta: WorkflowMeta;
  readonly durationMs: number | null;
}) {
  const { durationMs, workflowMeta } = props;
  const parts = [
    workflowMeta.agentsFinished === null
      ? null
      : `${workflowMeta.agentsFinished} agent${
          workflowMeta.agentsFinished === 1 ? "" : "s"
        } run`,
    workflowMeta.totalTokens === null
      ? null
      : `${formatWorkflowTokens(workflowMeta.totalTokens)} tokens`,
    durationMs === null
      ? null
      : formatClockDuration(Math.max(1, Math.floor(durationMs / 1000))),
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) return null;
  return (
    <p data-find-skip className="m-0 text-ui-xs text-muted-foreground/80">
      {parts.join(" · ")}
    </p>
  );
}
