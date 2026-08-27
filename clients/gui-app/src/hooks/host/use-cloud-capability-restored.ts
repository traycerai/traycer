import { useEffect } from "react";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";

/**
 * Runs `onRestored` on the strictly-once false -> true edge of
 * {@link authorizesCloudCapability}.
 *
 * The failure this exists for: a same-user demotion (`signed-in` ->
 * `unverified`) force-closes held remote sessions. Bindings that are still
 * mounted rebuild immediately, mint under a withdrawn capability, close the
 * same way, and walk their rebuild pacer up to its 30s ceiling. The promotion
 * back rotates the SAME request context - same user, same host, same endpoint -
 * so the transport key does not move, the directory refresh ignores an
 * equivalent entry, and `notifyBearerRotated()` is a no-op on a session that is
 * already closed. Nothing re-acquires, and nothing resets the backoff, so a
 * remote tab or a relay-only notification stream can sit dark for up to 30
 * seconds AFTER verification succeeded.
 *
 * ## Why the auth store rather than `onSessionVerified`
 *
 * `RequestContextProvider.onSessionVerified` is the post-commit signal for
 * "this session is confirmed", and it is the right subscription for a listener
 * that wants to act on every confirmation. This is not that listener, for two
 * reasons:
 *
 * 1. **It is an event, not an edge.** It fires whenever a session is verified,
 *    including on paths where cloud authorization never lapsed. Clearing a
 *    pacer streak on a repeating signal is precisely the misuse
 *    `StreamRebuildPacer.clearStreak` warns about - it would disable the
 *    backoff and restore the hot rebuild loop. `subscribe`'s `previousState`
 *    gives the transition itself, which is strictly-once by construction: a
 *    store write that leaves the predicate true is filtered by the same guard
 *    that filters a write leaving it false.
 * 2. **It is not announced on every restoring path.** `applyExternalSession`
 *    commits the verdict and the signed-in store and returns without calling
 *    `announceSessionVerified()`. Keying the wake on the store means it does
 *    not silently depend on that being fixed first.
 *
 * The ordering the signal exists to protect still holds here: the auth store's
 * verdict is committed AFTER the context call that carries the new bearer (see
 * `RequestContextProvider.announceSessionVerified`), so by the time this edge
 * is observed a rebuild mints against the restored credential rather than the
 * one it replaced.
 *
 * `onRestored` must be stable across renders - pass a `useCallback`. It is a
 * dependency rather than a ref read so that a caller whose closure genuinely
 * changes is honoured; the resubscribe happens within one commit's cleanup and
 * setup, so no store write can land in the gap.
 */
export function useCloudCapabilityRestored(onRestored: () => void): void {
  useEffect(() => {
    return useAuthStore.subscribe((state, previousState) => {
      if (
        authorizesCloudCapability(previousState.status) ||
        !authorizesCloudCapability(state.status)
      ) {
        return;
      }
      onRestored();
    });
  }, [onRestored]);
}
