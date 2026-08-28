import type { ReactNode } from "react";
import {
  useBoundedHostLoad,
  type BoundedHostLoad,
} from "@/hooks/host/use-bounded-host-load";
import {
  useHostReachability,
  resolvedHostLabel,
} from "@/hooks/agent/use-host-reachability";
import {
  tileHostLoadMessage,
  tileLoadNoun,
  type TileLoadSubject,
} from "./tile-host-load-copy";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { createReportIssueContext } from "@/lib/report-issue-context";

/**
 * The words a tile shows while it is waiting on its host, and the words it
 * shows when that wait ends without content (invariant 6).
 *
 * This is the surface that retires the BARE SKELETON. Terminal, TUI and
 * shell-output tiles rendered an animated placeholder with no text at all for
 * `checking` and `host-starting` (audit S5) - a person watching one could not
 * tell a host booting from a host that would never answer, and neither state
 * ever ended. Chats had words for one of the two states and nothing for the
 * other. Every tile now says which host it is waiting on and stops waiting.
 *
 * It does NOT replace `dead-tile-banner.tsx`'s taxonomy, which is
 * audit-confirmed correct and stays: that one is keyed on DIRECTORY
 * membership (`useHostReachability`) and answers "can this tab's host be
 * reached at all". This one is keyed on the LEASE and answers "did this
 * tile's content arrive". A tile whose host is absent from the directory
 * renders the banner and never reaches here; the `dead` arm below fires in
 * the narrower window where the authority has published a verdict the
 * directory has not caught up with yet - which is precisely the state F13
 * says to render instead of a disabled-query spinner.
 */

export interface TileHostLoadStateProps {
  /**
   * Anything but `ready`. A `ready` load means the caller has content and
   * should be rendering it, so accepting it here would only let a caller
   * render this component over its own working tile.
   */
  readonly load: Exclude<BoundedHostLoad, { kind: "ready" }>;
  readonly subject: TileLoadSubject;
  /**
   * Retry affordance for the terminal states. `null` where the surface has no
   * retry to offer - deliberately explicit rather than optional, so a caller
   * that HAS one cannot forget to pass it (the button is the difference
   * between a dead end and a recoverable one).
   */
  readonly onRetry: (() => void) | null;
  readonly testId: string;
}

export function TileHostLoadState(props: TileHostLoadStateProps): ReactNode {
  const noun = tileLoadNoun(props.subject);
  const pending =
    props.load.kind === "loading" || props.load.kind === "connecting";

  return (
    <div
      // A live region for the pending arms: the message changes underneath a
      // reader who has no reason to look back at a tile they already know is
      // loading, and the transition from "waiting" to "this didn't load" is
      // the one they most need told.
      role="status"
      aria-live="polite"
      data-testid={props.testId}
      data-load-kind={props.load.kind}
      className="flex h-full w-full flex-col items-center justify-center gap-3 bg-canvas px-6 text-center text-ui-sm text-muted-foreground"
    >
      {pending ? (
        <AgentSpinningDots
          className="shrink-0"
          testId={undefined}
          variant={undefined}
        />
      ) : null}
      <p className="max-w-md">{tileHostLoadMessage(props.load, noun)}</p>
      {props.load.kind === "timed-out" || props.load.kind === "dead" ? (
        <div className="flex flex-wrap justify-center gap-2">
          {props.onRetry === null ? null : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={props.onRetry}
            >
              Try again
            </Button>
          )}
          <ReportIssueAction
            context={createReportIssueContext({
              title: `This ${noun} could not be loaded`,
              message: `The ${noun}'s host did not answer within the load budget.`,
              code: null,
              source: "Host",
            })}
            presentation="text"
            className={undefined}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Bounds a placeholder a surface ALREADY had, without disturbing it.
 *
 * Mounting this component IS the pending signal - callers render it in place
 * of their existing skeleton, and unmounting it (because content arrived)
 * disarms the budget. Tying the deadline's lifetime to the placeholder's own
 * mount is what keeps the four diff/PR tiles to a one-node change each rather
 * than a pending-flag threaded through their live subtrees.
 *
 * Inside the budget the surface's own placeholder renders unchanged: a diff
 * skeleton is genuinely good progressive UI for content that is coming, and
 * replacing it with a sentence would be a downgrade for the common case. Past
 * the budget - or the moment the lease says dead - it gives way to words.
 */
export function BoundedTileLoad(props: {
  readonly hostId: string;
  readonly subject: TileLoadSubject;
  readonly onRetry: (() => void) | null;
  readonly testId: string;
  /** The surface's existing in-budget placeholder. */
  readonly fallback: ReactNode;
}): ReactNode {
  const reachability = useHostReachability(props.hostId);
  const load = useBoundedHostLoad({
    hostId: props.hostId,
    hostLabel: resolvedHostLabel(reachability),
    pending: true,
  });
  if (load.kind === "timed-out" || load.kind === "dead") {
    return (
      <TileHostLoadState
        load={load}
        subject={props.subject}
        onRetry={props.onRetry}
        testId={props.testId}
      />
    );
  }
  return props.fallback;
}
