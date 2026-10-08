import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DraggableSyntheticListeners,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
  Cable,
  GripVertical,
  ChevronDown,
  Inbox,
  ListOrdered,
  Pause,
  Pencil,
  Play,
  SendHorizontal,
  Trash2,
  Undo2,
} from "lucide-react";
import {
  memo,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { DropLine } from "@/components/ui/drop-line";
import { LivePulse } from "@/components/ui/live-pulse";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import type {
  ChatActiveTurn,
  OpenChatQueuedItem,
  OpenChatQueuedPromptItem,
} from "@traycer/protocol/host/agent/gui/subscribe";
import { ComposerContentPreview } from "@/components/chat/composer/composer-content-preview";
import {
  isReceivedAgentResponse,
  queuePausedAfterError,
} from "@/components/chat/chat-queue-utils";
import {
  QUEUE_PAUSED_AFTER_ERROR_LABEL,
  QUEUE_PAUSED_AFTER_ERROR_TOOLTIP,
  QUEUE_PAUSED_BY_ROUTING_TOOLTIP,
} from "@/components/chat/fallback/fallback-copy";
import {
  QUEUED_MESSAGE_DND_MODIFIERS,
  useQueuedMessageReorderDnd,
  useQueuedMessageRowSortable,
  type QueuedMessageDropPreview,
} from "@/components/chat/queued-message-reorder-dnd";
import {
  queueItemSteerLocked,
  useQueuePauseState,
} from "@/components/chat/queued-message-utils";
import type { ChatSessionState } from "@/stores/chats/chat-session-store";
import {
  MANAGED_COMMAND_OUTPUT_WINDOW_TITLE,
  MANAGED_COMMAND_QUEUED_CHIP_TOOLTIP,
} from "@/lib/managed-commands/managed-command-copy";
import { ManagedCommandMonitorIcon } from "@/components/managed-commands/managed-command-monitor-icon";
import { useManagedCommandDoor } from "@/lib/managed-commands/use-managed-command-door";
import {
  isOptimisticQueuedItem,
  optimisticQueuedItemClientActionId,
} from "@/stores/chats/optimistic-queue";
import {
  queueItemInFlightLabel,
  type QueueItemInFlight,
} from "@/stores/chats/queue-edit-custody";
import { QueuedMessageStagesContext } from "@/components/chat/queued-message-stages";
import { formatClockTime } from "@/lib/relative-time";
import { mergeRefs } from "@/lib/merge-refs";
import { cn } from "@/lib/utils";
import {
  CHAT_DOCK_PANEL_LIST,
  CHAT_DOCK_PANEL_ROW,
  CHAT_DOCK_PANEL_ROW_TEXT,
} from "@/components/chat/chat-dock-panel-row";

interface QueuedMessageRowActionState {
  readonly canReorder: boolean;
  readonly isSteering: boolean;
  readonly isTransient: boolean;
  readonly isLocked: boolean;
  readonly actionsDisabled: boolean;
  readonly steerNowDisabled: boolean;
}

interface QueuedMessageRowActionStateInput {
  readonly item: OpenChatQueuedItem;
  /** This row's own unanswered mutation, or `null` when it has none. */
  readonly inFlight: QueueItemInFlight | null;
  readonly queueStatus: ChatSessionState["queue"]["status"];
  readonly canReorder: boolean;
  readonly canAct: boolean;
  readonly readOnly: boolean;
  readonly activeTurnStatus: ChatActiveTurn["status"] | null;
  readonly hasSteerRestartPending: boolean;
}

interface QueuedMessageRowChrome {
  readonly showOwnerActions: boolean;
  readonly showManagedCommandCancel: boolean;
  readonly canAbortSteer: boolean;
}

interface QueuedMessageRowChromeInput {
  readonly promptItem: OpenChatQueuedPromptItem | null;
  readonly receivedAgentResponse: boolean;
  readonly readOnly: boolean;
  readonly canAct: boolean;
  readonly isLocked: boolean;
  /** This row has a mutation of its own the host has not answered. */
  readonly mutationInFlight: boolean;
}

interface QueuedMessageRowContentAgentFold {
  readonly expanded: boolean;
  readonly onToggle: () => void;
}

interface QueuedMessageEditActionCopy {
  readonly label: string;
  readonly title: string;
}

export interface QueuedMessagePanelProps {
  readonly queue: ChatSessionState["queue"];
  readonly activeTurnStatus: ChatActiveTurn["status"] | null;
  readonly canAct: boolean;
  /** The resume frame was dispatched but has not reached authoritative queue state yet. */
  readonly resumeRequested: boolean;
  /** A pause frame was dispatched to supersede the pending resume. */
  readonly keepPausedRequested: boolean;
  readonly readOnly: boolean;
  readonly editingQueueItemId: string | null;
  readonly scrollRegionMaxHeightClass: string;
  /** A hairline above this panel, because a sibling drew before it in the
   *  dock's shared frame (L-97). */
  readonly separated: boolean;
  /**
   * Whether the list is unfolded. Owned by the caller, not the panel (#2441):
   * the panel unmounts whenever the queue drains, so a fold it kept itself
   * came back open with the next queued message.
   */
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPause: () => string | null;
  readonly onResume: () => string | null;
  // Edit / steer are prompt-only by type: a managed-command item carries no
  // message to load into the composer and is never hand-steerable, so the
  // compiler - not a runtime guard - is what keeps it out of these paths.
  // Cancel and reorder stay on the union: both key off `queueItemId` alone and
  // both are offered for managed-command items.
  readonly onEdit: (item: OpenChatQueuedPromptItem) => void;
  readonly onCancel: (item: OpenChatQueuedItem) => void;
  readonly onAbortSteer: (item: OpenChatQueuedPromptItem) => void;
  readonly onReorder: (
    item: OpenChatQueuedItem,
    beforeQueueItemId: string | null,
  ) => void;
  readonly onSteerNow: (item: OpenChatQueuedPromptItem) => void;
}

function queueItemAllowsReorder(item: OpenChatQueuedItem): boolean {
  return !queueItemSteerLocked(item) && item.status !== "injected";
}

export function QueuedMessagePanel(props: QueuedMessagePanelProps) {
  // The received agent rows the user unfolded to read (#2441). Panel-local on
  // purpose: an agent row's default is the one-line one, so forgetting these
  // on a remount costs a click, never room.
  const [expandedQueueItemIds, setExpandedQueueItemIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const toggleExpanded = useCallback((queueItemId: string) => {
    setExpandedQueueItemIds((current) => {
      const next = new Set(current);
      if (!next.delete(queueItemId)) next.add(queueItemId);
      return next;
    });
  }, []);
  // Render the queue in its true order, user-typed and received A2A items
  // alike. Received items render read-only (see QueuedMessageRow) - the user
  // can reorder them but cannot edit, delete, or hand-steer them.
  const items = props.queue.items;
  const reorderableCount = useMemo(
    () => items.filter(queueItemAllowsReorder).length,
    [items],
  );
  const agentCount = useMemo(
    () => items.filter(isReceivedAgentResponse).length,
    [items],
  );
  const queueStatus = props.queue.status;
  const pausedAfterErrorTooltip = queuePausedAfterErrorTooltip(props.queue);
  const hasSteerRestartPending = useMemo(
    () =>
      items.some(
        (item) =>
          item.kind === "prompt" &&
          item.status === "steer_requested" &&
          item.steerRequest?.mode === "interrupt_restart",
      ),
    [items],
  );
  const { hasPausableHumanItems, hasPausedItems } = useQueuePauseState(items);
  const reorderDnd = useQueuedMessageReorderDnd({
    items,
    onReorder: props.onReorder,
  });
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
  );
  const rowRefs = useRef<Map<string, HTMLDivElement> | null>(null);
  const registerRowElement = useCallback(
    (queueItemId: string, element: HTMLDivElement | null) => {
      if (rowRefs.current === null) {
        rowRefs.current = new Map();
      }
      const rowElements = rowRefs.current;
      if (element === null) {
        rowElements.delete(queueItemId);
        return;
      }
      rowElements.set(queueItemId, element);
    },
    [],
  );

  useEffect(() => {
    if (props.editingQueueItemId === null) return;
    if (rowRefs.current === null) return;
    const row = rowRefs.current.get(props.editingQueueItemId);
    row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [props.editingQueueItemId, items]);

  if (items.length === 0) return null;

  const list = (
    <DndContext
      sensors={sensors}
      autoScroll={false}
      collisionDetection={reorderDnd.collisionDetection}
      modifiers={QUEUED_MESSAGE_DND_MODIFIERS}
      onDragStart={reorderDnd.handleDragStart}
      onDragMove={reorderDnd.handleDragMove}
      onDragOver={reorderDnd.handleDragOver}
      onDragEnd={reorderDnd.handleDragEnd}
      onDragCancel={reorderDnd.handleDragCancel}
    >
      <SortableContext
        items={[...reorderDnd.sortableItemIds]}
        strategy={verticalListSortingStrategy}
      >
        <div className={CHAT_DOCK_PANEL_LIST}>
          {items.map((item, index) => {
            return (
              <QueuedMessageRow
                key={item.queueItemId}
                item={item}
                index={index}
                orderKey={reorderDnd.orderKey}
                queueStatus={queueStatus}
                pausedAfterErrorTooltip={pausedAfterErrorTooltip}
                canReorder={reorderableCount > 1}
                canAct={props.canAct}
                readOnly={props.readOnly}
                activeTurnStatus={props.activeTurnStatus}
                hasSteerRestartPending={hasSteerRestartPending}
                editing={props.editingQueueItemId === item.queueItemId}
                expanded={expandedQueueItemIds.has(item.queueItemId)}
                onToggleExpanded={toggleExpanded}
                dropPreview={reorderDnd.dropPreview}
                itemCount={items.length}
                registerRowElement={registerRowElement}
                onEdit={props.onEdit}
                onCancel={props.onCancel}
                onAbortSteer={props.onAbortSteer}
                onSteerNow={props.onSteerNow}
              />
            );
          })}
        </div>
      </SortableContext>
    </DndContext>
  );

  return (
    <Collapsible
      open={props.open}
      onOpenChange={props.onOpenChange}
      data-testid="queued-message-rows"
      className={cn(
        "@container",
        props.separated ? "border-t border-border/50" : null,
        props.readOnly ? "opacity-95" : null,
      )}
      variant="panel"
    >
      <QueuedMessageHeader
        open={props.open}
        count={items.length}
        agentCount={agentCount}
        queueStatus={queueStatus}
        canPauseQueue={hasPausableHumanItems}
        canResumeQueue={hasPausedItems}
        canAct={props.canAct}
        resumeRequested={props.resumeRequested}
        keepPausedRequested={props.keepPausedRequested}
        readOnly={props.readOnly}
        onPause={props.onPause}
        onResume={props.onResume}
      />
      <CollapsibleContent>
        <div
          data-testid="queued-message-list"
          data-native-scrollbar="true"
          className={cn(
            "overflow-y-auto border-t border-border/50",
            props.scrollRegionMaxHeightClass,
          )}
        >
          {list}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * The "Paused after an error" pill's tooltip, or `null` when the queue is not
 * held after a failed turn (`queuePausedAfterError`) and the pill says plain
 * "Paused".
 *
 * Read off the queue alone, like the pill. A routing pause gets one sentence
 * for all of its states (`QUEUE_PAUSED_BY_ROUTING_TOOLTIP`): whether routing
 * is still holding the queue is not something the absence of a routing card
 * can prove - a retry draws no card, and the frame is withdrawn while the
 * replacement runs - and even within one traversal a rejected row is not
 * released with the rest (review F9/F10, 2026-09-27).
 */
function queuePausedAfterErrorTooltip(
  queue: ChatSessionState["queue"],
): string | null {
  if (!queuePausedAfterError(queue)) return null;
  return queue.pausedReason === "routing"
    ? QUEUE_PAUSED_BY_ROUTING_TOOLTIP
    : QUEUE_PAUSED_AFTER_ERROR_TOOLTIP;
}

function queueHeaderTooltip(input: {
  readonly queueStatus: ChatSessionState["queue"]["status"];
  readonly showPauseQueueButton: boolean;
  readonly showResumeQueueButton: boolean;
  readonly resumeRequested: boolean;
  readonly keepPausedRequested: boolean;
}): string | null {
  if (input.keepPausedRequested) {
    return "The queue will remain paused";
  }
  if (input.resumeRequested) {
    return "Keep queued messages paused";
  }
  if (input.showResumeQueueButton) {
    return "Resume held queued messages";
  }
  if (input.showPauseQueueButton) {
    return "Pause human queued messages";
  }
  if (input.queueStatus === "running") {
    return "Queued prompts run after the active turn unless a frozen row is being steered into it";
  }
  if (input.queueStatus === "paused") {
    return "Resume to continue sending queued messages";
  }
  return null;
}

function queueHeaderAnnouncement(input: {
  readonly resumeRequested: boolean;
  readonly keepPausedRequested: boolean;
}): string {
  if (input.keepPausedRequested) {
    return "Queue will stay paused.";
  }
  if (input.resumeRequested) {
    return "Queued messages will send when ready.";
  }
  return "";
}

function messageCount(count: number): string {
  return count === 1 ? "1 message" : `${count} messages`;
}

/**
 * The header's count, split once agents are in it (#2441): "2 messages · 12
 * from agents" says how much of the queue is the user's own pending sends and
 * how much is replies they only read.
 */
function queueHeaderSummary(input: {
  readonly count: number;
  /** How many of `count` are received agent messages. */
  readonly agentCount: number;
  readonly resumeRequested: boolean;
  readonly keepPausedRequested: boolean;
}): string {
  if (input.keepPausedRequested) {
    return "Staying paused";
  }
  if (input.resumeRequested) {
    return "Will send when ready";
  }
  if (input.agentCount === 0) {
    return messageCount(input.count);
  }
  const fromAgents =
    input.agentCount === 1
      ? "1 from an agent"
      : `${input.agentCount} from agents`;
  if (input.agentCount === input.count) {
    return `${messageCount(input.count)} from ${input.count === 1 ? "an agent" : "agents"}`;
  }
  return `${messageCount(input.count - input.agentCount)} · ${fromAgents}`;
}

function QueueResumeIcon(props: { readonly pending: boolean }) {
  if (props.pending) {
    return (
      <AgentSpinningDots
        className={undefined}
        testId="queue-resume-spinner"
        variant={undefined}
      />
    );
  }
  return <Play className="size-3.5" />;
}

function KeepPausedIcon(props: { readonly pending: boolean }) {
  if (props.pending) {
    return (
      <AgentSpinningDots
        className={undefined}
        testId="queue-keep-paused-spinner"
        variant={undefined}
      />
    );
  }
  return <Pause className="size-3.5" />;
}

/**
 * The queue's own controls: the live announcement, the viewer notice and
 * Pause / Resume / Keep paused.
 *
 * A component rather than JSX inside the header because the queue is a dock
 * member now (L-139) and can stand as a pill: while its pill is the open one
 * the panel below has no header at all, and these controls are portalled to
 * the right end of the pill row instead (L-142). One definition, two homes.
 */
function QueuedMessageQueueControls(props: {
  readonly canAct: boolean;
  readonly readOnly: boolean;
  readonly resumeRequested: boolean;
  readonly keepPausedRequested: boolean;
  readonly showResumeQueueButton: boolean;
  readonly showPauseQueueButton: boolean;
  readonly onPause: () => string | null;
  readonly onResume: () => string | null;
}) {
  const {
    canAct,
    readOnly,
    resumeRequested,
    keepPausedRequested,
    showResumeQueueButton,
    showPauseQueueButton,
    onPause,
    onResume,
  } = props;
  const showKeepPausedButton = resumeRequested || keepPausedRequested;
  const resumePending = resumeRequested && !keepPausedRequested;
  const announcement = queueHeaderAnnouncement({
    resumeRequested,
    keepPausedRequested,
  });
  return (
    <>
      <span className="sr-only" aria-live="polite">
        {announcement}
      </span>
      {readOnly ? (
        <span className="flex shrink-0 items-center px-3 text-ui-xs text-muted-foreground">
          Owner manages queue
        </span>
      ) : null}
      {showResumeQueueButton ? (
        <div className="flex shrink-0 items-center gap-1 pr-1.5">
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="h-7 shrink-0"
            disabled={!canAct || showKeepPausedButton}
            onClick={() => {
              onResume();
            }}
            data-testid="resume-queue-button"
          >
            <QueueResumeIcon pending={resumePending} />
            Resume
          </Button>
          {showKeepPausedButton ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              className="h-7 shrink-0"
              disabled={!canAct || keepPausedRequested}
              onClick={() => {
                onPause();
              }}
              data-testid="keep-paused-queue-button"
            >
              <KeepPausedIcon pending={keepPausedRequested} />
              Keep paused
            </Button>
          ) : null}
        </div>
      ) : null}
      {showPauseQueueButton ? (
        <div className="flex shrink-0 items-center pr-1.5">
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="h-7 shrink-0"
            disabled={!canAct}
            onClick={() => {
              onPause();
            }}
            data-testid="pause-queue-button"
          >
            <Pause className="size-3.5" />
            Pause
          </Button>
        </div>
      ) : null}
    </>
  );
}

/**
 * The queue row's header on its own - the collapsed strip with its count, its
 * status word and its Pause/Resume controls.
 *
 * Exported for the layout editor's PICTURE of the Full-row queue, which wants
 * the header and nothing under it: mounting the whole panel there would drag a
 * `DndContext` and a sortable list into a specimen that can never be dragged.
 */
export function QueuedMessageHeader(props: {
  readonly open: boolean;
  readonly count: number;
  /** How many of `count` are received agent messages. */
  readonly agentCount: number;
  readonly queueStatus: ChatSessionState["queue"]["status"];
  readonly canPauseQueue: boolean;
  readonly canResumeQueue: boolean;
  readonly canAct: boolean;
  readonly resumeRequested: boolean;
  readonly keepPausedRequested: boolean;
  readonly readOnly: boolean;
  readonly onPause: () => string | null;
  readonly onResume: () => string | null;
}) {
  const {
    count,
    agentCount,
    queueStatus,
    canPauseQueue,
    canResumeQueue,
    canAct,
    resumeRequested,
    keepPausedRequested,
    readOnly,
    onPause,
    onResume,
    open,
  } = props;
  const showResumeQueueButton = canResumeQueue && !readOnly;
  const showPauseQueueButton =
    !showResumeQueueButton && canPauseQueue && !readOnly;
  const summary = queueHeaderSummary({
    count,
    agentCount,
    resumeRequested,
    keepPausedRequested,
  });
  const tooltip = queueHeaderTooltip({
    queueStatus,
    showPauseQueueButton,
    showResumeQueueButton,
    resumeRequested,
    keepPausedRequested,
  });

  const header = (
    <div className="flex items-stretch" data-testid="queued-message-header">
      {/* On the collapse trigger, not the header strip: the strip also holds
          Resume/Pause, and a strip-wide trigger surfaced this queue-state text
          while hovering either of those buttons. */}
      <TooltipWrapper
        label={tooltip}
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <CollapsibleTrigger
          className="group/queue flex min-w-0 flex-1 items-center text-left"
          data-testid="queued-message-header-toggle"
          variant="panel"
        >
          <ChevronDown
            aria-hidden
            className={cn(
              "size-3 shrink-0 text-muted-foreground/70 transition-transform",
              open ? null : "-rotate-90",
            )}
          />
          {queueStatus === "running" ? (
            <LivePulse
              size="xs"
              tone="active"
              ariaLabel="Queue running"
              className={undefined}
            />
          ) : null}
          <span className="shrink-0 text-ui-xs font-medium text-foreground/85">
            Message queue
          </span>
          <span
            aria-hidden
            data-testid="queued-message-header-divider"
            className="shrink-0 text-muted-foreground/40"
          >
            ·
          </span>
          <ListOrdered
            className="size-3.5 shrink-0 text-muted-foreground/70"
            data-testid="queued-message-header-status-icon"
            aria-hidden
          />
          <span className="min-w-0 flex-1 truncate text-ui-xs text-muted-foreground">
            {summary}
          </span>
        </CollapsibleTrigger>
      </TooltipWrapper>
      <QueuedMessageQueueControls
        canAct={canAct}
        readOnly={readOnly}
        resumeRequested={resumeRequested}
        keepPausedRequested={keepPausedRequested}
        showResumeQueueButton={showResumeQueueButton}
        showPauseQueueButton={showPauseQueueButton}
        onPause={onPause}
        onResume={onResume}
      />
    </div>
  );

  return header;
}

const QueuedMessageRow = memo(function QueuedMessageRow(props: {
  readonly item: OpenChatQueuedItem;
  readonly index: number;
  readonly orderKey: string;
  readonly queueStatus: ChatSessionState["queue"]["status"];
  /**
   * The "Paused after an error" pill's tooltip, or `null` when the queue is not
   * held because the last turn failed (`queuePausedAfterErrorTooltip`).
   */
  readonly pausedAfterErrorTooltip: string | null;
  readonly canReorder: boolean;
  readonly canAct: boolean;
  readonly readOnly: boolean;
  readonly activeTurnStatus: ChatActiveTurn["status"] | null;
  readonly hasSteerRestartPending: boolean;
  readonly editing: boolean;
  /** A received agent row the user unfolded; meaningless for other rows. */
  readonly expanded: boolean;
  readonly onToggleExpanded: (queueItemId: string) => void;
  readonly dropPreview: QueuedMessageDropPreview | null;
  readonly itemCount: number;
  readonly registerRowElement: (
    queueItemId: string,
    element: HTMLDivElement | null,
  ) => void;
  readonly onEdit: (item: OpenChatQueuedPromptItem) => void;
  readonly onCancel: (item: OpenChatQueuedItem) => void;
  readonly onAbortSteer: (item: OpenChatQueuedPromptItem) => void;
  readonly onSteerNow: (item: OpenChatQueuedPromptItem) => void;
}) {
  const {
    item,
    index,
    orderKey,
    queueStatus,
    pausedAfterErrorTooltip,
    canReorder,
    canAct,
    readOnly,
    activeTurnStatus,
    hasSteerRestartPending,
    editing,
    expanded,
    onToggleExpanded,
    dropPreview,
    itemCount,
    registerRowElement,
    onEdit,
    onCancel,
    onAbortSteer,
    onSteerNow,
  } = props;
  const stages = use(QueuedMessageStagesContext);
  const inFlight = stages.inFlight.get(item.queueItemId) ?? null;
  const optimisticActionId = optimisticQueuedItemClientActionId(
    item.queueItemId,
  );
  const deliveryUnconfirmed =
    optimisticActionId !== null &&
    stages.unconfirmedSendActionIds.has(optimisticActionId);
  const actionState = queuedMessageRowActionState({
    item,
    inFlight,
    queueStatus,
    canReorder,
    canAct,
    readOnly,
    activeTurnStatus,
    hasSteerRestartPending,
  });
  const rowSortable = useQueuedMessageRowSortable({
    queueItemId: item.queueItemId,
    index,
    orderKey,
    disabled: !actionState.canReorder,
  });
  const handleRegisteredRowRef = useCallback(
    (element: HTMLDivElement | null) => {
      registerRowElement(item.queueItemId, element);
    },
    [item.queueItemId, registerRowElement],
  );
  const rowRef = useMemo(
    () =>
      mergeRefs<HTMLDivElement>(rowSortable.setNodeRef, handleRegisteredRowRef),
    [handleRegisteredRowRef, rowSortable.setNodeRef],
  );
  // The prompt-only affordances (edit / steer / abort-steer) close over the
  // narrowed item, so a managed-command row cannot reach them even if a future
  // change accidentally rendered their buttons.
  const promptItem = item.kind === "prompt" ? item : null;
  const handleEdit = useCallback(() => {
    if (promptItem === null) return;
    onEdit(promptItem);
  }, [onEdit, promptItem]);
  const handleCancel = useCallback(() => {
    onCancel(item);
  }, [onCancel, item]);
  const handleSteerNow = useCallback(() => {
    if (promptItem === null) return;
    onSteerNow(promptItem);
  }, [onSteerNow, promptItem]);
  const handleAbortSteer = useCallback(() => {
    if (promptItem === null) return;
    onAbortSteer(promptItem);
  }, [onAbortSteer, promptItem]);
  const receivedAgentResponse = isReceivedAgentResponse(item);
  const handleToggleExpanded = useCallback(() => {
    onToggleExpanded(item.queueItemId);
  }, [onToggleExpanded, item.queueItemId]);
  const editActionCopy = queuedMessageEditActionCopy(item);
  const statusLabel = queuedMessageStatusLabel(
    item,
    pausedAfterErrorTooltip !== null,
    { inFlight, deliveryUnconfirmed, queuePaused: queueStatus === "paused" },
  );
  const statusTooltip = queuedMessageStatusTooltip(item, {
    inFlight,
    pausedAfterErrorTooltip,
  });
  const showDropIndicatorBefore = dropPreview?.index === index;
  const showDropIndicatorAfter = shouldShowDropIndicatorAfter({
    dropPreview,
    itemCount,
    index,
  });
  const chrome = queuedMessageRowChrome({
    promptItem,
    receivedAgentResponse,
    readOnly,
    canAct,
    isLocked: actionState.isLocked,
    mutationInFlight: inFlight !== null,
  });

  return (
    <div
      ref={rowRef}
      style={rowSortable.style}
      className={cn(
        "group relative",
        CHAT_DOCK_PANEL_ROW,
        // The four sibling panels all reveal the row under the pointer; this
        // one is the only list of PROSE, so it needs the fill most and had
        // none (R6H-01).
        // muted-fill-ok: row inside the canvas-surface panel above; --canvas never equals --muted
        "hover:bg-muted/40",
        // The hairline `divide-y` used to draw, moved OUT of flow into the
        // list's `gap-0.5` so it costs no height: a 1px rule per boundary is
        // what broke "N one-line rows measure the same in all five" at every
        // N above one. Two wrapped messages would otherwise be separated by
        // 1.875px while their own lines are 15px apart, and read as one
        // paragraph.
        "before:pointer-events-none before:absolute before:inset-x-2 before:-top-px before:h-px before:bg-border/40 first:before:hidden",
        editing ? "bg-primary/5" : null,
        actionState.isTransient ? "opacity-80" : null,
        rowSortable.isDragSource ? "opacity-50" : null,
      )}
      data-testid="queued-message-row"
      data-editing={editing ? "true" : "false"}
      data-dragging={rowSortable.isDragSource ? "true" : "false"}
      data-drop-target={rowSortable.isDropTarget ? "true" : "false"}
      aria-busy={actionState.isSteering || inFlight !== null}
    >
      <QueuedMessageDropIndicator
        visible={showDropIndicatorBefore}
        edge="top"
      />
      <QueuedMessageDragHandle
        visible={!readOnly}
        disabled={!actionState.canReorder}
        setHandleElement={rowSortable.setActivatorNodeRef}
        listeners={rowSortable.listeners}
      />
      <QueuedMessageRowContent
        item={item}
        statusLabel={statusLabel}
        statusTooltip={statusTooltip}
        actionState={actionState}
        showOwnerActions={chrome.showOwnerActions}
        showManagedCommandCancel={chrome.showManagedCommandCancel}
        canAbortSteer={chrome.canAbortSteer}
        agentFold={
          receivedAgentResponse
            ? { expanded, onToggle: handleToggleExpanded }
            : null
        }
        editActionCopy={editActionCopy}
        handleEdit={handleEdit}
        handleCancel={handleCancel}
        handleAbortSteer={handleAbortSteer}
        handleSteerNow={handleSteerNow}
      />
      <QueuedMessageDropIndicator
        visible={showDropIndicatorAfter}
        edge="bottom"
      />
    </div>
  );
});

function QueuedMessageRowContent(props: {
  readonly item: OpenChatQueuedItem;
  readonly statusLabel: string | null;
  /** Why the status is what it is, where the label alone does not say. */
  readonly statusTooltip: string | null;
  readonly actionState: QueuedMessageRowActionState;
  readonly showOwnerActions: boolean;
  readonly showManagedCommandCancel: boolean;
  readonly canAbortSteer: boolean;
  /**
   * A received agent row's fold (#2441), or `null` for every other row. Such
   * a row is one line until the user clicks its text, because twenty agent
   * replies at three lines each are mostly prose nobody acts on from here.
   */
  readonly agentFold: QueuedMessageRowContentAgentFold | null;
  readonly editActionCopy: { readonly label: string; readonly title: string };
  readonly handleEdit: () => void;
  readonly handleCancel: () => void;
  readonly handleAbortSteer: () => void;
  readonly handleSteerNow: () => void;
}) {
  const item = props.item;
  const framed =
    props.showOwnerActions ||
    props.showManagedCommandCancel ||
    props.canAbortSteer;
  const showFloatingChrome = framed || props.statusLabel !== null;
  const compact = agentFoldCompact(props.agentFold);

  return (
    <div className="min-w-0 flex-1">
      <div
        className={cn(
          // `-my-0.5 py-0.5`: the floated toolbar's frame overhangs its own
          // margin box by `p-0.5` a side (see `QueuedMessageFloatingChrome`),
          // and `overflow-y-auto` clips at the PADDING edge, so without room
          // there the frame's bottom border was cut off. The padding is that
          // room and the negative margin hands it back, so the row measures
          // what it did.
          "-my-0.5 py-0.5 pr-1 wrap-break-word",
          compact ? CONTENT_SCROLL_COMPACT : CONTENT_SCROLL_FULL,
          CHAT_DOCK_PANEL_ROW_TEXT,
        )}
        data-testid="queued-message-content-scroll"
        data-native-scrollbar="true"
        data-compact={String(compact)}
      >
        <QueuedMessageProvenanceChip item={item} />
        {showFloatingChrome ? (
          <QueuedMessageFloatingChrome framed={framed}>
            {props.statusLabel !== null ? (
              <QueuedMessageStatusBadge
                label={props.statusLabel}
                tooltip={props.statusTooltip}
                pulsing={props.actionState.isSteering}
                embedded={framed}
              />
            ) : null}
            {props.showOwnerActions ? (
              <QueuedMessageRowActions
                actionsDisabled={props.actionState.actionsDisabled}
                steerNowDisabled={props.actionState.steerNowDisabled}
                editLabel={props.editActionCopy.label}
                editTitle={props.editActionCopy.title}
                onEdit={props.handleEdit}
                onCancel={props.handleCancel}
                onSteerNow={props.handleSteerNow}
              />
            ) : null}
            {props.showManagedCommandCancel ? (
              <ManagedCommandCancelButton
                kind={item.kind === "port-forward" ? "port-forward" : "shell"}
                onCancel={props.handleCancel}
              />
            ) : null}
            {props.canAbortSteer ? (
              <QueuedMessageAbortSteerButton
                onAbortSteer={props.handleAbortSteer}
              />
            ) : null}
          </QueuedMessageFloatingChrome>
        ) : null}
        <QueuedMessageRowText item={item} agentFold={props.agentFold} />
      </div>
      <QueuedMessageFallbackReason
        item={item}
        pillSaysPausedAfterError={
          props.statusLabel === QUEUE_PAUSED_AFTER_ERROR_LABEL
        }
      />
    </div>
  );
}

/** A row's text at its usual three-line cap. */
const CONTENT_SCROLL_FULL = "max-h-[calc(3lh+--spacing(1))] overflow-y-auto";
/**
 * A folded agent row's text, clipped to its one line; the preview inside
 * ellipsizes that line (`line-clamp-1`) rather than cutting it mid-glyph.
 */
const CONTENT_SCROLL_COMPACT = "max-h-[calc(1lh+--spacing(1))] overflow-hidden";

function agentFoldCompact(
  fold: QueuedMessageRowContentAgentFold | null,
): boolean {
  return fold !== null && !fold.expanded;
}

function QueuedMessageRowText(props: {
  readonly item: OpenChatQueuedItem;
  readonly agentFold: QueuedMessageRowContentAgentFold | null;
}): ReactNode {
  const item = props.item;
  if (item.kind !== "prompt") {
    // Both host-authored items (a shell's update, a forward's interruption)
    // are content-free: the label is all they carry.
    return <span className="text-muted-foreground">{item.description}</span>;
  }
  return (
    <QueuedMessageAgentFoldToggle fold={props.agentFold}>
      <ComposerContentPreview
        content={item.message.content}
        emptyLabel="Queued message"
        testId="queued-message-content-preview"
        className={
          agentFoldCompact(props.agentFold) ? "line-clamp-1" : undefined
        }
      />
    </QueuedMessageAgentFoldToggle>
  );
}

/**
 * The click target that folds and unfolds a received agent row's text, or the
 * text alone for every other row.
 *
 * A `role="button"` div rather than a `<button>`: the preview renders block
 * paragraphs and lists, which a `<button>` may not contain. The floated chip
 * and toolbar stay OUTSIDE it, so the sender badge's tooltip and the row's
 * controls are never part of this control's name or its click.
 */
function QueuedMessageAgentFoldToggle(props: {
  readonly fold: QueuedMessageRowContentAgentFold | null;
  readonly children: ReactNode;
}): ReactNode {
  const fold = props.fold;
  if (fold === null) return props.children;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={fold.expanded}
      className="cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      data-testid="queued-message-agent-fold"
      onClick={fold.onToggle}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        fold.onToggle();
      }}
    >
      {props.children}
    </div>
  );
}

