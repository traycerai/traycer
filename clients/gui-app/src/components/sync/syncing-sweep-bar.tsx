import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface SyncingSweepBarProps {
  /**
   * Whether the resync has run long enough that the bar should stop moving.
   *
   * The travel STOPS rather than continuing under the escalated copy, for two
   * reasons, and the second is the one that decides it:
   *
   *  - By then the words are doing the work. A segment still sweeping under
   *    "Still reconnecting" says "any moment now" about a retry that has just
   *    been described as not converging.
   *  - It bounds the animation. Blink samples every running CSS animation once
   *    per display frame and recalcs the element's style, which against this
   *    stylesheet is a few KB of heap garbage per frame - the measurement that
   *    moved the "working" indicator off CSS animation entirely (see
   *    `index.css`). A reconnect that never converges would otherwise animate
   *    for as long as the app is in the foreground.
   */
  readonly settled: boolean;
  readonly testId: string;
  readonly className: string | undefined;
}

/**
 * The travelling bar itself: an accent segment sweeping a faint track.
 *
 * Shared by every surface that says a connection is coming back - the app-wide
 * session strip and the per-surface syncing strips - so that one motion means
 * one thing wherever a person meets it. It carries no words and no semantics of
 * its own; whatever mounts it owns the sentence and the live region, and this is
 * `aria-hidden` so a reader is never told the same fact twice.
 */
export function SyncingSweepBar(props: SyncingSweepBarProps): ReactNode {
  return (
    <div
      // `bg-foreground/8`, never `bg-muted`: this mounts wherever a surface
      // header is, and every preset theme's dark variant collapses `--muted`
      // into the card and popover colours - the track would vanish on the first
      // raised surface that adopts it. An alpha of the foreground is
      // surface-independent by construction.
      className={cn(
        "h-0.5 w-full overflow-hidden bg-foreground/8",
        props.className,
      )}
      aria-hidden
    >
      <div
        data-testid={props.testId}
        className={cn(
          "h-full bg-primary",
          // Motion lives in a class, not an inline `animation` style: an inline
          // style cannot be overridden by the reduced-motion rule that ships
          // with it, which is why the two host-install bars honour nothing.
          // The settled form is plain utilities - the same still, full-width,
          // low-alpha line that rule produces, reached by a different question.
          props.settled ? "w-full opacity-45" : "w-2/5 stream-syncing-sweep",
        )}
      />
    </div>
  );
}
