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
  Pencil,
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
import type {
  ChatActiveTurn,
  ChatQueuedItem,
} from "@traycer/protocol/host/agent/gui/subscribe";
import { QueuedMessageContentPreview } from "@/components/chat/queued-message-content-preview";
import { isReceivedAgentResponse } from "@/components/chat/chat-queue-utils";
import {
  QUEUED_MESSAGE_DND_MODIFIERS,
  useQueuedMessageReorderDnd,
  useQueuedMessageRowSortable,
  type QueuedMessageDropPreview,
} from "@/components/chat/queued-message-reorder-dnd";
import { queueItemSteerLocked } from "@/components/chat/queued-message-utils";
import type { ChatSessionState } from "@/stores/chats/chat-session-store";
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
  readonly onResume: () => string | null;
  readonly onEdit: (item: ChatQueuedItem) => void;
  readonly onCancel: (item: ChatQueuedItem) => void;
  readonly onAbortSteer: (item: ChatQueuedItem) => void;
  readonly onReorder: (
    item: ChatQueuedItem,
    beforeQueueItemId: string | null,
  ) => void;
  readonly onSteerNow: (item: ChatQueuedItem) => void;
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
        canAct={props.canAct}
        readOnly={props.readOnly}
        onResume={props.onResume}
      />
      <CollapsibleContent>
        <div
          data-testid="queued-message-list"
          className={cn(
            "overflow-y-auto border-t border-border/50 chat-scrollbar-native-thin",
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

function queueHeaderTooltip(
  queueStatus: ChatSessionState["queue"]["status"],
): string | null {
  if (queueStatus === "running") {
    return "Queued prompts run after the active turn unless a frozen row is being steered into it";
  }
  if (queueStatus === "paused") {
    return "Resume to continue sending queued messages";
  }
  return null;
}

function QueuedMessageHeader(props: {
  readonly open: boolean;
  readonly count: number;
  readonly queueStatus: ChatSessionState["queue"]["status"];
  readonly canAct: boolean;
  readonly readOnly: boolean;
  readonly onResume: () => string | null;
}) {
  const { count, queueStatus, canAct, readOnly, onResume, open } = props;
  const handleResume = useCallback(() => {
    onResume();
  }, [onResume]);
  const tooltip = queueHeaderTooltip(queueStatus);

  const header = (
    <div
      className="flex items-stretch"
      data-testid="queued-message-header"
      title={tooltip ?? undefined}
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
      {readOnly ? (
        <span className="flex shrink-0 items-center px-3 text-ui-xs text-muted-foreground">
          Owner manages queue
        </span>
      ) : null}
      {queueStatus === "paused" && !readOnly ? (
        <div className="flex shrink-0 items-center pr-1.5">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 shrink-0 px-2 text-ui-xs"
            disabled={!canAct}
            onClick={handleResume}
            data-testid="resume-queue-button"
          >
            Resume
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
  readonly onEdit: (item: ChatQueuedItem) => void;
  readonly onCancel: (item: ChatQueuedItem) => void;
  readonly onAbortSteer: (item: ChatQueuedItem) => void;
  readonly onSteerNow: (item: ChatQueuedItem) => void;
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
  const handleEdit = useCallback(() => {
    onEdit(item);
  }, [onEdit, item]);
  const handleCancel = useCallback(() => {
    onCancel(item);
  }, [onCancel, item]);
  const handleSteerNow = useCallback(() => {
    onSteerNow(item);
  }, [onSteerNow, item]);
  const handleAbortSteer = useCallback(() => {
    onAbortSteer(item);
  }, [onAbortSteer, item]);
  const editActionCopy = queuedMessageEditActionCopy(item);
  const statusLabel = queuedMessageStatusLabel(item);
  const showDropIndicatorBefore = dropPreview?.index === index;
  const showDropIndicatorAfter = shouldShowDropIndicatorAfter({
    dropPreview,
    itemCount,
    index,
  });
  const receivedAgentResponse = isReceivedAgentResponse(item);
  const showOwnerActions =
    !receivedAgentResponse && !readOnly && !actionState.isLocked;
  // Only a user-owned safe-point steer still "Waiting for steer" can be
  // un-staged: an interrupt_restart ("Restart pending") has already torn the
  // turn down, and received-agent rows are system-owned. The host re-checks and
  // rejects if the harness began folding the steer in between render and click.
  const canAbortSteer =
    !receivedAgentResponse &&
    !readOnly &&
    canAct &&
    item.status === "steer_requested" &&
    item.steerRequest?.mode === "safe_point";

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
        showOwnerActions={showOwnerActions}
        canAbortSteer={canAbortSteer}
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
  readonly canAbortSteer: boolean;
  readonly editActionCopy: { readonly label: string; readonly title: string };
  readonly handleEdit: () => void;
  readonly handleCancel: () => void;
  readonly handleAbortSteer: () => void;
  readonly handleSteerNow: () => void;
}) {
  const receivedAgentItem = isReceivedAgentResponse(props.item)
    ? props.item
    : null;
  const showFloatingChrome =
    props.showOwnerActions || props.canAbortSteer || props.statusLabel !== null;

  return (
    <div className="min-w-0 flex-1">
      {receivedAgentItem !== null ? (
        <div className="mb-1 flex min-w-0 flex-wrap items-center gap-1">
          <ReceivedAgentBadge sender={receivedAgentItem.sender} />
        </div>
      ) : null}
      <div
        className="max-h-[3lh] overflow-y-auto pr-1 text-ui-sm leading-5 wrap-break-word chat-scrollbar-native-thin"
        data-testid="queued-message-content-scroll"
      >
        {showFloatingChrome ? (
          <QueuedMessageFloatingChrome
            framed={props.showOwnerActions || props.canAbortSteer}
          >
            {props.statusLabel !== null ? (
              <QueuedMessageStatusBadge
                label={props.statusLabel}
                pulsing={props.actionState.isSteering}
                embedded={props.showOwnerActions || props.canAbortSteer}
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
            {props.canAbortSteer ? (
              <QueuedMessageAbortSteerButton
                onAbortSteer={props.handleAbortSteer}
              />
            ) : null}
          </QueuedMessageFloatingChrome>
        ) : null}
        <QueuedMessageContentPreview content={props.item.message.content} />
      </div>
    </div>
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
          ariaLabel="Steering queued message"
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
  readonly sender: Extract<ChatQueuedItem["sender"], { type: "agent" }>;
}) {
  const name =
    props.sender.displayName !== null && props.sender.displayName.length > 0
      ? props.sender.displayName
      : `${props.sender.agentId.slice(0, 8)}…`;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-sm border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-ui-xs font-medium text-primary"
      title={`Response received from ${name}`}
    >
      <Inbox className="size-3" aria-hidden />
      <span className="max-w-[8rem] truncate">{name}</span>
    </span>
  );
}

function queuedMessageEditActionCopy(
  item: ChatQueuedItem,
): QueuedMessageEditActionCopy {
  if (item.delivery !== "same_turn") {
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
            title="Cancel steer"
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
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-7 shrink-0 text-muted-foreground"
          disabled={props.actionsDisabled}
          aria-label={props.editLabel}
          title={props.editTitle}
          onClick={props.onEdit}
        >
          <Pencil className="size-3.5" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-7 shrink-0 text-muted-foreground"
          disabled={props.actionsDisabled}
          aria-label="Delete queued message"
          title="Delete queued message"
          onClick={props.onCancel}
        >
          <Trash2 className="size-3.5" />
        </Button>
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
              title="Steer queued message now"
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