/**
 * The host's queue-wide pause notes: the sentences a pause stamps on every held
 * row that has no reason of its own, and that the "Paused after an error" pill
 * or the routing card already say. The host's text, matched here to be LEFT
 * OUT, never copy this client renders - which is why it lives beside the one
 * comparison rather than in the fallback vocabulary module. The GUI's own
 * copies, because the wire carries no kind for a row's `fallbackReason`: a
 * sentence not listed here is drawn, never dropped.
 *
 * - The errored-turn pause: the host's `ERRORED_TURN_QUEUE_PAUSE_REASON`,
 *   verbatim since #4505 (2026-07-18).
 * - The routing hold: `FALLBACK_HOLD_QUEUE_PAUSE_REASON`, in this wording since
 *   the routing rename (2026-09-27), the same host change that first publishes
 *   `pausedReason`.
 * - The routing hold as hosts from #5608 (2026-09-13) until that rename wrote
 *   it (`LEGACY_FALLBACK_HOLD_QUEUE_PAUSE_REASON`), which a row held across an
 *   upgrade in the middle of a traversal still carries.
 */
const QUEUE_WIDE_PAUSE_HOST_REASONS: ReadonlySet<string> = new Set([
  "Queue paused because the previous turn ended with an error.",
  "Queue paused while routing recovers the failed turn.",
  "Queue paused while the host tries a fallback for the failed turn.",
]);

