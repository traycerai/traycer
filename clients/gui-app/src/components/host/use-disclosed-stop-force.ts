import { useState } from "react";

export interface DisclosedStopForceInput {
  /** What one offer is about: a new key is a new first offer. */
  readonly offerKey: string;
  /** Stop can be clicked. A disabled Stop (checking, rechecking) ends the offer. */
  readonly enabled: boolean;
  /** The force the CURRENT state would send. */
  readonly force: boolean;
}

interface LatchedOffer {
  readonly offerKey: string;
  readonly force: boolean;
}

/**
 * The force a Stop click may send: the current state's, but only if the Stop
 * FIRST offered for this state was already a force.
 *
 * The list under an open prompt stays live (`host.status` polls), and its Stop
 * label is the same for an idle and a busy list. A poll that turns idle into
 * busy can land just before a click - before a frame has painted, or within
 * the reaction time of someone already reaching for the button - and a force
 * sent then ends work nobody was shown. So a force is sent only when the force
 * was on offer from the start; a list that turned busy afterwards sends the
 * idle-only stop, which the host refuses, and the refusal comes back as a
 * fresh prompt that says it is busy.
 *
 * The first offer is latched during render (React's "adjust state while
 * rendering"), and cleared whenever Stop is disabled, so a recheck starts a
 * new offer.
 */
export function useDisclosedStopForce(input: DisclosedStopForceInput): boolean {
  const [latched, setLatched] = useState<LatchedOffer | null>(null);
  if (!input.enabled) {
    if (latched !== null) setLatched(null);
    return false;
  }
  if (latched === null || latched.offerKey !== input.offerKey) {
    setLatched({ offerKey: input.offerKey, force: input.force });
    return input.force;
  }
  return latched.force && input.force;
}
