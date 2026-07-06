import { ChevronDown } from "lucide-react";
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
  chatFindSubagentBodyUnitId,
  chatFindSubagentHeaderUnitId,
} from "@/components/chat/chat-find";
import {
  useChatCollapsibleTileInstanceId,
  useChatFindForcedOpen,
  useSetChatFindForcedOpen,
} from "@/stores/chats/chat-find-force-store-context";
import {
  adjacentDedupedProgressItems,
  cleanSubagentNotificationText,
  type ProgressUpdateItem,
} from "./subagent-display";
import { AgentReferenceMarkdown } from "./agent-reference-markdown";
import { SubagentAvatar } from "./subagent-avatar";
import { ElapsedTime } from "./segment-elapsed";
import { SegmentCard } from "./segment-card";
import { SegmentPanel } from "./segment-panel";
import { SegmentRow } from "./segment-row";
import { SegmentEndStateBadge } from "./segment-end-state-badge";
import type { SegmentEndState } from "@/stores/composer/chat-store";

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
  variant: "card" | "row" | "promoted";
}

type CompactSubagentSegmentProps = Omit<SubagentSegmentProps, "variant"> & {
  variant: "card" | "row";
};

export function SubagentSegment(props: SubagentSegmentProps) {
  // Both child variants take the same props minus `variant`; spread the rest so
  // a new card field only needs adding to the interface, not to two hand-kept
  // forwarding lists.
  const { variant, ...rest } = props;
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

function PromotedSubagentSegment(props: Omit<SubagentSegmentProps, "variant">) {
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
}

function SubagentDetails(props: SubagentDetailsProps) {
  const { displayTask, isStreaming, progressUpdates, result } = props;
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
      {result !== null ? (
        <SubagentResultPanel result={result} isStreaming={isStreaming} />
      ) : null}
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