/**
 * The host's per-row note on why the row is held (`item.fallbackReason`).
 *
 * Omitted only when it says what the pill already says (clutter cuts,
 * 2026-09-27): under a "Paused after an error" pill, a queue-wide pause note -
 * the errored-turn sentence, or the routing hold's while the routing card is
 * on screen saying the same - is stamped on every held row, the same fact once
 * per row. Every other reason is drawn there too - a pause keeps a row's
 * earlier reason (a leftover steer, a downgrade), and a restamp the new
 * provider rejected is stamped under a routing pause - since each says
 * something the pill does not. The wire gives the reason no kind, so the
 * queue-wide notes are recognised by the GUI's own copies of them.
 */
function QueuedMessageFallbackReason(props: {
  readonly item: OpenChatQueuedItem;
  readonly pillSaysPausedAfterError: boolean;
}) {
  if (props.item.kind !== "prompt") return null;
  const reason = props.item.fallbackReason?.trim();
  if (!reason) return null;
  if (
    props.pillSaysPausedAfterError &&
    QUEUE_WIDE_PAUSE_HOST_REASONS.has(reason)
  ) {
    return null;
  }
  return (
    <p className="mt-1 text-ui-xs text-muted-foreground wrap-break-word">
      {reason}
    </p>
  );
}

