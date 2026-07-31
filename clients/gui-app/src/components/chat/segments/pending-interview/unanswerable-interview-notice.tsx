import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import type { UnanswerableInterviewView } from "@/components/epic-canvas/renderers/chat-tile-types";

/**
 * Recorded as the durable `interview.errored` reason, so it becomes the settled
 * block's error text in the transcript. Written to read as a user action rather
 * than a failure - the question really did go unanswered.
 */
export const UNANSWERABLE_INTERVIEW_DISMISS_REASON =
  "Dismissed by the user: this question could no longer be answered.";

interface UnanswerableInterviewNoticeProps {
  /** Non-empty; the caller does not render this notice for an empty set. */
  readonly interviews: ReadonlyArray<UnanswerableInterviewView>;
  /** True while a dismissal for any of these blocks is in flight. */
  readonly isBusy: boolean;
  /**
   * Sends `interviewError` for one block. `null` disables the affordance while
   * the chat cannot act (viewer, or the stream is not open) - the notice still
   * renders so the deadlock is at least legible.
   */
  readonly onDismiss:
    ((blockId: string, reason: string) => string | null) | null;
}

/**
 * Last-resort escape hatch for a chat the host has send-locked on an interview
 * that renders no card (see `UnanswerableInterviewView`). Dismissing settles
 * every stuck block as errored, which clears the host's pending wait and
 * unblocks the composer.
 *
 * One button dismisses all of them: the user's intent here is "get me unstuck",
 * and leaving even one behind keeps the chat locked.
 */
export function UnanswerableInterviewNotice({
  interviews,
  isBusy,
  onDismiss,
}: UnanswerableInterviewNoticeProps) {
  const count = interviews.length;
  const plural = count > 1;
  const headline = plural
    ? `This chat is waiting on ${count} questions that can no longer be shown.`
    : "This chat is waiting on a question that can no longer be shown.";
  const detail = plural
    ? "Sending is blocked until they are resolved. Dismissing them records the questions as unanswered and unblocks the composer."
    : "Sending is blocked until it is resolved. Dismissing it records the question as unanswered and unblocks the composer.";
  const dismissAll = (): void => {
    if (onDismiss === null) return;
    interviews.forEach((interview) => {
      onDismiss(interview.blockId, UNANSWERABLE_INTERVIEW_DISMISS_REASON);
    });
  };

  return (
    <section
      aria-label="Unanswerable question"
      data-testid="unanswerable-interview-notice"
      className="flex w-full flex-col gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-ui-sm"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle
          className="mt-0.5 size-3.5 shrink-0 text-destructive"
          aria-hidden
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-foreground/90">{headline}</span>
          <span className="text-ui-xs text-muted-foreground">{detail}</span>
        </div>
      </div>
      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={onDismiss === null || isBusy}
          onClick={dismissAll}
        >
          {isBusy ? <MutedAgentSpinner /> : null}
          {plural ? `Dismiss ${count} questions` : "Dismiss question"}
        </Button>
      </div>
    </section>
  );
}
