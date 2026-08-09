import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DraggableAttributes,
  type DraggableSyntheticListeners,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
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
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
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
  ChatQueuedItem,
  ChatQueuedPromptItem,
} from "@traycer/protocol/host/agent/gui/subscribe";
import { ComposerContentPreview } from "@/components/chat/composer/composer-content-preview";
import { isReceivedAgentResponse } from "@/components/chat/chat-queue-utils";
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
import { isOptimisticQueuedItem } from "@/stores/chats/optimistic-queue";
import { mergeRefs } from "@/lib/merge-refs";
import { cn } from "@/lib/utils";

interface QueuedMessageRowActionState {
  readonly canReorder: boolean;
  readonly isSteering: boolean;
  readonly isTransient: boolean;
  readonly isLocked: boolean;
  readonly actionsDisabled: boolean;
  readonly steerNowDisabled: boolean;
}

interface QueuedMessageRowActionStateInput {
  readonly item: ChatQueuedItem;
  readonly queueStatus: ChatSessionState["queue"]["status"];
  readonly canReorder: boolean;
  readonly canAct: boolean;
  readonly readOnly: boolean;
  readonly activeTurnStatus: ChatActiveTurn["status"] | null;
  readonly hasSteerInFlight: boolean;
}

interface QueuedMessageRowChrome {
  readonly showOwnerActions: boolean;
  readonly showManagedCommandCancel: boolean;
  readonly canAbortSteer: boolean;
}

interface QueuedMessageRowChromeInput {
  readonly promptItem: ChatQueuedPromptItem | null;
  readonly receivedAgentResponse: boolean;
  readonly readOnly: boolean;
  readonly canAct: boolean;
  readonly isLocked: boolean;
}

interface QueuedMessageEditActionCopy {
  readonly label: string;
  readonly title: string;
}

export interface QueuedMessagePanelProps {
  readonly queue: ChatSessionState["queue"];
  readonly activeTurnStatus: ChatActiveTurn["status"] | null;
  readonly canAct: boolean;
  readonly readOnly: boolean;
  readonly editingQueueItemId: string | null;
  readonly scrollRegionMaxHeightClass: string;
  readonly separated?: boolean;
  readonly onPause: () => string | null;
  readonly onResume: () => string | null;
  // Edit / steer are prompt-only by type: a managed-command item carries no
  // message to load into the composer and is never hand-steerable, so the
  // compiler - not a runtime guard - is what keeps it out of these paths.
  // Cancel and reorder stay on the union: both key off `queueItemId` alone and
  // both are offered for managed-command items.
  readonly onEdit: (item: ChatQueuedPromptItem) => void;
  readonly onCancel: (item: ChatQueuedItem) => void;
  readonly onAbortSteer: (item: ChatQueuedPromptItem) => void;
  readonly onReorder: (
    item: ChatQueuedItem,
    beforeQueueItemId: string | null,
  ) => void;
  readonly onSteerNow: (item: ChatQueuedPromptItem) => void;
}

function queueItemAllowsReorder(item: ChatQueuedItem): boolean {
  return !queueItemSteerLocked(item) && item.status !== "injected";
}

