import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import {
  isAnnouncedInterruption,
  useHostSessionConnectivity,
  useHostSessionWake,
} from "@/lib/host/session-connectivity";

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
 * The accessible name is derived from the same verdict the visible line is,
 * so a screen reader and a pair of eyes are told the same thing - a static
 * label would keep announcing the first rung after the row had escalated.
 *
 * The copy names the CONNECTION and never the machine, for two reasons that
 * both bite: the verdict cannot distinguish this device's leg from the relay's
 * host uplink, and a host is not necessarily a Mac - the same string would
 * face a user whose host is a Windows or Linux box.
 *
 * The tone is deliberately quiet. Most interruptions this reports are a
 * reconnect that completes in a second or two - a phone coming back from the
 * background, a network moving under a live socket - and dressing those as a
 * warning taught people to distrust the row rather than read it. The spinner
 * carries "something is happening"; the words carry what it is.
 *
 * Retry appears only in the PROLONGED state, and it wakes exactly the session
 * the verdict speaks for (`useHostSessionWake` collapses the transport's
 * pending backoff). Offering it during the ordinary state would invite a tap
 * that changes nothing: the transport is already redialing, and its first
 * attempt has not yet failed. The wake reports no progress of its own, so the
 * ambient spinner is the pending signal and the button stays enabled - a
 * redial that fails re-arms at the escalated backoff, and re-entering this
 * same line is a normal outcome.
 */
export function SessionConnectivityStrip(): ReactNode {
  const connectivity = useHostSessionConnectivity();
  const wakeSession = useHostSessionWake();
  const prolonged = connectivity === "interrupted-prolonged";
  if (!isAnnouncedInterruption(connectivity)) return null;
  return (
    <output
      aria-label={
        prolonged
          ? "Connection interrupted - still reconnecting"
          : "Connection interrupted - reconnecting"
      }
      data-testid="session-connectivity-strip"
      data-state={connectivity}
      className="flex w-full items-center gap-2 border-b border-border bg-background px-3 py-1.5 text-ui-xs text-muted-foreground"
    >
      <span className="min-w-0 flex-1">
        {prolonged ? "Still reconnecting. Retrying…" : "Reconnecting…"}
      </span>
      <AgentSpinningDots
        className="size-3"
        testId="session-connectivity-strip-spinner"
        variant={undefined}
      />
      {prolonged ? (
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
      ) : null}
    </output>
  );
}
