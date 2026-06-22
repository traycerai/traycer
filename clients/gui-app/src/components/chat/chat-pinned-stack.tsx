import {
  ArrowRightCircle,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  ListChecks,
  XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";
import { ChatAccumulatedChangesPanel } from "@/components/chat/chat-accumulated-changes-panel";
import type { ChatRestoreContextValue } from "@/components/chat/chat-restore-context-core";
import type { PinnedTodoSnapshot } from "@/components/chat/chat-pinned-todos";
import { hasChatPinnedStackContent } from "@/components/chat/chat-pinned-stack-utils";
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
import type { SegmentTodoItem } from "@/stores/composer/chat-store";

export type ChatLowerSurfaceTopSpacing = "normal" | "connected";
export type ChatPinnedStackTopSpacing = "normal" | "compact";

interface ChatPinnedStackProps {
  readonly todo: PinnedTodoSnapshot | null;
  readonly restore: ChatRestoreContextValue;
  readonly topSpacing: ChatPinnedStackTopSpacing;
  readonly scrollRegionMaxHeightClass?: string;
}

export function PinnedStackSections(props: {
  readonly todo: PinnedTodoSnapshot | null;
  readonly restore: ChatRestoreContextValue;
  readonly scrollRegionMaxHeightClass: string;
  readonly separated: boolean;
}) {
  const { restore, todo } = props;
  const showChanges = restore.accumulatedFileChanges.length > 0;
  if (todo === null && !showChanges) return null;

  return (
    <>
      {todo !== null ? (
        <PinnedTodoPanel
          todo={todo}
          scrollRegionMaxHeightClass={props.scrollRegionMaxHeightClass}
          separated={props.separated}
        />
      ) : null}
      {showChanges ? (
        <ChatAccumulatedChangesPanel
          restore={restore}
          separated={todo !== null || props.separated}
          scrollRegionMaxHeightClass={props.scrollRegionMaxHeightClass}
        />
      ) : null}
    </>
  );
}

export function ChatPinnedStack(props: ChatPinnedStackProps) {
  const scrollRegionMaxHeightClass =
    props.scrollRegionMaxHeightClass ?? "max-h-[min(40dvh,24rem)]";
  if (!hasChatPinnedStackContent(props.todo, props.restore)) return null;

  return (
    <div
      className={cn(
        "bg-canvas px-4",
        props.topSpacing === "normal" ? "pt-4" : "pt-2",
      )}
    >
      <div className="mx-auto w-full max-w-3xl">
        <div
          data-testid="chat-pinned-stack"
          className="@container mx-3 -mb-px overflow-hidden rounded-t-lg border border-b-0 border-border bg-muted/30"
        >
          <PinnedStackSections
            todo={props.todo}
            restore={props.restore}
            scrollRegionMaxHeightClass={scrollRegionMaxHeightClass}
            separated={false}
          />
        </div>
      </div>
    </div>
  );
}

interface TodoCounts {
  readonly completed: number;
  readonly cancelled: number;
  readonly pending: number;
  readonly inProgress: number;
  readonly total: number;
}

function PinnedTodoPanel(props: {
  readonly todo: PinnedTodoSnapshot;
  readonly scrollRegionMaxHeightClass: string;
  readonly separated: boolean;
}) {
  const { todo } = props;
  const [open, setOpen] = useState(false);
  const counts = useMemo(() => todoCounts(todo.items), [todo.items]);
  const activeItem =
    todo.items.find((item) => item.status === "in_progress") ?? null;
  const activeLabel =
    activeItem === null
      ? inactiveTodoSummary(counts)
      : (activeItem.activeForm ?? activeItem.text);

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn(
        "bg-muted/30",
        props.separated ? "border-t border-border/50" : null,
      )}
      data-testid="pinned-todo-panel"
    >
      <div className="flex items-stretch">
        <CollapsibleTrigger className="group/todo flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
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
          className={cn(
            "overflow-y-auto border-t border-border/50 px-2 py-1.5 chat-scrollbar-native-thin",
            props.scrollRegionMaxHeightClass,
          )}
        >
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {todo.items.map((item) => (
              <PinnedTodoRow key={item.id} item={item} />
            ))}
          </ul>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function PinnedTodoRow(props: { readonly item: SegmentTodoItem }) {
  const { item } = props;

  return (
    <li className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1 hover:bg-muted/40">
      <TodoStatusIcon status={item.status} />
      <span
        className={cn(
          "block min-w-0 flex-1 truncate",
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
