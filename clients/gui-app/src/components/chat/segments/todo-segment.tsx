import {
  ArrowRightCircle,
  CheckCircle2,
  CircleDashed,
  ListChecks,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type { SegmentTodoItem } from "@/stores/composer/chat-store";
import {
  STATUS_ICON_TONE,
  STATUS_TEXT_TONE,
  segmentStepLabel,
} from "@/lib/chat/todo-status-tones";
import { cn } from "@/lib/utils";

interface TodoSegmentProps {
  items: ReadonlyArray<SegmentTodoItem>;
  findUnitId: string | null;
}

const STATUS_ICON: Record<SegmentTodoItem["status"], LucideIcon> = {
  completed: CheckCircle2,
  in_progress: ArrowRightCircle,
  pending: CircleDashed,
  cancelled: XCircle,
};

export function TodoSegment(props: TodoSegmentProps) {
  const { items } = props;
  const total = items.length;
  const done = items.filter((item) => item.status === "completed").length;
  return (
    <div
      data-chat-find-unit={props.findUnitId ?? undefined}
      className="rounded-md border border-border/40 bg-muted/30 px-3 py-2 text-ui-sm"
    >
      <div className="mb-1.5 flex items-center gap-2 text-muted-foreground">
        <ListChecks className="size-3.5 shrink-0" aria-hidden />
        <span className="font-medium text-foreground/80">
          {done} of {total} Done
        </span>
      </div>
      <ul className="flex flex-col gap-1">
        {items.map((item) => {
          const Icon = STATUS_ICON[item.status];
          const label = segmentStepLabel(item);
          return (
            <li key={item.id} className="flex items-start gap-2">
              <Icon
                className={cn(
                  "mt-0.5 size-3.5 shrink-0",
                  STATUS_ICON_TONE[item.status],
                )}
                aria-hidden
              />
              <span className={cn("min-w-0", STATUS_TEXT_TONE[item.status])}>
                {label}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