/**
 * The row's provenance marker, as a chip the message wraps around (L-172).
 *
 * It used to be a line of its own above the message. That made a queue with
 * one received agent response 54.5px against every other one-row panel's
 * 41.25px, so switching the pill from Background to Queue moved the
 * composer's upper edge by 13.25px - three times the jump this ticket was
 * opened for. L-171 exempted the two-line case by fiat; L-172 narrows the
 * exemption, because the exemption did not make the jump go away.
 *
 * A float rather than an inline span, and the mirror of the toolbar floating
 * into the same scroll box from the other side: the message is a block
 * (`ComposerContentPreview` renders paragraphs), so an in-flow inline chip
 * before it would still start the text on a second line. Floated, the text
 * wraps around it and a one-line message stays one line.
 *
 * `max-h-[3lh]` is untouched. A queued message is the user's own text and the
 * one thing in the dock they may need to READ before deciding to edit or
 * cancel it, so the answer to "one line or two" is neither: metadata gives up
 * its line, content keeps its three. A received agent message is the
 * exception (#2441): the user can only reorder it, so it is one line until
 * clicked, and the chip is what that one line leads with.
 */
/** The one badge a queued row's provenance calls for, or `null` for none. */
function queuedMessageProvenanceBadge(item: OpenChatQueuedItem): ReactNode {
  if (isReceivedAgentResponse(item))
    return <ReceivedAgentBadge sender={item.sender} />;
  if (item.kind === "managed-command")
    return (
      <ManagedCommandBadge
        commandId={item.commandId}
        monitoring={item.monitoring}
        hostId={item.hostId}
      />
    );
  if (item.kind === "port-forward") return <PortForwardBadge />;
  return null;
}

