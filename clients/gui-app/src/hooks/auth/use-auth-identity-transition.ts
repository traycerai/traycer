import { useEffect, useLayoutEffect, useRef } from "react";

/** Idle same-identity renders do not fire. Carried value is userId, never email (two accounts can share an address). */
export type AuthIdentityTransition =
  | {
      readonly kind: "signedIn";
      readonly userId: string | null;
      readonly isInitialMount: boolean;
    }
  | { readonly kind: "signedOut" }
  | { readonly kind: "userSwitched"; readonly userId: string | null };

/** The callback is captured by ref so changing its identity on every render does not retrigger the classification effect; only `(status, userId)` do. */
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
