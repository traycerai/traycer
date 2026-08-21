import { useMemo, useState } from "react";
import {
  deriveWindowNarration,
  findLease,
  isServingLease,
  type WindowNarrationState,
} from "@/lib/host/window-narration";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useHostLeases } from "@/hooks/host/use-host-lease";
import { useSelectionAuthorityAttached } from "@/hooks/host/use-selection-authority-attached";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { useReactiveLocalHostId } from "@/hooks/host/use-reactive-local-host-id";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";

/**
 * The window narrator's verdict for THIS window.
 *
 * Reads the authority projection jointly - attached, effective, target and the
 * lease fleet - because the verdict is a function of all four together and no
 * per-host answer can express it: "every lease is dead and every reason is
 * plan-restricted" is a question about the fleet, not about a host. The
 * per-host projection stays `useHostLease`, whose single-owner rule this does
 * not touch; `useHostLeases()` is that module's own fleet read.
 *
 * MOUNT ONCE PER WINDOW. The served latch below is component state, so a
 * second mount would carry a second, independently-armed latch - two answers
 * to "has this window ever worked". `WindowHostModalHost` is the only caller.
 */
export function useWindowNarration(): WindowNarrationState {
  const attached = useSelectionAuthorityAttached();
  const effectiveHostId = useEffectiveHostId();
  // Scalar selector: no `useShallow` needed, unlike a derived array/object.
  const targetHostId = useSelectionAuthorityStore(
    (state) => state.targetHostId,
  );
  const leases = useHostLeases();
  // The NULL-TOLERANT read, deliberately: this hook mounts at the app root,
  // and the throwing `useRunnerHost` is exactly the RunnerHostProvider
  // coupling that once cost two root-route suites their whole tree (see
  // `NarratingWindowHostModal`'s doc). Outside a provider - web, harnesses -
  // there is no local host to expect, which is also the correct answer.
  const localHostExpected = useRunnerHostOrNull()?.hasLocalHost ?? false;
  // WHICH host is this machine's, which `hasLocalHost` cannot answer: it is a
  // statement about the SHELL and stays true while the target is a remote. The
  // restarting-target grace needs the identity, or it tells a local boot story
  // over a remote machine this app has no lifecycle for.
  //
  // The DURABLE id, never `useReactiveLocalHostEntry()?.hostId`: the entry is
  // nulled by `onLocalHostChange(null)`, which is precisely what a restarting
  // local host looks like, so the entry answers null for exactly the interval
  // this arm is about and the grace would collapse in the state it exists for.
  const localHostId = useReactiveLocalHostId();

  const servingNow =
    attached && isServingLease(findLease(leases, effectiveHostId));

  // State adjusted DURING render (React's documented "adjusting state when
  // props change" pattern), matching the readiness gate's `hasBeenReady`:
  // this hook's whole output is a function of the latch, so it must be
  // render-visible, and React re-runs the render before committing rather
  // than painting an un-latched frame first.
  //
  // THE RESET IS STRUCTURAL, NOT A GUARD: the modal host mounts only for a
  // signed-in user, so signing out unmounts it and destroys this state. A
  // different account signing in afterwards therefore gets a fresh latch and
  // a correct cold-start narration, without this hook carrying an identity
  // comparison it would have to keep in step with the authority's own.
  const [hasBeenServed, setHasBeenServed] = useState(false);
  if (servingNow && !hasBeenServed) {
    setHasBeenServed(true);
  }

  return useMemo(
    () =>
      deriveWindowNarration({
        attached,
        effectiveHostId,
        targetHostId,
        leases,
        hasBeenServed,
        localHostExpected,
        localHostId,
      }),
    [
      attached,
      effectiveHostId,
      hasBeenServed,
      leases,
      localHostExpected,
      localHostId,
      targetHostId,
    ],
  );
}
