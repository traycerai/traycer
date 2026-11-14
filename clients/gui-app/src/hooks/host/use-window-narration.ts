import { useHostDoorState } from "@/stores/host/host-door-state-store";
import { useMemo, useState } from "react";
import {
  deriveWindowNarration,
  doorCoverHostOf,
  findLease,
  isServingLease,
  olderHostUpdateVariant,
  type WindowNarrationState,
} from "@/lib/host/window-narration";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useHostDiscoveryConcluded } from "@/hooks/host/use-host-discovery-concluded";
import { useHostLeases } from "@/hooks/host/use-host-lease";
import { useSelectionAuthorityAttached } from "@/hooks/host/use-selection-authority-attached";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { useReactiveLocalHostId } from "@/hooks/host/use-reactive-local-host-id";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import {
  MINIMUM_HOST_VERSION,
  hostDirectoryEntryNeedsUpdate,
} from "@traycer-clients/shared/host-client/minimum-host-version";
import { hostAppVersionFromDirectoryEntry } from "@/lib/host/version-skew-copy";

export interface WindowNarrationReading {
  readonly narration: WindowNarrationState;
  readonly doorCoverHostId: string | null;
}

/**
 * The window narrator's verdict for THIS window.
 *
 * Reads the authority projection jointly - attached, effective, target and the
 * lease fleet - because the verdict is a function of all four together and no
 * per-host answer can express it: "no host can serve this window" is a
 * question about the fleet, not about a host. The
 * per-host projection stays `useHostLease`, whose single-owner rule this does
 * not touch; `useHostLeases()` is that module's own fleet read.
 *
 * MOUNT ONCE PER WINDOW. The served latch below is component state, so a
 * second mount would carry a second, independently-armed latch - two answers
 * to "has this window ever worked". `WindowHostModalHost` is the only caller.
 *
 * `doorCoverHostId` is the host whose door cover the narration draws, read
 * from the same input in the same mount, so the toast's question "is that
 * host's cover on screen" has one answer with the narration's.
 */
export function useWindowNarration(): WindowNarrationReading {
  const attached = useSelectionAuthorityAttached();
  const effectiveHostId = useEffectiveHostId();
  // Scalar selector: no `useShallow` needed, unlike a derived array/object.
  const targetHostId = useSelectionAuthorityStore(
    (state) => state.targetHostId,
  );
  const leases = useHostLeases();
  const updateCandidate = useHostDirectoryEntry(
    effectiveHostId ?? targetHostId,
  );
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
  const doorState = useHostDoorState(effectiveHostId ?? targetHostId);
  // WHETHER DISCOVERY HAS ANSWERED, which the authority's own projection
  // cannot say: its leases are a map over the fleet it has been given, so an
  // unanswered fleet and an empty account produce the identical empty list.
  // Subscribed rather than derived from the directory rows - see the hook.
  const discoveryConcluded = useHostDiscoveryConcluded();

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

  return useMemo<WindowNarrationReading>(() => {
    if (
      attached &&
      updateCandidate !== null &&
      hostDirectoryEntryNeedsUpdate(updateCandidate, MINIMUM_HOST_VERSION)
    ) {
      return {
        narration: {
          kind: "narrating",
          cause: effectiveHostId === null ? "no-usable-host" : "cold-start",
          variant: olderHostUpdateVariant(
            updateCandidate.hostId,
            updateCandidate.hostId === targetHostId,
            hostAppVersionFromDirectoryEntry(updateCandidate),
          ),
        },
        doorCoverHostId: updateCandidate.hostId,
      };
    }
    const input = {
      attached,
      effectiveHostId,
      targetHostId,
      leases,
      hasBeenServed,
      localHostExpected,
      discoveryConcluded,
      localHostId,
      doorState,
    };
    return {
      narration: deriveWindowNarration(input),
      doorCoverHostId: doorCoverHostOf(input),
    };
  }, [
    attached,
    discoveryConcluded,
    effectiveHostId,
    hasBeenServed,
    leases,
    localHostExpected,
    localHostId,
    doorState,
    targetHostId,
    updateCandidate,
  ]);
}
