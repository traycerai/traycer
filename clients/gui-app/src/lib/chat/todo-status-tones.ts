import type { SegmentTodoItem } from "@/stores/composer/chat-store";

// A todo item / plan step shows its `activeForm` ("Doing X") only while in
// progress, otherwise its plain `text`. Shared by the todo + plan renderers and
// the chat search projection so the indexed label can't drift from the rendered
// one.
export function segmentStepLabel(step: {
  readonly status: string;
  readonly text: string;
  readonly activeForm: string | null;
}): string {
  return step.status === "in_progress" && step.activeForm !== null
    ? step.activeForm
    : step.text;
}

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
