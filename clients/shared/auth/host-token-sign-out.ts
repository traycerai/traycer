import type { HostTokenSource } from "./host-token-source";

/** Who the sign-in store holds, and when that changes. */
export interface SignedInWatch {
  readonly current: () => Promise<string | null>;
  readonly onChange: (listener: (userId: string | null) => void) => () => void;
}

/**
 * Removes a person's host-only tokens once the sign-in store no longer holds
 * them: a sign-out, from this app or any other writer of the same store, and
 * the account a switch replaced. Driven by the store's own change event.
 */
export function forgetHostTokensOnSignOut(
  signedIn: SignedInWatch,
  hostTokens: HostTokenSource,
): () => void {
  let held: string | null = null;
  let changed = false;
  void signedIn.current().then(
    (userId) => {
      if (!changed) held = userId;
    },
    () => undefined,
  );
  return signedIn.onChange((userId) => {
    changed = true;
    const previous = held;
    held = userId;
    if (previous !== null && previous !== userId)
      void hostTokens.forgetUser(previous).catch(() => undefined);
  });
}
