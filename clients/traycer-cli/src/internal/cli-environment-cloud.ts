import { readFileSync } from "node:fs";
import { parseStoredCredentials } from "@traycer/protocol/config/credentials";
import {
  MutableBearerLease,
  readLeaseBearer,
} from "@traycer-clients/shared/auth/bearer-source";
import type { RevalidateOutcome } from "@traycer-clients/shared/auth/bearer-revalidator";
import {
  fetchEnvironmentTransport,
  type EnvironmentCloud,
  type EnvironmentTransport,
} from "@traycer-clients/shared/environment/environment-cloud";
import { config } from "../config";
import {
  createCliCredentialsStore,
  createStoreBackedRevalidator,
} from "../store/credentials-store";
import { cliCredentialsPath } from "../store/paths";
import type { HostAuth } from "./host-auth";

/**
 * The CLI's calls to authn's environment routes, on the stored sign-in the
 * command started with, so `runEnvironmentMove` and `recordMoveAcceptance`
 * run here as they do in the app.
 */
export interface CliEnvironmentCloud {
  readonly cloud: EnvironmentCloud;
  /**
   * Whether authn rejected the stored sign-in for good: it refused the one
   * refresh, or refused the one resend after a refresh it accepted. A refresh
   * that could not reach authn judges nothing.
   */
  readonly signInRejected: () => boolean;
}

interface SignInRefresh {
  revalidateCurrentContext(): Promise<RevalidateOutcome>;
}

/**
 * The user id of the stored sign-in, or null when there is none (signed out,
 * an empty token) or the file cannot be read now: a sign-in that cannot be
 * shown to be the same one is not.
 */
function storedSignInUserId(): string | null {
  try {
    const stored = parseStoredCredentials(
      JSON.parse(readFileSync(cliCredentialsPath(config.environment), "utf8")),
    );
    return stored !== null && stored.token.length > 0 ? stored.user.id : null;
  } catch {
    return null;
  }
}

/**
 * One command's {@link EnvironmentCloud}, bound to `auth`, the sign-in it
 * started with. Its transport is the shared one, which never follows a
 * redirect; on a 401 it refreshes the stored sign-in once, under the
 * credentials lock, and sends that request once more on the refreshed token.
 * A 401 answers nothing authn took, so the resend repeats no write.
 */
export function createCliEnvironmentCloud(auth: HostAuth): CliEnvironmentCloud {
  const lease = new MutableBearerLease(auth.token, auth.userId);
  let refreshSpent = false;
  let rejected = false;

  const onOriginSignIn = (): boolean => storedSignInUserId() === auth.userId;

  const refresh = async (signal: AbortSignal): Promise<RevalidateOutcome> => {
    const store = createCliCredentialsStore();
    try {
      // Named, as `credential-provisioning.ts` does: the factory's return also
      // satisfies `AuthRevalidator`, whose overload answers `Promise<unknown>`.
      const revalidator: SignInRefresh = createStoreBackedRevalidator({
        store,
        lease,
        signal,
      });
      return await revalidator.revalidateCurrentContext();
    } finally {
      store.dispose();
    }
  };

  const transport: EnvironmentTransport = async (request) => {
    const answer = await fetchEnvironmentTransport(request);
    if (answer.status !== 401 || refreshSpent) return answer;
    refreshSpent = true;
    const outcome = await refresh(request.signal);
    if (outcome === "rejected") rejected = true;
    if (outcome !== "rotated" || !onOriginSignIn()) return answer;
    const token = readLeaseBearer(lease);
    if (token === null) return answer;
    const again = await fetchEnvironmentTransport({
      ...request,
      headers: { ...request.headers, Authorization: `Bearer ${token}` },
    });
    if (again.status === 401) rejected = true;
    return again;
  };

  return {
    cloud: {
      authnBaseUrl: auth.authnBaseUrl,
      bearer: { kind: "cloud", getBearerToken: () => readLeaseBearer(lease) },
      transport,
      onOriginSignIn,
    },
    signInRejected: () => rejected,
  };
}
