import { useEffect, type ReactNode } from "react";
import { AlarmClock } from "lucide-react";
import { startAppServerClockMonitor } from "@/lib/clock/app-server-clock";
import { useServerClockSkew } from "@/lib/clock/use-server-clock-skew";
import {
  clockCanMakeValidBearersLookExpired,
  describeClockOffset,
} from "@traycer-clients/shared/clock/server-time-offset-tracker";

/**
 * States that this machine's WALL CLOCK is wrong, mounted beside the session
 * strip directly under the app header.
 *
 * A banner rather than a toast or a notification because the condition is
 * AMBIENT, not an event: a wrong clock is a property of the machine that stays
 * true until someone fixes it. There is nothing to acknowledge and nothing to
 * retry, so there is also no dismiss affordance - it self-clears the moment the
 * tracker sees the clock come right, which is the same edge that resumes every
 * parked stream.
 *
 * It speaks only for a `skewed` verdict. `unknown` (no server-time sample yet,
 * or a sample invalidated by a wall-clock jump) renders nothing: the tracker
 * has not proven anything, and an "is your clock wrong?" banner shown on
 * suspicion would be worse than the silence it replaces.
 *
 * Shown for BOTH directions, but the CONSEQUENCE sentence is direction-aware
 * and only the fast-clock one claims connections are blocked. That claim is
 * true exactly when the local `exp <= Date.now()` read can condemn a valid
 * bearer, which is a clock running ahead; a clock running behind makes bearers
 * look MORE valid and blocks nothing, so telling that user Traycer "can't
 * connect until it's corrected" would send them after the wrong cause - the
 * misdiagnosis this whole feature exists to stop.
 */
export function ClockSkewBanner(): ReactNode {
  const state = useServerClockSkew();
  // Armed here rather than at module import so nothing that merely imports the
  // tracker leaves a live interval behind. Mounted app-wide and never
  // conditionally, so the check runs whatever the current verdict is - which it
  // must, since its whole job is to notice the clock being SET.
  useEffect(() => startAppServerClockMonitor(), []);

  const offsetMs = state.offsetMs;
  if (state.verdict !== "skewed" || offsetMs === null) {
    return null;
  }
  const consequence = clockCanMakeValidBearersLookExpired(state)
    ? "Traycer can't connect until it's corrected."
    : "Times shown in the app will be wrong until it's corrected.";
  return (
    <output
      aria-label="System clock is incorrect"
      data-testid="clock-skew-banner"
      data-offset-ms={offsetMs}
      className="flex w-full items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-ui-xs text-amber-950 dark:text-amber-100"
    >
      <AlarmClock className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        {`Your system clock appears to be ${describeClockOffset(offsetMs)}. ${consequence}`}
      </span>
    </output>
  );
}
