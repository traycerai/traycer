import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useBlockingAttentionCount } from "@/stores/notifications/merged-notifications";

interface RelayRowProps {
  /**
   * Leaving the editor, which is what a blocking prompt is asking for: the
   * agent is waiting in the app, and the app is inert until the session ends.
   */
  readonly onDone: () => void;
}

/**
 * The relay row (L-17, 4.8): the editor's one in-editor announcement channel
 * while the app column is `aria-hidden`.
 *
 * The signal is the blocking-attention notification count, read here rather
 * than copied through the editor store: this row is the only thing in the app
 * that wants it, and it mounts only inside an open session. Failures never
 * reach it, because "an agent is waiting for you" is not what a failed task
 * means (C-05). The editor never auto-exits - this row asks, and the user
 * answers.
 *
 * `.relay` in the prototype.
 */
export function RelayRow(props: RelayRowProps): ReactNode {
  const blocking = useBlockingAttentionCount();
  if (blocking === 0) return null;
  return (
    <div className="flex items-center gap-2 border-b border-border bg-card px-3 py-2 text-ui-sm">
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-success" />
      <span className="min-w-0 flex-1">An agent is waiting for you</span>
      <Button type="button" variant="muted" size="sm" onClick={props.onDone}>
        Done
      </Button>
    </div>
  );
}