function QueuedMessageProvenanceChip(props: {
  readonly item: OpenChatQueuedItem;
}): ReactNode {
  const badge = queuedMessageProvenanceBadge(props.item);
  if (badge === null) return null;
  return (
    <span
      className="float-left mr-1 inline-flex"
      data-testid="queued-message-provenance-chip"
    >
      {badge}
    </span>
  );
}

/**
 * Provenance marker for a pending shell output delivery (a watcher's log
 * digest, a backgrounded shell's completion digest). Distinct tone from
 * `ReceivedAgentBadge` so the two system-owned row kinds stay tellable apart.
 *
 * Also a door (`UI.md` §5): clicking it opens or focuses that shell's output
 * window, so a human who wants to see what the agent is about to read does not
 * have to find the row in the sidebar first. The label names the shell either
 * way; only the glyph waits on the monitor flag, which a delivery queued by an
 * older build does not carry - it gets the neutral terminal glyph rather than a
 * guessed one.
 */
export function ManagedCommandBadge(props: {
  readonly commandId: string;
  readonly monitoring: boolean | null;
  /** The host the shell runs on when it is not this tab's; see the door. */
  readonly hostId: string | null;
}) {
  const openOutput = useManagedCommandDoor();

  return (
    <TooltipWrapper
      label={MANAGED_COMMAND_QUEUED_CHIP_TOOLTIP}
      side="top"
      sideOffset={6}
      align={undefined}
    >
      <button
        type="button"
        className="inline-flex shrink-0 items-center gap-1 rounded-sm border border-border/60 bg-muted/60 px-1.5 py-0.5 text-ui-xs font-medium text-muted-foreground enabled:hover:text-foreground"
        data-testid="queued-managed-command-badge"
        disabled={openOutput === null}
        onClick={() => {
          openOutput?.(props.commandId, props.hostId);
        }}
      >
        {/* An unrecorded flag renders NO glyph: the label already names the
            shell, and the terminal glyph is reserved for the Terminals
            surface (see managed-command-monitor-icon.tsx). */}
        {props.monitoring === null ? null : (
          // Speaks, unlike every row glyph: this chip's label is the constant
          // "Shell output", so nothing else here says whether the shell was
          // watching.
          <ManagedCommandMonitorIcon
            monitoring={props.monitoring}
            decorative={false}
            className={undefined}
          />
        )}
        <span>{MANAGED_COMMAND_OUTPUT_WINDOW_TITLE}</span>
      </button>
    </TooltipWrapper>
  );
}

