import { readFileSync } from "node:fs";
import { parseStoredCredentials } from "@traycer/protocol/config/credentials";
import {
  MutableBearerLease,
  readLeaseBearer,
} from "@traycer-clients/shared/auth/bearer-source";
import {
  fetchEnvironmentTransport,
  type EnvironmentCloud,
  type EnvironmentTransport,
} from "@traycer-clients/shared/environment/environment-cloud";
import { config } from "../config";
import {
  createCliCredentialsStore,
  withCommitRetry,
} from "../store/credentials-store";
import { cliCredentialsPath } from "../store/paths";
import type { HostAuth } from "./host-auth";

/** On the stored sign-in the command started with, so the move runs here as in the app. */
export interface CliEnvironmentCloud {
  readonly cloud: EnvironmentCloud;
  /** It refused the one refresh, or the one resend after an accepted one; an unreachable refresh judges nothing. */
  readonly signInRejected: () => boolean;
  /**
   * After a 401 on a call outside the transport: the command's one refresh, if
   * unspent and still this sign-in, and the token to resend on. Null otherwise.
   */
  readonly renewAfterRefusal: (
    signal: AbortSignal | null,
  ) => Promise<string | null>;
}

/** `not-own`: no longer the sign-in this command holds (a sign-out, another sign-in, another process's refresh). */
type OwnRefresh = "refreshed" | "not-own" | "rejected" | "unreachable";

/** Null when none or unreadable now: a sign-in that cannot be shown to be the same one is not. */
function storedSignIn(): {
  readonly userId: string;
  readonly token: string;
} | null {
  try {
    const stored = parseStoredCredentials(
      JSON.parse(readFileSync(cliCredentialsPath(config.environment), "utf8")),
    );
    return stored !== null && stored.token.length > 0
      ? { userId: stored.user.id, token: stored.token }
      : null;
  } catch {
    return null;
  }
}

/**
 * Never follows a redirect. On a 401 it refreshes once under the credentials lock
 * and resends once: a 401 answers nothing authn took, so the resend repeats no write.
 */
export function createCliEnvironmentCloud(auth: HostAuth): CliEnvironmentCloud {
  const lease = new MutableBearerLease(auth.token, auth.userId);
  let refreshSpent = false;
  let rejected = false;

  // The same sign-in, not only the same person. The file names no session, so another
  // process's refresh reads as a change: the command stops rather than act on it.
  const onOriginSignIn = (): boolean => {
    const stored = storedSignIn();
    return (
      stored !== null &&
      stored.userId === auth.userId &&
      stored.token === readLeaseBearer(lease)
    );
  };

  // The store's own rotate, not the shared revalidator: the revalidator adopts
  // a `superseded` pair as a refresh, which here is another sign-in. Only a
  // pair this command committed under the lock continues its sign-in.
  const refresh = async (signal: AbortSignal | null): Promise<OwnRefresh> => {
    const held = readLeaseBearer(lease);
    if (held === null) return "not-own";
    const store = createCliCredentialsStore();
    try {
      const result = await withCommitRetry(
        () =>
          store.rotate({
            expectedUserId: auth.userId,
            expectedToken: held,
            refreshTokenOverride: null,
            signal,
          }),
        signal,
      );
      switch (result.outcome) {
        case "applied":
          if (result.credentials === null) return "not-own";
          lease.rotate(result.credentials.token);
          return "refreshed";
        // A pair still landing (`commit-failed`) is not on disk, and one that
        // landed on a retry reads as `superseded`: neither is shown to be this
        // command's sign-in, so neither is used.
        case "superseded":
        case "commit-failed":
        case "user-mismatch":
        case "deleted":
        case "tombstoned":
          return "not-own";
        case "refresh-rejected-credential":
        case "refresh-rejected-account":
          return "rejected";
        case "refresh-network":
        case "lock-busy":
        case "spend-pending":
        case "disk-full":
          return "unreachable";
      }
    } catch {
      return "unreachable";
    } finally {
      store.dispose();
    }
  };

  // The command's one refresh, whichever call's 401 asks for it first.
  const renewAfterRefusal = async (
    signal: AbortSignal | null,
  ): Promise<string | null> => {
    if (refreshSpent) return null;
    refreshSpent = true;
    if (!onOriginSignIn()) return null;
    const outcome = await refresh(signal);
    if (outcome === "rejected") rejected = true;
    if (outcome !== "refreshed" || !onOriginSignIn()) return null;
    return readLeaseBearer(lease);
  };

  const transport: EnvironmentTransport = async (request) => {
    const answer = await fetchEnvironmentTransport(request);
    if (answer.status !== 401) return answer;
    const token = await renewAfterRefusal(request.signal);
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
    renewAfterRefusal,
  };
}
