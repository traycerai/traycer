import { useEffect, useLayoutEffect, useRef } from "react";
import {
  admitsLocalPlane,
  useAuthStore,
  type AuthStatus,
} from "@/stores/auth/auth-store";

/**
 * Discriminated transition classification emitted by `useAuthIdentityTransition`.
 *
 * - `signedIn` - the identity became signed-in. On the component's very first
 *   render `isInitialMount` is `true`; on a transition from `signed-out` /
 *   `signing-in` to `signed-in` it is `false`.
 * - `signedOut` - the identity dropped out entirely (an explicit sign-out, or
 *   a credentials file that is gone). NOT a token rejection or an unreachable
 *   authn: those leave the stored identity in place as `unverified`, and the
 *   account-scoped stores this drives must stay bound to it.
 * - `userSwitched` - the identity stayed `signed-in` but the ACCOUNT changed
 *   out from under the component (a new user took over the session).
 *
 * Idle renders - no change, or changes inside the same signed-in identity -
 * do not fire the callback at all.
 *
 * The carried value is `userId`, the CANONICAL account id, and the field is
 * named for it. It used to be the email, which reads as an identity and is
 * not one: two distinct accounts can present the same address, and for that
 * pair `prior !== next` is false, so `userSwitched` never fires, no persisted
 * store is reset or retargeted, and the incoming account silently inherits the
 * outgoing account's state. Everything keyed off this value is account-scoped
 * (surface host pins, composer run settings and harness memory, worktree
 * intent, epic canvas, landing terminals, reading positions, GitHub mention
 * filters), and host ids in particular are account-scoped, so an inherited pin
 * names a host the new fleet does not contain.
 *
 * Renaming rather than adding an overload deliberately: an optional
 * "identity key" beside an `email` field is the shape that produced the split
 * in the first place, where two of eleven bridges passed a userId into a
 * parameter called `email` and the rest passed an address.
 */
export type AuthIdentityTransition =
  | {
      readonly kind: "signedIn";
      readonly userId: string | null;
      readonly isInitialMount: boolean;
    }
  | { readonly kind: "signedOut" }
  | { readonly kind: "userSwitched"; readonly userId: string | null };

/**
 * Watches the authenticated identity `(status, userId)` across renders and
 * invokes `onTransition` whenever it changes in a meaningful way. Centralizes
 * the previous-ref bookkeeping that renderer lifecycle bridges otherwise
 * re-implement in parallel.
 *
 * The callback is captured by ref so changing its identity on every render
 * does not retrigger the classification effect; only `(status, userId)` do.
 */
