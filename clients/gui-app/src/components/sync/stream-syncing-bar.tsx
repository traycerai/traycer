import { useEffect, useState, type ReactNode } from "react";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import { LINK_DOWN_ESCALATION_MS } from "@/lib/link-down-escalation";
import {
  isStreamSyncing,
  streamSyncingLabel,
} from "@/lib/sync/stream-syncing-state";
import { cn } from "@/lib/utils";

/**
 * Whether this syncing spell has run long enough to say so.
 *
 * Render-phase reset rather than an effect, matching `useLinkDownTooLong`: the
 * moment the stream is back, the escalated word must not paint even one frame.
 * The timer is keyed on the SPELL, so a status flipping between `connecting`
 * and `reconnecting` - one outage seen twice - does not restart the clock.
 */
function useSyncingEscalated(syncing: boolean): boolean {
  const [escalated, setEscalated] = useState(false);
  if (!syncing && escalated) {
    setEscalated(false);
  }
  useEffect(() => {
    if (!syncing) return undefined;
    const timer = setTimeout(() => {
      setEscalated(true);
    }, LINK_DOWN_ESCALATION_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [syncing]);
  return syncing && escalated;
}

interface StreamSyncingBarProps {
  /** This surface's OWN stream status - never a blend across streams. */
  readonly status: StreamConnectionStatus;
  /**
   * Whether the surface is already showing something. Every caller passes its
   * store's `snapshotLoaded`: it survives an ordinary reconnect on both the
   * Epic and the chat line (only a replica reset or an explicit retry clears
   * it), which is exactly the "content on screen, stream away" window.
   */
  readonly hasContent: boolean;
  /**
   * Names what is re-syncing, for a screen reader that hears the strip with no
   * surrounding context ("Task", "Chat"). The visible word stays the short one.
   */
  readonly surfaceLabel: string;
  readonly testId: string;
}

/**
 * The thin strip a surface shows while its own stream comes back with content
 * already on screen: the word, and an accent bar travelling on a faint track
 * beneath it.
 *
 * ONE indicator per surface, and it is deliberately not a spinner. A spinner
 * next to a transcript reads as "the agent is working"; this is about the
 * connection, and it has to be distinguishable from the agent's own activity at
 * a glance on a phone.
 *
 * The strip takes its own row rather than overlaying the content, so nothing it
 * says is painted on top of the possibly-stale text it is describing. It is
 * `shrink-0` because it lives inside the surface's header stack, where the
 * scroller below is what absorbs the height.
 */
export function StreamSyncingBar(props: StreamSyncingBarProps): ReactNode {
  const syncing = isStreamSyncing(props.status, props.hasContent);
  const escalated = useSyncingEscalated(syncing);
  if (!syncing) return null;
  return (
    <div
      data-testid={props.testId}
      data-sync-state={escalated ? "stalled" : "syncing"}
      // `status` + polite, not `alert`: a reconnect is not an interruption, and
      // the same strip re-announcing on every app switch would be its own kind
      // of noise. `aria-busy` is what carries "and the surface under me may be
      // behind" to a reader that never sees the bar.
      role="status"
      aria-busy
      className="shrink-0"
    >
      <span className="block truncate px-3 pb-1 text-ui-xs text-muted-foreground">
        <span className="sr-only">{props.surfaceLabel}: </span>
        {streamSyncingLabel(escalated)}
      </span>
      <div
        // `bg-foreground/8`, never `bg-muted`: this sits on `bg-canvas` today
        // but the strip is mounted wherever a surface header is, and every
        // preset theme's dark variant collapses `--muted` into the card and
        // popover colours - the track would vanish on the first raised surface
        // that adopts this. An alpha of the foreground is surface-independent
        // by construction.
        className="h-0.5 w-full overflow-hidden bg-foreground/8"
        // The bar is decoration for the word above it. Announcing it as well
        // would make a screen reader say the same fact twice, and a valueless
        // progressbar is a worse way to say it than "Syncing…" already is.
        aria-hidden
      >
        <div
          data-testid={`${props.testId}-sweep`}
          className={cn(
            "h-full bg-primary",
            // The travel STOPS at escalation. Two reasons, and the second is
            // the one that decides it:
            //
            //  - By then the word is doing the work. A segment still sweeping
            //    under "Still syncing…" says "any moment now" about a retry
            //    that has already been told it is not converging.
            //  - It bounds the animation. Blink samples every running CSS
            //    animation once per display frame and recalcs the element's
            //    style, which against this stylesheet is a few KB of heap
            //    garbage per frame - the measurement that moved the "working"
            //    indicator off CSS animation entirely (see `index.css`). A
            //    resync that never converges would otherwise animate for as
            //    long as the app is in the foreground; this caps it at the
            //    escalation threshold.
            //
            // Motion lives in a class, not an inline `animation` style: an
            // inline style cannot be overridden by the reduced-motion rule
            // that ships with it, which is why the two host-install bars
            // honour nothing.
            escalated ? "w-full opacity-45" : "w-2/5 stream-syncing-sweep",
          )}
        />
      </div>
    </div>
  );
}