export function QueuedMessagePanel(props: QueuedMessagePanelProps) {
  const [open, setOpen] = useState(true);
  // Render the queue in its true order, user-typed and received A2A items
  // alike. Received items render read-only (see QueuedMessageRow) - the user
  // can reorder them but cannot edit, delete, or hand-steer them.
  const items = props.queue.items;
  const reorderableCount = useMemo(
    () => items.filter(queueItemAllowsReorder).length,
    [items],
  );
  const queueStatus = props.queue.status;
  const hasSteerInFlight = useMemo(
    () => items.some((item) => queueItemSteerLocked(item)),
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

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      data-testid="queued-message-rows"
      className={cn(
        "@container bg-muted/30",
        props.separated === true ? "border-t border-border/50" : null,
        props.readOnly ? "opacity-95" : null,
      )}
    >
      <QueuedMessageHeader
        open={open}
        count={items.length}
        queueStatus={queueStatus}
        canPauseQueue={hasPausableHumanItems}
        canResumeQueue={hasPausedItems}
        canAct={props.canAct}
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
              <div className="flex flex-col divide-y divide-border/40">
                {items.map((item, index) => {
                  return (
                    <QueuedMessageRow
                      key={item.queueItemId}
                      item={item}
                      index={index}
                      orderKey={reorderDnd.orderKey}
                      queueStatus={queueStatus}
                      canReorder={reorderableCount > 1}
                      canAct={props.canAct}
                      readOnly={props.readOnly}
                      activeTurnStatus={props.activeTurnStatus}
                      hasSteerInFlight={hasSteerInFlight}
                      editing={props.editingQueueItemId === item.queueItemId}
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
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function queueHeaderTooltip(input: {
  readonly queueStatus: ChatSessionState["queue"]["status"];
  readonly showPauseQueueButton: boolean;
  readonly showResumeQueueButton: boolean;
}): string | null {
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

function QueuedMessageHeader(props: {
  readonly open: boolean;
  readonly count: number;
  readonly queueStatus: ChatSessionState["queue"]["status"];
  readonly canPauseQueue: boolean;
  readonly canResumeQueue: boolean;
  readonly canAct: boolean;
  readonly readOnly: boolean;
  readonly onPause: () => string | null;
  readonly onResume: () => string | null;
}) {
  const {
    count,
    queueStatus,
    canPauseQueue,
    canResumeQueue,
    canAct,
    readOnly,
    onPause,
    onResume,
    open,
  } = props;
  const handlePause = useCallback(() => {
    onPause();
  }, [onPause]);
  const handleResume = useCallback(() => {
    onResume();
  }, [onResume]);
  const showResumeQueueButton = canResumeQueue && !readOnly;
  const showPauseQueueButton =
    !showResumeQueueButton && canPauseQueue && !readOnly;
  const tooltip = queueHeaderTooltip({
    queueStatus,
    showPauseQueueButton,
    showResumeQueueButton,
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
          className="group/queue flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          data-testid="queued-message-header-toggle"
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
            Message Queue
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
            {count === 1 ? "1 message" : `${count} messages`}
          </span>
        </CollapsibleTrigger>
      </TooltipWrapper>
      {readOnly ? (
        <span className="flex shrink-0 items-center px-3 text-ui-xs text-muted-foreground">
          Owner manages queue
        </span>
      ) : null}
      {showResumeQueueButton ? (
        <div className="flex shrink-0 items-center pr-1.5">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 shrink-0 gap-1.5 px-2 text-ui-xs"
            disabled={!canAct}
            onClick={handleResume}
            data-testid="resume-queue-button"
          >
            <Play className="size-3.5" />
            Resume
          </Button>
        </div>
      ) : null}
      {showPauseQueueButton ? (
        <div className="flex shrink-0 items-center pr-1.5">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 shrink-0 gap-1.5 px-2 text-ui-xs"
            disabled={!canAct}
            onClick={handlePause}
            data-testid="pause-queue-button"
          >
            <Pause className="size-3.5" />
            Pause
          </Button>
        </div>
      ) : null}
    </div>
  );

  return header;
}

const QueuedMessageRow = memo(function QueuedMessageRow(props: {
  readonly item: ChatQueuedItem;
  readonly index: number;
  readonly orderKey: string;
  readonly queueStatus: ChatSessionState["queue"]["status"];
  readonly canReorder: boolean;
  readonly canAct: boolean;
  readonly readOnly: boolean;
  readonly activeTurnStatus: ChatActiveTurn["status"] | null;
  readonly hasSteerInFlight: boolean;
  readonly editing: boolean;
  readonly dropPreview: QueuedMessageDropPreview | null;
  readonly itemCount: number;
  readonly registerRowElement: (
    queueItemId: string,
    element: HTMLDivElement | null,
  ) => void;
  readonly onEdit: (item: ChatQueuedPromptItem) => void;
  readonly onCancel: (item: ChatQueuedItem) => void;
  readonly onAbortSteer: (item: ChatQueuedPromptItem) => void;
  readonly onSteerNow: (item: ChatQueuedPromptItem) => void;
}) {
  const {
    item,
    index,
    orderKey,
    queueStatus,
    canReorder,
    canAct,
    readOnly,
    activeTurnStatus,
    hasSteerInFlight,
    editing,
    dropPreview,
    itemCount,
    registerRowElement,
    onEdit,
    onCancel,
    onAbortSteer,
    onSteerNow,
  } = props;
  const actionState = queuedMessageRowActionState({
    item,
    queueStatus,
    canReorder,
    canAct,
    readOnly,
    activeTurnStatus,
    hasSteerInFlight,
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
  const editActionCopy = queuedMessageEditActionCopy(item);
  const statusLabel = queuedMessageStatusLabel(item);
  const showDropIndicatorBefore = dropPreview?.index === index;
  const showDropIndicatorAfter = shouldShowDropIndicatorAfter({
    dropPreview,
    itemCount,
    index,
  });
  const chrome = queuedMessageRowChrome({
    promptItem,
    receivedAgentResponse: isReceivedAgentResponse(item),
    readOnly,
    canAct,
    isLocked: actionState.isLocked,
  });

  return (
    <div
      ref={rowRef}
      style={rowSortable.style}
      className={cn(
        "group relative flex min-w-0 items-start gap-2 px-3 py-1.5",
        editing ? "bg-primary/5" : null,
        actionState.isTransient ? "opacity-80" : null,
        rowSortable.isDragSource ? "opacity-50" : null,
      )}
      data-testid="queued-message-row"
      data-editing={editing ? "true" : "false"}
      data-dragging={rowSortable.isDragSource ? "true" : "false"}
      data-drop-target={rowSortable.isDropTarget ? "true" : "false"}
      aria-busy={actionState.isSteering}
    >
      <QueuedMessageDropIndicator
        visible={showDropIndicatorBefore}
        edge="top"
      />
      <QueuedMessageDragHandle
        visible={!readOnly}
        disabled={!actionState.canReorder}
        setHandleElement={rowSortable.setActivatorNodeRef}
        attributes={rowSortable.attributes}
        listeners={rowSortable.listeners}
      />
      <QueuedMessageRowContent
        item={item}
        statusLabel={statusLabel}
        actionState={actionState}
        showOwnerActions={chrome.showOwnerActions}
        showManagedCommandCancel={chrome.showManagedCommandCancel}
        canAbortSteer={chrome.canAbortSteer}
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
  readonly item: ChatQueuedItem;
  readonly statusLabel: string | null;
  readonly actionState: QueuedMessageRowActionState;
  readonly showOwnerActions: boolean;
  readonly showManagedCommandCancel: boolean;
  readonly canAbortSteer: boolean;
  readonly editActionCopy: { readonly label: string; readonly title: string };
  readonly handleEdit: () => void;
  readonly handleCancel: () => void;
  readonly handleAbortSteer: () => void;
  readonly handleSteerNow: () => void;
}) {
  const item = props.item;
  const receivedAgentItem = isReceivedAgentResponse(item) ? item : null;
  const framed =
    props.showOwnerActions ||
    props.showManagedCommandCancel ||
    props.canAbortSteer;
  const showFloatingChrome = framed || props.statusLabel !== null;

  return (
    <div className="min-w-0 flex-1">
      {receivedAgentItem !== null ? (
        <div className="mb-1 flex min-w-0 flex-wrap items-center gap-1">
          <ReceivedAgentBadge sender={receivedAgentItem.sender} />
        </div>
      ) : null}
      {item.kind === "managed-command" ? (
        <div className="mb-1 flex min-w-0 flex-wrap items-center gap-1">
          <ManagedCommandBadge
            commandId={item.commandId}
            monitoring={item.monitoring}
          />
        </div>
      ) : null}
      <div
        className="max-h-[3lh] overflow-y-auto pr-1 text-ui-sm leading-5 wrap-break-word"
        data-testid="queued-message-content-scroll"
        data-native-scrollbar="true"
      >
        {showFloatingChrome ? (
          <QueuedMessageFloatingChrome framed={framed}>
            {props.statusLabel !== null ? (
              <QueuedMessageStatusBadge
                label={props.statusLabel}
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
              <ManagedCommandCancelButton onCancel={props.handleCancel} />
            ) : null}
            {props.canAbortSteer ? (
              <QueuedMessageAbortSteerButton
                onAbortSteer={props.handleAbortSteer}
              />
            ) : null}
          </QueuedMessageFloatingChrome>
        ) : null}
        {item.kind === "managed-command" ? (
          <span className="text-muted-foreground">{item.description}</span>
        ) : (
          <ComposerContentPreview
            content={item.message.content}
            emptyLabel="Queued message"
            testId="queued-message-content-preview"
            className={undefined}
          />
        )}
      </div>
    </div>
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
          openOutput?.(props.commandId);
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
 * The only affordance a managed-command row offers. Cancelling is not
 * destructive to the underlying output: the host leaves the delivery cursor
 * where it is, so the next output from that command re-queues a fresh digest.
 */
function ManagedCommandCancelButton(props: { readonly onCancel: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex shrink-0">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7 shrink-0 text-muted-foreground"
            aria-label="Cancel queued command output"
            onClick={props.onCancel}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent sideOffset={6}>
        Skip this delivery — later output still arrives
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
        "sticky top-0 z-10 float-right ml-2 mb-1 flex shrink-0 items-center",
        props.framed
          ? "gap-1 rounded-md border border-border/60 bg-background/70 p-0.5 shadow-lg backdrop-blur-md supports-backdrop-filter:bg-background/60"
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
      promptItem.status === "steer_requested" &&
      promptItem.steerRequest?.mode === "safe_point",
  };
}

function queuedMessageRowActionState(
  input: QueuedMessageRowActionStateInput,
): QueuedMessageRowActionState {
  const isOptimistic = isOptimisticQueuedItem(input.item);
  const isSteering = input.item.status === "steering";
  const isTransient = isSteering || input.item.status === "injected";
  const isLocked =
    isOptimistic || isTransient || input.item.status === "steer_requested";
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
      input.hasSteerInFlight,
  };
}

function queuedMessageStatusLabel(item: ChatQueuedItem): string | null {
  if (isOptimisticQueuedItem(item)) return "Queuing";
  if (item.kind === "managed-command") {
    // The badge is the row's provenance marker, so an ordinary next-turn
    // pending item needs no additional label. `steering` is the handover
    // window: the digest is being delivered into the running turn, and the
    // cancel lever has closed - the label is what tells the user why the
    // row's controls went away. A pending SAME-TURN item is aimed at the
    // running turn ("Will deliver", the delivery-vocabulary sibling of the
    // received-agent rows' "Will steer"), so the user knows the cancel
    // window is the current turn, not some later one.
    if (item.status === "steering") return "Delivering";
    if (item.status === "paused") return "Paused";
    return item.delivery === "same_turn" ? "Will deliver" : null;
  }
  if (item.status === "steer_requested") {
    return item.steerRequest?.mode === "interrupt_restart"
      ? "Restart pending"
      : "Waiting for steer";
  }
  if (item.status === "steering") return "Steering";
  if (item.status === "injected") return "Embedding";
  if (item.status === "fallback") return "After turn";
  if (item.status === "paused") return "Paused";
  if (item.delivery === "same_turn") {
    // Received A2A responses ride the same `same_turn` (steer) delivery as user
    // follow-ups, but they are system-owned and read-only: the user can only
    // reorder them, never hand-steer. "Can steer" reads as a user affordance, so
    // name the automatic behavior instead for received responses.
    return isReceivedAgentResponse(item) ? "Will steer" : "Can steer";
  }
  return null;
}

function QueuedMessageStatusBadge(props: {
  readonly label: string;
  readonly pulsing: boolean;
  readonly embedded: boolean;
}) {
  return (
    <span
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
  );
}

/**
 * Trailing marker for a received A2A response in the queue. It replaces the
 * edit/delete/steer actions a user-typed row carries, making clear the row is
 * read-only (reorder only) and naming the agent it came from.
 */
function ReceivedAgentBadge(props: {
  readonly sender: Extract<ChatQueuedPromptItem["sender"], { type: "agent" }>;
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
  item: ChatQueuedItem,
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
  attributes,
  listeners,
}: {
  readonly visible: boolean;
  readonly disabled: boolean;
  readonly setHandleElement: (element: HTMLElement | null) => void;
  readonly attributes: DraggableAttributes;
  readonly listeners: DraggableSyntheticListeners;
}) {
  if (!visible) return null;
  if (disabled) {
    return (
      <span
        aria-hidden
        data-testid="queued-message-drag-handle"
        data-disabled="true"
        className="inline-flex size-7 shrink-0 cursor-not-allowed items-center justify-center rounded-sm text-muted-foreground/40"
      >
        <GripVertical className="size-3.5" />
      </span>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          ref={setHandleElement}
          type="button"
          {...attributes}
          {...listeners}
          className={cn(
            "inline-flex size-7 shrink-0 cursor-grab items-center justify-center rounded-sm text-muted-foreground transition-colors",
            "hover:bg-muted hover:text-foreground focus-visible:border focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:cursor-grabbing",
          )}
          aria-label="Drag to reorder queued message"
          data-testid="queued-message-drag-handle"
        >
          <GripVertical className="size-3.5" aria-hidden />
        </button>
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
        "pointer-events-none absolute right-3 left-3 z-20",
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
            size="icon"
            variant="ghost"
            className="size-7 shrink-0 text-muted-foreground"
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
            size="icon"
            variant="ghost"
            className="size-7 shrink-0 text-muted-foreground"
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
            size="icon"
            variant="ghost"
            className="size-7 shrink-0 text-muted-foreground"
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
              size="icon"
              variant="ghost"
              className="size-7 shrink-0 text-muted-foreground"
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
