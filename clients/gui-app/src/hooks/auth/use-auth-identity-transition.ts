import { useEffect, useLayoutEffect, useRef } from "react";

/**
 * Discriminated transition classification emitted by `useAuthIdentityTransition`.
 *
 * - `signedIn` - the identity became signed-in. On the component's very first
 *   render `isInitialMount` is `true`; on a transition from `signed-out` /
 *   `signing-in` to `signed-in` it is `false`.
 * - `signedOut` - the identity dropped out of `signed-in` (sign-out, token
 *   rejection, or any other status flip off `signed-in`).
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
  status: string,
  userId: string | null,
  onTransition: (transition: AuthIdentityTransition) => void,
): void {
  const previous = useRef<{
    readonly status: string;
    readonly userId: string | null;
  } | null>(null);
  const callbackRef = useRef(onTransition);
  // `useLayoutEffect` keeps the ref write out of the render phase (eslint
  // react-hooks flags ref mutation during render) while still happening
  // synchronously before the classification effect below fires.
  useLayoutEffect(() => {
    callbackRef.current = onTransition;
  }, [onTransition]);

  useEffect(() => {
    const prior = previous.current;
    previous.current = { status, userId };

    const isSignedIn = status === "signed-in";
    const wasSignedIn = prior !== null && prior.status === "signed-in";

    if (!wasSignedIn && isSignedIn) {
      callbackRef.current({
        kind: "signedIn",
        userId,
        isInitialMount: prior === null,
      });
      return;
    }
    if (wasSignedIn && !isSignedIn) {
      callbackRef.current({ kind: "signedOut" });
      return;
    }
    if (wasSignedIn && isSignedIn && prior.userId !== userId) {
      callbackRef.current({ kind: "userSwitched", userId });
    }
  }, [status, userId]);
}