/**
 * Provenance marker for a port forward's one notification - it went
 * `interrupted` - waiting to reach its agent.
 *
 * NOT a door, which is the whole reason this is its own queue item rather than
 * a shell one under a borrowed key: a shell chip opens that shell's output
 * window, and a forward has none. The forward's own row in the Background
 * panel is where its reason and recent events are.
 */
function PortForwardBadge() {
  return (
    <TooltipWrapper
      label="A port forward was interrupted. The agent is told once, when this is delivered."
      side="top"
      sideOffset={6}
      align={undefined}
    >
      <Badge variant="muted" data-testid="queued-port-forward-badge">
        <Cable aria-hidden />
        Port forward
      </Badge>
    </TooltipWrapper>
  );
}

/**
 * The only affordance a host-authored row offers. For a shell, cancelling is
 * not destructive to the underlying output: the host leaves the delivery
 * cursor where it is, so the next output from that command re-queues a fresh
 * digest. For a forward it IS final - the notice is raised once, so dismissing
 * it means the agent is not told - and the copy says which.
 */
function ManagedCommandCancelButton(props: {
  readonly kind: "shell" | "port-forward";
  readonly onCancel: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex shrink-0">
          <Button
            type="button"
            size="icon-xs"
            variant="muted"
            className="shrink-0"
            aria-label={
              props.kind === "shell"
                ? "Cancel queued command output"
                : "Dismiss port forward notice"
            }
            onClick={props.onCancel}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent sideOffset={6}>
        {props.kind === "shell"
          ? "Skip this delivery — later output still arrives"
          : "Dismiss this notice — the agent won't be told about the interruption"}
      </TooltipContent>
    </Tooltip>
  );
}

function QueuedMessageFloatingChrome(props: {
  readonly children: ReactNode;
  readonly framed: boolean;
}): ReactNode {
  return (
    <div
      className={cn(
        "sticky top-0 z-10 float-right ml-2 flex shrink-0 items-center",
        // `gap-1` rather than `gap-0.5`: the buttons are `size-6`, which is
        // 22.5px at this root, so 3.75px between them puts their centres
        // 26.25px apart and the undersized-target spacing exception is not
        // decided by a third of a pixel (R6H-05).
        //
        // `-my-0.5` pays for `p-0.5` out of the row's own padding: the frame's
        // border box is 28.25px and its MARGIN box is what the float
        // contributes to the message column, so cancelling 1.875px a side
        // brings it to 24.5px, inside the row's 26.25px budget. The frame
        // keeps its padding, which is what holds the buttons off its border.
        props.framed
          ? "-my-0.5 gap-1 rounded-md border border-border/60 bg-background/70 p-0.5 shadow-lg supports-backdrop-filter:bg-background/60"
          : null,
      )}
      data-testid="queued-message-row-toolbar"
    >
      {props.children}
    </div>
  );
}

function shouldShowDropIndicatorAfter(input: {
  readonly dropPreview: QueuedMessageDropPreview | null;
  readonly itemCount: number;
  readonly index: number;
}): boolean {
  return (
    input.dropPreview?.index === input.itemCount &&
    input.index === input.itemCount - 1
  );
}

/**
 * Which of the row's mutually exclusive toolbars is offered. A managed-command
 * row is system-owned like a received A2A row, but it gets its own
 * single-action toolbar (cancel only) rather than the prompt row's
 * edit/delete/steer trio.
 *
 * Only a user-owned safe-point steer still "Waiting for steer" can be
 * un-staged: an interrupt_restart ("Restart pending") has already torn the turn
 * down, and received-agent rows are system-owned. The host re-checks and rejects
 * if the harness began folding the steer in between render and click.
 */
function queuedMessageRowChrome(
  input: QueuedMessageRowChromeInput,
): QueuedMessageRowChrome {
  const { promptItem, readOnly, canAct, isLocked } = input;
  const userOwned = promptItem !== null && !input.receivedAgentResponse;
  return {
    showOwnerActions: userOwned && !readOnly && !isLocked,
    showManagedCommandCancel:
      promptItem === null && !readOnly && canAct && !isLocked,
    canAbortSteer:
      userOwned &&
      !readOnly &&
      canAct &&
      // An abort already on the wire is not offered again: the host would
      // answer the repeat against a row the first one has since changed.
      !input.mutationInFlight &&
      promptItem.status === "steer_requested" &&
      promptItem.steerRequest?.mode === "safe_point",
  };
}

