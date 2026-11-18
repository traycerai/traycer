import type { HostTokenSource } from "./host-token-source";

export interface SignedInWatch {
  readonly current: () => Promise<string | null>;
  readonly onChange: (listener: (userId: string | null) => void) => () => void;
}

// The first read can settle after changes: the first change is kept, and a person it
// names other than the read's is forgotten once. Signing out and back in as the same
// person still counts as leaving.
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
