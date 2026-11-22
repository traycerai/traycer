import {
  MutableBearerLease,
  readLeaseBearer,
} from "@traycer-clients/shared/auth/bearer-source";
import type { RevalidateOutcome } from "@traycer-clients/shared/auth/bearer-revalidator";
import {
  createCliCredentialsStore,
  createStoreBackedRevalidator,
} from "../store/credentials-store";
import type { SignInRevalidator } from "./cli-host-tokens";
import type { HostAuth } from "./host-auth";

/**
 * `answered` carries the sign-in the answer was had on: the stored one, or the
 * one the refresh saved. When the refresh itself fails, `first` is authn's
 * refusal from before it.
 */
export type StoredSignInAnswer<Answer> =
  | {
      readonly kind: "answered";
      readonly answer: Answer;
      readonly auth: HostAuth;
    }
  | { readonly kind: "refresh-rejected"; readonly first: Answer }
  | { readonly kind: "refresh-unavailable"; readonly first: Answer };

/**
 * Asks authn on the stored sign-in. A refusal refreshes it once under the
 * credentials lock, saves it, and asks once more on the refreshed token; a
 * refusal of that second ask is the answer, never a second refresh.
 */
export async function askWithStoredSignIn<Answer>(
  auth: HostAuth,
  ask: (token: string) => Promise<Answer>,
  refused: (answer: Answer) => boolean,
  signal: AbortSignal | null,
): Promise<StoredSignInAnswer<Answer>> {
  const first = await ask(auth.token);
  if (!refused(first)) return { kind: "answered", answer: first, auth };
  const lease = new MutableBearerLease(auth.token, auth.userId);
  const store = createCliCredentialsStore();
  // Typed to its own refresh, as the mint's is: the shared `AuthRevalidator`
  // it also satisfies declares the same method as `Promise<unknown>`.
  const revalidator: SignInRevalidator = createStoreBackedRevalidator({
    store,
    lease,
    signal,
  });
  let refreshed: RevalidateOutcome;
  try {
    refreshed = await revalidator.revalidateCurrentContext();
  } finally {
    store.dispose();
  }
  if (refreshed === "network-error")
    return { kind: "refresh-unavailable", first };
  if (refreshed === "rejected") return { kind: "refresh-rejected", first };
  const token = readLeaseBearer(lease);
  if (token === null) return { kind: "refresh-rejected", first };
  return {
    kind: "answered",
    answer: await ask(token),
    auth: { ...auth, token },
  };
}