export function useAuthIdentityTransition(
  status: AuthStatus,
  userId: string | null,
  onTransition: (transition: AuthIdentityTransition) => void,
): void {
  const previous = useRef<{
    readonly status: AuthStatus;
    readonly userId: string | null;
  } | null>(null);
  // An interactive attempt is in flight, or has just failed without an
  // intervening settled identity. This is deliberately SEPARATE from
  // `previous`, which holds the pre-attempt identity so the eventual settled
  // state is compared against what the user actually had. Folding the two
  // together is what made the failure edge below unreachable: holding the
  // attempt rewinds `previous` past the `signing-in` marker, so a
  // `prior.status === "signing-in"` test can never observe one.
  const attemptInFlight = useRef(false);
  // Whether this hook has classified ANY render yet - tracked apart from
  // `previous`, which the held-attempt branch below deliberately rewinds to
  // `null` on a first render in `signing-in`. Deriving "initial mount" from
  // `previous` alone reported the settled `signed-in` that ENDS an
  // interactive attempt as an initial mount, which the documented
  // `signing-in` -> `signed-in` transition is not.
  const hasClassified = useRef(false);
  const callbackRef = useRef(onTransition);
  // Read from the store rather than taken as a parameter: the twelve bridges
  // pass `(status, userId)` selected from this same store, and the cause is a
  // fact ABOUT `status` that only the reducer writing `signed-out` can know.
  // It is set in the same `set()` as the status, so the classification
  // effect always sees the pair together.
  const signedOutCause = useAuthStore((state) => state.signedOutCause);
  // `useLayoutEffect` keeps the ref write out of the render phase (eslint
  // react-hooks flags ref mutation during render) while still happening
  // synchronously before the classification effect below fires.
  useLayoutEffect(() => {
    callbackRef.current = onTransition;
  }, [onTransition]);

  useEffect(() => {
    const prior = previous.current;
    previous.current = { status, userId };
    const isInitialMount = !hasClassified.current;
    hasClassified.current = true;

    // Classified on IDENTITY PRESENCE, not on a cloud verdict. `unverified`
    // holds a stored identity read from disk - the same account, the same
    // `userId` - so an identity has NOT dropped out when a cold start cannot
    // reach authn or a refresh is rejected.
    //
    // Both directions matter. Treating `unverified` as absent would fire
    // `signedOut` on a rejection and PURGE the account-scoped local stores
    // (reading positions are deleted from disk outright), which is exactly
    // the in-progress local access a rejection must not tear down. And on an
    // offline cold start it would never fire `signedIn` at all, so the app
    // would mount with no composer settings, worktree memory, epic canvas or
    // reading positions bound - a half-working shell over the local plane.
    //
    // Consumers that genuinely need a live CLOUD session gate on
    // `status === "signed-in"` themselves (see `notifications-session-provider`),
    // which is the right place for that question.
    // AN ATTEMPT IS NOT A RETIREMENT. `signing-in` holds the prior identity
    // rather than reading as absent, and a `signed-out` reached FROM it does
    // not retire either.
    //
    // Without this, clicking "Sign in" while `unverified` fires `signedOut`
    // and every lifecycle bridge runs its destructive arm - reading positions
    // are deleted from disk outright - before any new identity exists. If the
    // attempt then fails, recovery re-admits the SAME on-disk identity and the
    // deleted state is already gone. The user pressed a button and lost local
    // data belonging to the account they still have.
    //
    // Holding the `signing-in` edge alone is not enough, and that is worth
    // stating because it looks sufficient: a failed attempt routes through
    // `applyFailure`, which lands on `signed-out` before recovery re-admits, so
    // the purge simply moves one transition later. The failure edge is safe to
    // hold for a REASON rather than out of caution - `applyFailure` never
    // touches the shared credentials file, so the identity provably still
    // exists on disk at that moment.
    //
    // The retirement paths are unaffected. An explicit `signOut()` USUALLY
    // goes signed-in/unverified -> signed-out directly, but not always: its
    // credentials-file delete is awaited, and a sign-in started during that
    // wait puts `signing-in` in front of the `signed-out` the delete then
    // lands. That sequence is byte-for-byte the failed-attempt one, and the
    // file IS gone, so holding it would leave every account-scoped store
    // bound to an identity the user explicitly retired. The sequence cannot
    // decide; `signedOutCause` can - the service projects `attempt-failed`
    // from the one path that leaves the file alone and `retired` from every
    // other, and only the former is held. A different account adopted
    // mid-attempt still emits `userSwitched`.
    //
    // RESIDUAL, stated rather than hidden: if the file turns out to be empty
    // after a failed attempt, the retirement is deferred to a later genuine
    // transition instead of firing here. That is the conservative direction -
    // state kept a little too long rather than destroyed a little too early -
    // and it is the direction this whole ticket is about.
    // The failure edge is tested against `attemptInFlight`, NOT against
    // `prior.status`: the `signing-in` branch below rewinds `previous` to the
    // pre-attempt identity, so by the time the failure lands `prior` reads as
    // `unverified`/`signed-in` and a status-based test is dead code.
    const isHeldAttempt =
      status === "signing-in" ||
      (status === "signed-out" &&
        attemptInFlight.current &&
        signedOutCause === "attempt-failed");
    if (isHeldAttempt) {
      // Keep the pre-attempt identity as `previous` so the eventual settled
      // state is compared against what the user actually had, not against the
      // attempt.
      previous.current = prior;
      attemptInFlight.current = true;
      return;
    }
    // Any settled outcome ends the attempt - the re-admit that follows a held
    // failure, the new identity that replaces it, or an outright retirement.
    attemptInFlight.current = false;

    const hasIdentity = admitsLocalPlane(status);
    const hadIdentity = prior !== null && admitsLocalPlane(prior.status);

    if (!hadIdentity && hasIdentity) {
      callbackRef.current({
        kind: "signedIn",
        userId,
        isInitialMount,
      });
      return;
    }
    if (hadIdentity && !hasIdentity) {
      callbackRef.current({ kind: "signedOut" });
      return;
    }
    if (hadIdentity && hasIdentity && prior.userId !== userId) {
      callbackRef.current({ kind: "userSwitched", userId });
    }
    // `signedOutCause` changes only together with `status` (each reducer
    // writes both), so listing it re-runs nothing on its own; it is here so
    // the closure the linter checks reads the value it classifies on.
  }, [status, userId, signedOutCause]);
}