/**
 * Whether the row's own controls are withheld. One unanswered mutation locks
 * it exactly as a host-side steer does: until its ack (or a reconnect) settles
 * it, a second click could only send a second frame against a state this client
 * has not seen yet.
 */
function queuedMessageRowLocked(
  item: OpenChatQueuedItem,
  inFlight: QueueItemInFlight | null,
): boolean {
  return (
    isOptimisticQueuedItem(item) ||
    item.status === "steering" ||
    item.status === "injected" ||
    item.status === "steer_requested" ||
    inFlight !== null
  );
}

function queuedMessageRowActionState(
  input: QueuedMessageRowActionStateInput,
): QueuedMessageRowActionState {
  const isOptimistic = isOptimisticQueuedItem(input.item);
  const isSteering = input.item.status === "steering";
  const isTransient = isSteering || input.item.status === "injected";
  const isLocked = queuedMessageRowLocked(input.item, input.inFlight);
  return {
    canReorder:
      input.canReorder && input.canAct && !input.readOnly && !isLocked,
    isSteering,
    isTransient,
    isLocked,
    actionsDisabled: !input.canAct || input.readOnly || isLocked,
    steerNowDisabled:
      !input.canAct ||
      input.readOnly ||
      input.queueStatus === "paused" ||
      input.activeTurnStatus !== "running" ||
      isOptimistic ||
      input.item.status === "paused" ||
      isTransient ||
      input.hasSteerRestartPending,
  };
}

/**
 * The row's status pill. A paused row says WHY when the queue is held after a
 * failed turn ("Paused after an error") - the transcript draws no separate
 * card for the held queue on a line that sends the reason
 * (`queuePausedNoticeHidden`), so this pill is where it is said (user ruling,
 * 2026-09-26). Any other pause keeps today's "Paused".
 */
export const QUEUED_MESSAGE_SENDING_LABEL = "Sending to host";
export const QUEUED_MESSAGE_UNCONFIRMED_LABEL = "Delivery not confirmed";
export const QUEUED_MESSAGE_NEXT_TURN_LABEL = "Queued for next turn";
export const QUEUED_MESSAGE_WAITING_FOR_PROVIDER_LABEL = "Waiting for provider";

/**
 * The row's status pill, in three tiers that never borrow each other's words.
 *
 * LOCAL: an optimistic row is this client's own dispatch and nothing more -
 * "Sending to host", or "Delivery not confirmed" once it has gone unanswered
 * past the display deadline. Neither claims the host has it.
 *
 * IN FLIGHT: a host-confirmed row with a mutation of its own still unanswered
 * names that mutation, ahead of whatever status the host last reported, because
 * that status is the one the mutation is about to change.
 *
 * HOST-CONFIRMED: everything below, read off the host's item. A plain pending
 * prompt says "Queued for next turn" rather than nothing, so the absence of a
 * pill is never what distinguishes confirmed from local.
 */
function queuedMessageStatusLabel(
  item: OpenChatQueuedItem,
  pausedAfterError: boolean,
  local: {
    readonly inFlight: QueueItemInFlight | null;
    readonly deliveryUnconfirmed: boolean;
    readonly queuePaused: boolean;
  },
): string | null {
  const pausedLabel = pausedAfterError
    ? QUEUE_PAUSED_AFTER_ERROR_LABEL
    : "Paused";
  if (isOptimisticQueuedItem(item)) {
    return local.deliveryUnconfirmed
      ? QUEUED_MESSAGE_UNCONFIRMED_LABEL
      : QUEUED_MESSAGE_SENDING_LABEL;
  }
  if (local.inFlight !== null) return queueItemInFlightLabel(local.inFlight);
  return hostConfirmedStatusLabel(item, pausedLabel, local.queuePaused);
}

/** The host's own account of a row, read off its item and nothing else. */
function hostConfirmedStatusLabel(
  item: OpenChatQueuedItem,
  pausedLabel: string,
  queuePaused: boolean,
): string | null {
  if (item.kind !== "prompt") {
    // Both host-authored kinds (a shell's output, a forward's interruption)
    // speak the DELIVERY vocabulary: nobody steers them, they are delivered.
    // The badge is the row's provenance marker, so an ordinary next-turn
    // pending item needs no additional label. `steering` is the handover
    // window: the digest is being delivered into the running turn, and the
    // cancel lever has closed - the label is what tells the user why the
    // row's controls went away. A pending SAME-TURN item is aimed at the
    // running turn ("Will deliver", the delivery-vocabulary sibling of the
    // received-agent rows' "Will steer"), so the user knows the cancel
    // window is the current turn, not some later one.
    if (item.status === "steering") return "Delivering";
    if (item.status === "paused") return pausedLabel;
    return item.delivery === "same_turn" ? "Will deliver" : null;
  }
  if (item.status === "steer_requested") {
    // The host has taken the steer and is waiting on the provider's next safe
    // point to admit it. Queue acceptance is not provider admission, and the
    // pill says which of the two this row has.
    return item.steerRequest?.mode === "interrupt_restart"
      ? "Restart pending"
      : QUEUED_MESSAGE_WAITING_FOR_PROVIDER_LABEL;
  }
  if (item.status === "steering") return "Steering";
  if (item.status === "injected") return "Embedding";
  if (item.status === "fallback") return "After turn";
  if (item.status === "paused") return pausedLabel;
  if (item.delivery === "same_turn") {
    // Received A2A responses ride the same `same_turn` (steer) delivery as user
    // follow-ups, but they are system-owned and read-only: the user can only
    // reorder them, never hand-steer. "Can steer" reads as a user affordance, so
    // name the automatic behavior instead for received responses.
    return isReceivedAgentResponse(item) ? "Will steer" : "Can steer";
  }
  // A held queue runs nothing next turn, so a pending row in one makes no such
  // promise: the paused rows beside it carry the reason the queue is held.
  return queuePaused ? null : QUEUED_MESSAGE_NEXT_TURN_LABEL;
}

/**
 * When the row reached the stage its pill names, and whose clock says so.
 *
 * A host-confirmed stage is dated from the host's own item (`createdAt`, or the
 * steer request's `requestedAt`). A local stage is dated from this client's
 * dispatch and SAYS it is local, so a time on an unconfirmed row can never be
 * read as the moment the host accepted it.
 */
function queuedMessageStatusTooltip(
  item: OpenChatQueuedItem,
  input: {
    readonly inFlight: QueueItemInFlight | null;
    readonly pausedAfterErrorTooltip: string | null;
  },
): string | null {
  // Ahead of the paused reason, to match the pill: a paused row with an
  // unanswered save says "Saving", and its tooltip has to explain that.
  if (input.inFlight !== null && !isOptimisticQueuedItem(item)) {
    return "Sent from this device. Waiting for the host to answer.";
  }
  if (item.status === "paused") return input.pausedAfterErrorTooltip;
  if (item.kind !== "prompt") return null;
  if (isOptimisticQueuedItem(item)) {
    return `Sent from this device at ${formatClockTime(item.createdAt)}. The host has not confirmed it yet.`;
  }
  if (item.status === "steer_requested" && item.steerRequest !== null) {
    return `The host requested the steer at ${formatClockTime(item.steerRequest.requestedAt)}.`;
  }
  if (item.status === "pending" && item.delivery === "next_turn") {
    return `Queued on the host at ${formatClockTime(item.createdAt)}.`;
  }
  return null;
}

