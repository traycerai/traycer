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
 * When the refreshed pair cannot be saved, the store behaves as for every other
 * command (`withCommitRetry`, `store/credentials-store.ts`):
 * - a write refused for lack of space before anything is spent: the disk line
 *   is printed, the refresh counts as unavailable, and `first` stands, not sent
 *   again;
 * - spent, and still unsaved after up to three more save attempts a second
 *   apart: the pair is used from memory and the call is sent again on it. If
 *   the pair is still unsaved, the warning is printed when the store's final
 *   result reports low disk space. The spent-base marker it leaves lets a later
 *   command recover the pair only while authn can still replay that rotation;
 * - spent, and a later save attempt lands it: as an ordinary refresh.
 */
type StoredSignInAnswer<Answer> =
  | { readonly kind: "answered"; readonly answer: Answer }
  | { readonly kind: "refresh-rejected"; readonly first: Answer }
  | { readonly kind: "refresh-unavailable"; readonly first: Answer };

type RefreshOutcome =
  | { readonly kind: "refreshed"; readonly token: string }
  | { readonly kind: "rejected" }
  | { readonly kind: "unavailable" };

/** One sign-in generation: the stored one, then the one its refresh returned. */
interface Generation {
  readonly auth: HostAuth;
}

/** A stored sign-in and its one refresh, held by one claim, one record or one environments read. */
export interface StoredSignIn {
  /** The stored sign-in, or the one its refresh returned. */
  current(): HostAuth;
  /** True once a refusal has asked for the refresh, whatever it answered. */
  refreshSpent(): boolean;
  /**
   * Asks authn on the current sign-in. A response the caller classifies as a
   * refusal can trigger one resend after the store rotates the sign-in or adopts
   * a newer pair. Refusals on the original generation share one refresh attempt.
   * A refusal on the replacement generation is final.
   */
  ask<Answer>(
    ask: (token: string) => Promise<Answer>,
    refused: (answer: Answer) => boolean,
    signal: AbortSignal | null,
  ): Promise<StoredSignInAnswer<Answer>>;
}

export function openStoredSignIn(auth: HostAuth): StoredSignIn {
  const stored: Generation = { auth };
  let generation = stored;
  // Runs under the signal of the first caller it refuses, and only that signal
  // cuts it. A caller that joins it in flight waits, whatever its own signal
  // does, for the first caller's path: the lock wait (`CREDENTIALS_LOCK_WAIT_MS`,
  // 12 s, `store/credentials-store.ts`), the refresh request (10 s,
  // `AUTH_FETCH_TIMEOUT_MS` in `shared/auth/auth-validation.ts`), and, after a
  // spend whose save fails, up to three more save attempts a second apart, each
  // taking the lock again. No caller asks on one sign-in concurrently today.
  let refresh: Promise<RefreshOutcome> | null = null;
  const refreshOnce = (signal: AbortSignal | null): Promise<RefreshOutcome> => {
    if (refresh === null) {
      refresh = refreshStoredSignIn(auth, signal).then((outcome) => {
        if (outcome.kind === "refreshed")
          generation = { auth: { ...auth, token: outcome.token } };
        return outcome;
      });
    }
    return refresh;
  };
  return {
    current: () => generation.auth,
    refreshSpent: () => refresh !== null,
    async ask(ask, refused, signal) {
      // The generation, not the token text: a refresh may return the same
      // access token with a new refresh token.
      const sentOn = generation;
      const first = await ask(sentOn.auth.token);
      if (!refused(first)) return { kind: "answered", answer: first };
      const outcome = await refreshOnce(signal);
      if (outcome.kind === "unavailable")
        return { kind: "refresh-unavailable", first };
      if (outcome.kind === "rejected")
        return { kind: "refresh-rejected", first };
      // Sent on the refreshed sign-in: its refusal is final.
      if (sentOn !== stored) return { kind: "answered", answer: first };
      return { kind: "answered", answer: await ask(outcome.token) };
    },
  };
}

/**
 * Uses locked rotation. If the store finds a different access token for the
 * same account, it can adopt that pair without sending a refresh request.
 */
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
