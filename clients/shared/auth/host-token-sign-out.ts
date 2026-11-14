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
 * The first read can settle after changes. Until then a change has no one to
 * compare with, so the first one is kept: if it names anyone other than the
 * person the read returns, that person left before it, and is forgotten once.
 * A sign-out and a sign-in back as the same person is still a leave.
 */
export function forgetHostTokensOnSignOut(
  signedIn: SignedInWatch,
  hostTokens: HostTokenSource,
): () => void {
  let held: string | null = null;
  let settled = false;
  let firstChange: { readonly userId: string | null } | null = null;
  const forget = (userId: string): void => {
    void hostTokens.forgetUser(userId).catch(() => undefined);
  };
  void signedIn.current().then(
    (userId) => {
      settled = true;
      if (firstChange === null) held = userId;
      else if (userId !== null && firstChange.userId !== userId) forget(userId);
    },
    () => undefined,
  );
  return signedIn.onChange((userId) => {
    if (!settled && firstChange === null) firstChange = { userId };
    const previous = held;
    held = userId;
    if (previous !== null && previous !== userId) forget(previous);
  });
}