function QueuedMessageStatusBadge(props: {
  readonly label: string;
  /** The reason behind the label, on hover and focus; `null` for none. */
  readonly tooltip: string | null;
  readonly pulsing: boolean;
  readonly embedded: boolean;
}) {
  // `TooltipWrapper` degrades to a plain Slot on a `null` label, so the badge
  // is the same element with or without a reason.
  return (
    <TooltipWrapper
      label={props.tooltip}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <span
        data-testid="queued-message-status-badge"
        // Focusable only when there is a reason to reveal, so keyboard users
        // reach the tooltip without every pill becoming a tab stop.
        tabIndex={props.tooltip === null ? undefined : 0}
        className={cn(
          "inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-ui-xs font-medium text-muted-foreground",
          props.embedded ? null : "border border-border/60 bg-background/70",
        )}
      >
        {props.pulsing ? (
          <LivePulse
            size="xs"
            tone="active"
            ariaLabel={`${props.label} queued message`}
            className={undefined}
          />
        ) : null}
        {props.label}
      </span>
    </TooltipWrapper>
  );
}

/**
 * Trailing marker for a received A2A response in the queue. It replaces the
 * edit/delete/steer actions a user-typed row carries, making clear the row is
 * read-only (reorder only) and naming the agent it came from.
 */
function ReceivedAgentBadge(props: {
  readonly sender: Extract<
    OpenChatQueuedPromptItem["sender"],
    { type: "agent" }
  >;
}) {
  const name =
    props.sender.displayName !== null && props.sender.displayName.length > 0
      ? props.sender.displayName
      : `${props.sender.agentId.slice(0, 8)}…`;
  return (
    <TooltipWrapper
      label={`Response received from ${name}`}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <span
        className="inline-flex shrink-0 items-center gap-1 rounded-sm border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-ui-xs font-medium text-primary"
        data-testid="queued-message-sender-badge"
      >
        <Inbox className="size-3" aria-hidden />
        <span className="max-w-[8rem] truncate">{name}</span>
      </span>
    </TooltipWrapper>
  );
}

function queuedMessageEditActionCopy(
  item: OpenChatQueuedItem,
): QueuedMessageEditActionCopy {
  if (item.kind !== "prompt" || item.delivery !== "same_turn") {
    return {
      label: "Edit queued message",
      title: "Edit queued message",
    };
  }
  return {
    label: "Move queued message to composer",
    title:
      "Removes this follow-up from the queue and loads it into the composer",
  };
}

function QueuedMessageDragHandle({
  visible,
  disabled,
  setHandleElement,
  listeners,
}: {
  readonly visible: boolean;
  readonly disabled: boolean;
  readonly setHandleElement: (element: HTMLElement | null) => void;
  readonly listeners: DraggableSyntheticListeners;
}) {
  if (!visible) return null;
  if (disabled) {
    return (
      <span
        aria-hidden
        data-testid="queued-message-drag-handle"
        data-disabled="true"
        className="inline-flex size-6 shrink-0 self-start cursor-not-allowed items-center justify-center rounded-sm text-muted-foreground/40"
      >
        <GripVertical className="size-3.5" />
      </span>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* AX7, one surface over. dnd-kit's `attributes` were spread here, and
            they advertise a keyboard gesture this surface does not implement:
            `aria-roledescription="sortable"` plus an `aria-describedby`
            pointing at "press the space bar to lift". `useSensors` registers
            `PointerSensor` ONLY, so space and the arrow keys did nothing, on a
            control that was in the tab order and named itself as draggable.

            Registering `KeyboardSensor` was the other resolution and it is not
            available here - not without redesigning the reorder hook. A
            keyboard drag carries no `pointerCoordinates`, so
            `queued-message-reorder-dnd.ts` resolves NO drop preview (its own
            doc comment says exactly this), and `handleDragEnd` calls
            `onReorder` only when a preview exists. Adding the sensor would turn
            a false advertisement into a lift-move-drop that silently reorders
            nothing, which is worse. Making that work means an index-based
            preview path for keyboard drags, replacing the pointer-midline
            math - a change to that hook's core, not to this handle.

            So: pointer listeners only, out of the accessibility tree and out of
            the tab order, which is what the `disabled` branch above already
            does. Nothing is taken away - there is no keyboard reorder path on
            this surface today either, and this stops claiming one. That gap is
            real and is reported separately; it is a product decision, not an
            attribute. */}
        <span
          ref={setHandleElement}
          {...listeners}
          aria-hidden
          className={cn(
            "inline-flex size-6 shrink-0 self-start cursor-grab items-center justify-center rounded-sm text-muted-foreground transition-colors",
            "hover:bg-muted hover:text-foreground active:cursor-grabbing",
          )}
          data-testid="queued-message-drag-handle"
        >
          <GripVertical className="size-3.5" />
        </span>
      </TooltipTrigger>
      <TooltipContent sideOffset={6}>Drag to reorder</TooltipContent>
    </Tooltip>
  );
}

function QueuedMessageDropIndicator(props: {
  readonly visible: boolean;
  readonly edge: "top" | "bottom";
}) {
  if (!props.visible) return null;
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute right-2 left-2 z-20",
        props.edge === "top" ? "top-0" : "bottom-0",
      )}
    >
      <DropLine
        orientation="horizontal"
        glow
        className="w-full"
        testId="queued-message-drop-indicator"
      />
    </span>
  );
}

/**
 * Un-stage affordance for a steer still "Waiting for steer". It replaces the
 * full edit/delete/steer toolbar (hidden once a row is steer-locked) with a
 * single revert control that returns the prompt to the queue as a plain pending
 * item.
 */
function QueuedMessageAbortSteerButton(props: {
  readonly onAbortSteer: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex shrink-0">
          <Button
            type="button"
            size="icon-xs"
            variant="muted"
            className="shrink-0"
            aria-label="Cancel steer"
            onClick={props.onAbortSteer}
          >
            <Undo2 className="size-3.5" />
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent sideOffset={6}>
        Cancel steer — return to queue
      </TooltipContent>
    </Tooltip>
  );
}

function QueuedMessageRowActions(props: {
  readonly actionsDisabled: boolean;
  readonly steerNowDisabled: boolean;
  readonly editLabel: string;
  readonly editTitle: string;
  readonly onEdit: () => void;
  readonly onCancel: () => void;
  readonly onSteerNow: () => void;
}) {
  return (
    <div className="ml-auto flex shrink-0 items-center justify-end gap-0.5">
      <span className="flex shrink-0 items-center gap-0.5">
        <TooltipWrapper
          label={props.editTitle}
          side="top"
          sideOffset={6}
          align={undefined}
        >
          <Button
            type="button"
            size="icon-xs"
            variant="muted"
            className="shrink-0"
            disabled={props.actionsDisabled}
            aria-label={props.editLabel}
            onClick={props.onEdit}
          >
            <Pencil className="size-3.5" />
          </Button>
        </TooltipWrapper>
        <TooltipWrapper
          label="Delete queued message"
          side="top"
          sideOffset={6}
          align={undefined}
        >
          <Button
            type="button"
            size="icon-xs"
            variant="muted"
            className="shrink-0"
            disabled={props.actionsDisabled}
            aria-label="Delete queued message"
            onClick={props.onCancel}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </TooltipWrapper>
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex shrink-0">
            <Button
              type="button"
              size="icon-xs"
              variant="muted"
              className="shrink-0"
              disabled={props.steerNowDisabled}
              aria-label="Steer queued message now"
              onClick={props.onSteerNow}
            >
              <SendHorizontal className="size-3.5" />
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent sideOffset={6}>Steer queued message now</TooltipContent>
      </Tooltip>
    </div>
  );
}
