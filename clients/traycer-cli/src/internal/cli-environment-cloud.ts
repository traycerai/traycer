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

/**
 * How this command's one refresh ended, judged under the credentials lock:
 * - `refreshed`: this command spent the refresh token and committed the pair;
 * - `not-own`: the stored sign-in is no longer the one this command holds (a
 *   sign-out, another sign-in, another process's refresh), so nothing is sent
 *   on it;
 * - `rejected`: authn refused the refresh;
 * - `unreachable`: nothing judged the sign-in.
 */
type OwnRefresh = "refreshed" | "not-own" | "rejected" | "unreachable";

/**
 * The stored sign-in's user id and token, or null when there is none (signed
 * out, an empty token) or the file cannot be read now: a sign-in that cannot
 * be shown to be the same one is not.
 */
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

  // The same sign-in, not only the same person: the stored token is the one
  // this command holds, which moves only with this command's own refresh
  // below. A sign-out and sign-in again, as anyone, writes a token this
  // command never held. The stored file names no sign-in session, so another
  // process's refresh reads as a change too: the command then stops rather
  // than act on a sign-in it cannot show is its own.
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
  const refresh = async (signal: AbortSignal): Promise<OwnRefresh> => {
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

  const transport: EnvironmentTransport = async (request) => {
    const answer = await fetchEnvironmentTransport(request);
    if (answer.status !== 401 || refreshSpent) return answer;
    refreshSpent = true;
    if (!onOriginSignIn()) return answer;
    const outcome = await refresh(request.signal);
    if (outcome === "rejected") rejected = true;
    if (outcome !== "refreshed" || !onOriginSignIn()) return answer;
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
