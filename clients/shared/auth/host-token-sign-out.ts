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
 *
 * The first read can settle after a change. It names who the store held
 * before that change, so that person is forgotten unless they are the one
 * held now.
 */
export function forgetHostTokensOnSignOut(
  signedIn: SignedInWatch,
  hostTokens: HostTokenSource,
): () => void {
  let held: string | null = null;
  let changed = false;
  const forget = (userId: string): void => {
    void hostTokens.forgetUser(userId).catch(() => undefined);
  };
  void signedIn.current().then(
    (userId) => {
      if (!changed) held = userId;
      else if (userId !== null && userId !== held) forget(userId);
    },
    () => undefined,
  );
  return signedIn.onChange((userId) => {
    changed = true;
    const previous = held;
    held = userId;
    if (previous !== null && previous !== userId) forget(previous);
  });
}
