import { useEffect, useLayoutEffect, useRef } from "react";

/**
 * Discriminated transition classification emitted by `useAuthIdentityTransition`.
 *
 * - `signedIn` - the identity became signed-in. On the component's very first
 *   render `isInitialMount` is `true`; on a transition from `signed-out` /
 *   `signing-in` to `signed-in` it is `false`.
 * - `signedOut` - the identity dropped out of `signed-in` (sign-out, token
 *   rejection, or any other status flip off `signed-in`).
 * - `userSwitched` - the identity stayed `signed-in` but the email changed
 *   out from under the component (a new user took over the session).
 *
 * Idle renders - no change, or changes inside the same signed-in identity -
 * do not fire the callback at all.
 */
export type AuthIdentityTransition =
  | {
      readonly kind: "signedIn";
      readonly email: string | null;
      readonly isInitialMount: boolean;
    }
  | { readonly kind: "signedOut" }
  | { readonly kind: "userSwitched"; readonly email: string | null };

/**
 * Watches the authenticated identity `(status, email)` across renders and
 * invokes `onTransition` whenever it changes in a meaningful way. Centralizes
 * the previous-ref bookkeeping that renderer lifecycle bridges otherwise
 * re-implement in parallel.
 *
 * The callback is captured by ref so changing its identity on every render
 * does not retrigger the classification effect; only `(status, email)` do.
 */
export function useAuthIdentityTransition(
  status: string,
  email: string | null,
  onTransition: (transition: AuthIdentityTransition) => void,
): void {
  const previous = useRef<{
    readonly status: string;
    readonly email: string | null;
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
    previous.current = { status, email };

    const isSignedIn = status === "signed-in";
    const wasSignedIn = prior !== null && prior.status === "signed-in";

    if (!wasSignedIn && isSignedIn) {
      callbackRef.current({
        kind: "signedIn",
        email,
        isInitialMount: prior === null,
      });
      return;
    }
    if (wasSignedIn && !isSignedIn) {
      callbackRef.current({ kind: "signedOut" });
      return;
    }
    if (wasSignedIn && isSignedIn && prior.email !== email) {
      callbackRef.current({ kind: "userSwitched", email });
    }
  }, [status, email]);
}
