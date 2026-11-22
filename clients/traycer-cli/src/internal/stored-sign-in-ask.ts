import {
  MutableBearerLease,
  readLeaseBearer,
} from "@traycer-clients/shared/auth/bearer-source";
import {
  createCliCredentialsStore,
  createStoreBackedRevalidator,
} from "../store/credentials-store";
import type { SignInRevalidator } from "./cli-host-tokens";
import type { HostAuth } from "./host-auth";

/**
 * When the refresh itself fails, `first` is authn's refusal from before it.
 * A refreshed pair the store could not write to disk is still used, as by every
 * other command: the store re-drives the write and prints the disk line.
 */
type StoredSignInAnswer<Answer> =
  | { readonly kind: "answered"; readonly answer: Answer }
  | { readonly kind: "refresh-rejected"; readonly first: Answer }
  | { readonly kind: "refresh-unavailable"; readonly first: Answer };

type RefreshOutcome =
  | { readonly kind: "refreshed"; readonly token: string }
  | { readonly kind: "rejected" }
  | { readonly kind: "unavailable" };

/** The stored sign-in for one command run. */
export interface StoredSignIn {
  /** The stored sign-in, or the one its refresh returned. */
  current(): HostAuth;
  /**
   * Asks authn on the current sign-in. A refusal the caller names (a 401) gets
   * the run's one refresh and one more ask on the refreshed token. Every later
   * refusal, and every refusal while that refresh is in flight, shares it: the
   * run never refreshes twice, and an ask already refused on the refreshed
   * token is not sent again.
   */
  ask<Answer>(
    ask: (token: string) => Promise<Answer>,
    refused: (answer: Answer) => boolean,
    signal: AbortSignal | null,
  ): Promise<StoredSignInAnswer<Answer>>;
}

export function openStoredSignIn(auth: HostAuth): StoredSignIn {
  let signedIn = auth;
  let refresh: Promise<RefreshOutcome> | null = null;
  const refreshOnce = (signal: AbortSignal | null): Promise<RefreshOutcome> => {
    if (refresh === null) {
      refresh = refreshStoredSignIn(auth, signal).then((outcome) => {
        if (outcome.kind === "refreshed")
          signedIn = { ...auth, token: outcome.token };
        return outcome;
      });
    }
    return refresh;
  };
  return {
    current: () => signedIn,
    async ask(ask, refused, signal) {
      const sentOn = signedIn.token;
      const first = await ask(sentOn);
      if (!refused(first)) return { kind: "answered", answer: first };
      const outcome = await refreshOnce(signal);
      if (outcome.kind === "unavailable")
        return { kind: "refresh-unavailable", first };
      if (outcome.kind === "rejected")
        return { kind: "refresh-rejected", first };
      // Sent after the run's refresh had landed: refused on the refreshed token.
      if (sentOn !== auth.token) return { kind: "answered", answer: first };
      return { kind: "answered", answer: await ask(outcome.token) };
    },
  };
}

/** One spend under the credentials lock; a sibling's landed pair is adopted. */
async function refreshStoredSignIn(
  auth: HostAuth,
  signal: AbortSignal | null,
): Promise<RefreshOutcome> {
  const lease = new MutableBearerLease(auth.token, auth.userId);
  const store = createCliCredentialsStore();
  // Typed to its own refresh, as the mint's is: the shared `AuthRevalidator`
  // it also satisfies declares the same method as `Promise<unknown>`.
  const revalidator: SignInRevalidator = createStoreBackedRevalidator({
    store,
    lease,
    signal,
  });
  try {
    const refreshed = await revalidator.revalidateCurrentContext();
    if (refreshed === "network-error") return { kind: "unavailable" };
    if (refreshed === "rejected") return { kind: "rejected" };
  } finally {
    store.dispose();
  }
  const token = readLeaseBearer(lease);
  return token === null ? { kind: "rejected" } : { kind: "refreshed", token };
}
