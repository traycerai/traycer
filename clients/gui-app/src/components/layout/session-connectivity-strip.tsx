import type { ReactNode } from "react";
import { PlugZap } from "lucide-react";
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
 * Retry wakes exactly the session the verdict speaks for
 * (`useHostSessionWake` collapses the transport's pending backoff). The wake
 * reports no progress of its own, so the ambient spinner - the transport
 * genuinely is still redialing in both announced states - is the pending
 * signal, and the button stays enabled: a redial that fails re-arms at the
 * escalated backoff, and re-entering this same line is a normal outcome.
 */
export function SessionConnectivityStrip(): ReactNode {
  const connectivity = useHostSessionConnectivity();
  const wakeSession = useHostSessionWake();
  if (!isAnnouncedInterruption(connectivity)) return null;
  return (
    <output
      aria-label="Connection to Traycer Host interrupted"
      data-testid="session-connectivity-strip"
      data-state={connectivity}
      className="flex w-full items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-ui-xs text-amber-950 dark:text-amber-100"
    >
      <PlugZap className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        {connectivity === "interrupted-prolonged"
          ? "Still can't connect - retrying."
          : "Connection interrupted - reconnecting…"}
      </span>
      <AgentSpinningDots
        className="size-3"
        testId="session-connectivity-strip-spinner"
        variant={undefined}
      />
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
    </output>
  );
}
