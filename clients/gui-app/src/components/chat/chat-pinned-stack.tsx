import {
  ArrowRightCircle,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  ListChecks,
  XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { PinnedTodoSnapshot } from "@/components/chat/chat-pinned-todos";
import { LivePulse } from "@/components/ui/live-pulse";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  STATUS_ICON_TONE,
  STATUS_TEXT_TONE,
} from "@/lib/chat/todo-status-tones";
import { cn } from "@/lib/utils";
import { useChatDockSectionAttached } from "@/components/chat/chat-dock-compact-context";
import { ChatDockAttachedPanelBody } from "@/components/chat/chat-dock-attached-panel";
import {
  CHAT_DOCK_PANEL_LIST,
  CHAT_DOCK_PANEL_ROW,
  CHAT_DOCK_PANEL_ROW_TEXT,
} from "@/components/chat/chat-dock-panel-row";
import type { SegmentTodoItem } from "@/stores/composer/chat-store";

export type ChatLowerSurfaceTopSpacing = "normal" | "connected";
export type ChatPinnedStackTopSpacing = "normal" | "compact";

interface TodoCounts {
  readonly completed: number;
  readonly cancelled: number;
  readonly pending: number;
  readonly inProgress: number;
  readonly total: number;
}

export function PinnedTodoPanel(props: {
  readonly todo: PinnedTodoSnapshot;
  readonly scrollRegionMaxHeightClass: string;
  /** A hairline above this panel, because a sibling drew before it in the
   *  dock's shared frame (L-97). */
  readonly separated: boolean;
}) {
  const { todo } = props;
  // Attached above the composer because its pill is the open one (L-142).
  const attached = useChatDockSectionAttached("todo");
  const [open, setOpen] = useState(false);
  const counts = useMemo(() => todoCounts(todo.items), [todo.items]);
  const activeItem =
    todo.items.find((item) => item.status === "in_progress") ?? null;
  const activeLabel =
    activeItem === null
      ? inactiveTodoSummary(counts)
      : (activeItem.activeForm ?? activeItem.text);

  const list = (
    <ul className={cn("m-0 list-none", CHAT_DOCK_PANEL_LIST)}>
      {todo.items.map((item) => (
        <PinnedTodoRow key={item.id} item={item} />
      ))}
    </ul>
  );

  if (attached) {
    // No portalled actions: the Todo row has never had a header action, and
    // its rows are read-only. The pill carries the count.
    return (
      <ChatDockAttachedPanelBody section="todo" testId="pinned-todo-list">
        {list}
      </ChatDockAttachedPanelBody>
    );
  }

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn(props.separated ? "border-t border-border/50" : null)}
      data-testid="pinned-todo-panel"
      variant="panel"
    >
      <div className="flex items-stretch">
        <CollapsibleTrigger
          className="group/todo flex min-w-0 flex-1 items-center text-left"
          variant="panel"
        >
          <ChevronDown
            aria-hidden
            className={cn(
              "size-3 shrink-0 text-muted-foreground/70 transition-transform",
              open ? null : "-rotate-90",
            )}
          />
          {activeItem !== null ? (
            <LivePulse
              size="xs"
              tone="active"
              ariaLabel="Todo in progress"
              className={undefined}
            />
          ) : null}
          <span className="shrink-0 text-ui-xs font-medium text-foreground/85">
            Todo
          </span>
          <span
            aria-hidden
            data-testid="pinned-todo-header-divider"
            className="shrink-0 text-muted-foreground/40"
          >
            ·
          </span>
          <TodoHeaderStatusIcon counts={counts} />
          <span className="min-w-0 flex-1 truncate text-ui-xs text-muted-foreground">
            {activeLabel}
          </span>
          <span className="shrink-0 text-ui-xs text-muted-foreground">
            {counts.completed}/{counts.total} done
          </span>
          {counts.cancelled > 0 ? (
            <span className="@max-[28rem]:hidden shrink-0 text-ui-xs text-muted-foreground">
              {counts.cancelled} cancelled
            </span>
          ) : null}
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <div
          data-testid="pinned-todo-list"
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

function PinnedTodoRow(props: { readonly item: SegmentTodoItem }) {
  const { item } = props;

  return (
    <li className={cn(CHAT_DOCK_PANEL_ROW, "hover:bg-muted/40")}>
      <TodoStatusIcon status={item.status} />
      <span
        className={cn(
          "block min-w-0 flex-1 truncate",
          CHAT_DOCK_PANEL_ROW_TEXT,
          STATUS_TEXT_TONE[item.status],
        )}
      >
        {item.text}
      </span>
    </li>
  );
}

function TodoHeaderStatusIcon(props: { readonly counts: TodoCounts }) {
  const className = cn("size-3.5 shrink-0", todoHeaderIconTone(props.counts));
  const iconProps = {
    className,
    "data-testid": "pinned-todo-header-status-icon",
  };
  if (props.counts.inProgress > 0) {
    return <ArrowRightCircle {...iconProps} aria-hidden />;
  }
  if (props.counts.completed === props.counts.total && props.counts.total > 0) {
    return <CheckCircle2 {...iconProps} aria-hidden />;
  }
  if (props.counts.cancelled === props.counts.total && props.counts.total > 0) {
    return <XCircle {...iconProps} aria-hidden />;
  }
  return <ListChecks {...iconProps} aria-hidden />;
}

function TodoStatusIcon(props: { readonly status: SegmentTodoItem["status"] }) {
  const className = cn("size-3.5 shrink-0", STATUS_ICON_TONE[props.status]);
  switch (props.status) {
    case "completed":
      return <CheckCircle2 className={className} aria-hidden />;
    case "in_progress":
      return <ArrowRightCircle className={className} aria-hidden />;
    case "pending":
      return <CircleDashed className={className} aria-hidden />;
    case "cancelled":
      return <XCircle className={className} aria-hidden />;
  }
}

function todoCounts(items: ReadonlyArray<SegmentTodoItem>): TodoCounts {
  return items.reduce(
    (counts, item) => ({
      completed: counts.completed + (item.status === "completed" ? 1 : 0),
      cancelled: counts.cancelled + (item.status === "cancelled" ? 1 : 0),
      pending: counts.pending + (item.status === "pending" ? 1 : 0),
      inProgress: counts.inProgress + (item.status === "in_progress" ? 1 : 0),
      total: counts.total + 1,
    }),
    { completed: 0, cancelled: 0, pending: 0, inProgress: 0, total: 0 },
  );
}

function todoHeaderIconTone(counts: TodoCounts): string {
  if (counts.inProgress > 0) return "text-primary";
  if (counts.completed === counts.total && counts.total > 0) {
    return "text-primary";
  }
  return "text-muted-foreground/70";
}

function inactiveTodoSummary(counts: TodoCounts): string {
  if (counts.completed === counts.total && counts.total > 0) return "Complete";
  if (counts.pending > 0) return `${counts.pending} pending`;
  return "No active task";
}
