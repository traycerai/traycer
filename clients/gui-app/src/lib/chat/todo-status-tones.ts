import type { SegmentTodoItem } from "@/stores/composer/chat-store";

export const STATUS_ICON_TONE: Record<SegmentTodoItem["status"], string> = {
  completed: "text-primary",
  in_progress: "text-primary",
  pending: "text-muted-foreground/60",
  cancelled: "text-muted-foreground/60",
};

export const STATUS_TEXT_TONE: Record<SegmentTodoItem["status"], string> = {
  completed: "line-through text-muted-foreground",
  in_progress: "text-foreground",
  pending: "text-foreground",
  cancelled: "line-through text-muted-foreground",
};
