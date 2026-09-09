import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { SyncingSweepBar } from "@/components/sync/syncing-sweep-bar";
import {
  isAnnouncedInterruption,
  useHostSessionWake,
  type HostSessionConnectivity,
} from "@/lib/host/session-connectivity";
import { cn } from "@/lib/utils";

/**
 * The ONE strip that states what this client's OWN transport is doing, mounted
 * directly under the app header.
 *
 * It speaks for the SESSION plane only: the latched verdict from
 * `useHostSessionConnectivity`, which reads the exact stream client's
 * readiness - never a host-wide or directory-plane view. Everything the old
 * host-status strip said about the directory plane (switching, no selection,
 * a broken default host) belongs to the window narrator modal now, which
 * derives those states from the selection authority's leases; a second row
 * restating them here would put two narrators on screen for one fact.
 *
 * The session plane is the one fact the narrator CANNOT own: a session that
 * is not carrying frames is only observable from the client that holds it,
 * and the two causes (our leg down, the relay's host uplink gone) are
 * deliberately indistinguishable - so the copy names the connection, never
 * the host. The verdict is latched per episode and dismissed only by the
 * bound session's own ready edge; surface churn can neither flicker nor
 * postpone it (see the store's announce/escalate deadlines).
 *
 * The copy names the CONNECTION and never the machine, for two reasons that
 * both bite: the verdict cannot distinguish this device's leg from the relay's
 * host uplink, and a host is not necessarily a Mac - the same string would
 * face a user whose host is a Windows or Linux box.
 *
 * The tone is deliberately quiet, and the two states differ in HOW MUCH is
 * said, not only in wording.
 *
 * The ordinary interruption is a bar and nothing else. Most of what this
 * reports is a reconnect that completes in a second or two - a phone coming
 * back from the background, a network moving under a live socket - and a row of
 * words that appears and vanishes in that time is read as an alarm, then
 * distrusted. A bar under the header says "something is happening" without
 * making a sentence of it, and the same bar is what the surfaces below use for
 * the same fact, so a person learns the one motion once. The row keeps its
 * `<output>` and its label throughout, so what a screen reader hears does not
 * depend on whether words happen to be on screen.
 *
 * Only when it has gone on long enough that "back in a moment" is no longer
 * true does the row spend words and offer an action. Retry wakes exactly the
 * session the verdict speaks for (`useHostSessionWake` collapses the
 * transport's pending backoff). Offering it during the ordinary state would
 * invite a tap that changes nothing: the transport is already redialing, and
 * its first attempt has not yet failed. The wake reports no progress of its
 * own, and the button stays enabled - a redial that fails re-arms at the
 * escalated backoff, and re-entering this same line is a normal outcome.
 *
 * The bar stops travelling at that point too, which is the same rule the
 * surface strips follow: a bar still sweeping under "Still reconnecting"
 * promises "any moment now" about a retry that has just been described as not
 * converging, and stopping it bounds the animation of a reconnect that never
 * converges.
 *
 * The verdict is read by the shell and passed in, rather than read here.
 * `useHostSessionConnectivity` builds a store per call - with its own timers
 * and its own latched episode - so a second reader is a second episode, and the
 * one-bar rule below depends on the shell and this row agreeing about whether
 * anything is showing.
 */
export function SessionConnectivityStrip(props: {
  readonly connectivity: HostSessionConnectivity;
}): ReactNode {
  const wakeSession = useHostSessionWake();
  const prolonged = props.connectivity === "interrupted-prolonged";
  if (!isAnnouncedInterruption(props.connectivity)) return null;
  return (
    <output
      aria-label="Connection interrupted - reconnecting"
      data-testid="session-connectivity-strip"
      data-state={props.connectivity}
      className={cn(
        "flex w-full flex-col border-b border-border bg-background text-ui-xs text-muted-foreground",
        // Words earn the padding; the bar alone sits flush under the header as
        // a hairline, so an ordinary two-second reconnect does not shift the
        // whole app down and back.
        prolonged ? "gap-1.5 px-3 py-1.5" : null,
      )}
    >
      {prolonged ? (
        <div className="flex w-full items-center gap-2">
          <span className="min-w-0 flex-1">Still reconnecting</span>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="text-current"
            data-testid="session-connectivity-strip-retry"
            onClick={wakeSession}
          >
            Retry now
          </Button>
        </div>
      ) : null}
      <SyncingSweepBar
        settled={prolonged}
        testId="session-connectivity-strip-bar"
        className={undefined}
      />
    </output>
  );
}
