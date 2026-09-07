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
 * Window-level verdict over attached/effective/target/lease fleet. Mount once per window: the served latch is component state. `WindowHostModalHost` is the only caller.
 */
export function useWindowNarration(): WindowNarrationState {
  const attached = useSelectionAuthorityAttached();
  const effectiveHostId = useEffectiveHostId();
  // Scalar selector: no `useShallow` needed, unlike a derived array/object.
  const targetHostId = useSelectionAuthorityStore(
    (state) => state.targetHostId,
  );
  const leases = useHostLeases();
  // The NULL-TOLERANT read, deliberately: this hook mounts at the app root, and the throwing `useRunnerHost` is exactly the RunnerHostProvider coupling that once cost two root-route suites their whole tree (see `NarratingWindowHostModal`'s doc).
  const localHostExpected = useRunnerHostOrNull()?.hasLocalHost ?? false;
  // WHICH host is this machine's, which `hasLocalHost` cannot answer: it is a statement about the SHELL and stays true while the target is a remote.
  const localHostId = useReactiveLocalHostId();

  const servingNow =
    attached && isServingLease(findLease(leases, effectiveHostId));

  // Adjust the latch during render so it is render-visible. Sign-out unmounts the modal host, so a later account gets a fresh latch without an identity comparison here.
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
