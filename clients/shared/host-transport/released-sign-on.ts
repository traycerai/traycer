import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import type { HostOwnerPrincipal } from "@traycer/protocol/host/host-status";
import type {
  BearerSourceProvider,
  OpenFrameBearerSource,
} from "../auth/bearer-source";
import type { StreamAuthRevalidator } from "../auth/bearer-revalidator";
import {
  authnDidNotAnswer,
  type TrackedHostTokens,
} from "../auth/host-token-lease";
import { readHostOwnershipViaHttp } from "../host-client/host-ownership";
import { hostDoorStateOfRefusal } from "./host-door-state";
import type { HostRequestAuthority } from "./host-messenger";

/** The directory facts the decision reads; a local row has no `sandbox`. */
export interface ReleasedSignOnRow {
  readonly owner?: HostOwnerPrincipal | null;
  readonly sandbox?: object | null;
}

/** How a transport opens a released host: with the person's sign-in. */
export interface ReleasedSignOn {
  readonly signIn: BearerSourceProvider;
  /** Recovers a sign-in the released host refused, as a released app did. */
  readonly recovery: StreamAuthRevalidator | null;
  /**
   * Whether the host's row allows the sign-in, asked only after a released
   * host refused the host-only token or none could be presented. `false` (or a
   * failed read) keeps the refusal as it is.
   */
  readonly allowed: () => Promise<boolean>;
  /**
   * This machine's host only: no host-only token can be presented
   * ({@link hostTokenUnobtainable}). A released client then opened its host
   * with the sign-in, and so does this one.
   */
  readonly hostTokenUnobtainable: () => boolean;
  /** What this process has seen of each host's answers; see {@link ReleasedHostMemory}. */
  readonly hosts: ReleasedHostMemory;
}

/**
 * Process memory only, per host id, never on disk and never keyed on a version.
 * A host that refused the host-only token the released way and then admitted
 * the sign-in is opened with the sign-in at once on later dials. That is
 * forgotten the moment the host admits a host-only token or refuses anything
 * naming its reason (it was updated). A host that has named a reason in this
 * process is never handed the sign-in again.
 */
export interface ReleasedHostMemory {
  readonly opensReleasedWay: (hostId: string) => boolean;
  readonly namedReason: (hostId: string) => boolean;
  readonly signInAdmitted: (hostId: string) => void;
  readonly hostTokenAdmitted: (hostId: string) => void;
  readonly refusedNamingReason: (hostId: string) => void;
}

export function createReleasedHostMemory(): ReleasedHostMemory {
  const released = new Set<string>();
  const current = new Set<string>();
  return {
    opensReleasedWay: (hostId) => released.has(hostId),
    namedReason: (hostId) => current.has(hostId),
    signInAdmitted: (hostId) => {
      if (!current.has(hostId)) released.add(hostId);
    },
    hostTokenAdmitted: (hostId) => {
      released.delete(hostId);
    },
    refusedNamingReason: (hostId) => {
      released.delete(hostId);
      current.add(hostId);
    },
  };
}

/** The memory every transport of this process shares. */
export const processReleasedHosts: ReleasedHostMemory =
  createReleasedHostMemory();

/**
 * A released host (client level 2) reads a person's own sign-in on `open` and
 * refuses a host-only token as an unknown credential. Across machines only the
 * person's own personal computer is handed the sign-in: never a team's
 * computer, a sandbox, or a row whose owner is not known.
 */
export function opensReleasedWay(
  row: ReleasedSignOnRow,
  userId: string,
): boolean {
  return (
    (row.sandbox ?? null) === null &&
    row.owner?.kind === "user" &&
    row.owner.id === userId
  );
}

/**
 * This machine's host may have no row yet: the app started with no cloud, or
 * authn has none for this person. Only a row known to be a team's, a
 * sandbox's or another person's is refused the sign-in.
 */
export function opensReleasedWayOnThisMachine(
  row: ReleasedSignOnRow | null,
  userId: string,
): boolean {
  if (row === null) return true;
  if ((row.sandbox ?? null) !== null) return false;
  const owner = row.owner ?? null;
  return owner === null || (owner.kind === "user" && owner.id === userId);
}

/**
 * The typed answer of a released host to a host-only token: `UNAUTHORIZED`, no
 * `doorReason`, not retryable. A current host always names its reason when it
 * refuses an open, so this never matches one; the message text is never read.
 */
export function isReleasedHostTokenRefusal(
  details: FatalErrorDetails,
): boolean {
  return (
    details.code === "UNAUTHORIZED" &&
    hostDoorStateOfRefusal(details) === "older-host"
  );
}

/**
 * Presented in place of a host-only token that cannot be had, never a
 * credential: a released host refuses it as it refuses any host-only token,
 * and only that answer lets the sign-in follow. A current host, which every
 * team computer and sandbox is, refuses it naming its reason.
 */
export const NO_HOST_TOKEN_PROBE = "no-host-only-token";

/**
 * No host-only token can be presented to this machine's host: authn has no row
 * for this person, or it did not answer (`authnDidNotAnswer`) and none is held.
 */
export function hostTokenUnobtainable(
  tokens: TrackedHostTokens,
  userId: string,
  hostId: string,
): boolean {
  return (
    tokens.lastMintFailure(userId, hostId) === "not-admitted" ||
    (authnDidNotAnswer(tokens, userId, hostId) &&
      tokens.current(userId, hostId) === null)
  );
}

/** For this machine's host when the caller holds its row; `null` unless the row allows it. */
export function releasedSignOnForLocalRow(
  row: ReleasedSignOnRow | null,
  hostId: string,
  userId: string,
  signIn: BearerSourceProvider,
  recovery: StreamAuthRevalidator | null,
  tokens: TrackedHostTokens,
  hosts: ReleasedHostMemory,
): ReleasedSignOn | null {
  return opensReleasedWayOnThisMachine(row, userId)
    ? {
        signIn,
        recovery,
        allowed: () => Promise.resolve(true),
        hostTokenUnobtainable: () =>
          hostTokenUnobtainable(tokens, userId, hostId),
        hosts,
      }
    : null;
}

/** What a unary call is sent with instead of, or after, the host-only token. */
export interface ReleasedUnarySignOn {
  readonly bearer: OpenFrameBearerSource;
  /** Refreshes a sign-in the released host refused; the call then goes once more. */
  readonly recovery: StreamAuthRevalidator | null;
}

/** Why the unary client asks: the host refused the token, or none could be presented. */
export type ReleasedUnaryCause = "refused" | "no-host-token";

/**
 * `WsRpcClientOptions.releasedSignOnFor` for this machine's host, for a caller
 * that holds the rows: the caller's own sign-in lease.
 */
export function signInForLocalRow(
  resolveRow: (hostId: string) => ReleasedSignOnRow | null,
  recovery: StreamAuthRevalidator | null,
  tokens: TrackedHostTokens,
): (
  authority: HostRequestAuthority,
  cause: ReleasedUnaryCause,
) => Promise<ReleasedUnarySignOn | null> {
  return (authority, cause) => {
    const hostId = authority.endpoint.hostId;
    const userId = authority.bearer.identity.userId;
    const allowed =
      opensReleasedWayOnThisMachine(resolveRow(hostId), userId) &&
      (cause === "refused" || hostTokenUnobtainable(tokens, userId, hostId));
    return Promise.resolve(
      allowed ? { bearer: authority.bearer, recovery } : null,
    );
  };
}

/**
 * For this machine's host when the caller holds no row: the row is read from
 * authn only when it is needed, and kept once authn answers it. With no answer
 * (authn unreachable, or refusing the sign-in) the host counts as the person's
 * own, as a released client counted it. `hostId` is the host dialed now.
 */
export function releasedLocalSignOnFromRegistry(deps: {
  readonly authnBaseUrl: string;
  readonly hostId: () => string | null;
  readonly signIn: BearerSourceProvider;
  readonly recovery: StreamAuthRevalidator | null;
  readonly hostTokenUnobtainable: () => boolean;
  readonly hosts: ReleasedHostMemory;
}): ReleasedSignOn {
  const answered = new Map<string, boolean>();
  return {
    signIn: deps.signIn,
    recovery: deps.recovery,
    hostTokenUnobtainable: deps.hostTokenUnobtainable,
    hosts: deps.hosts,
    allowed: async () => {
      const id = deps.hostId();
      const lease = deps.signIn();
      if (id === null || lease === null) return false;
      const known = answered.get(id);
      if (known !== undefined) return known;
      const row = await readHostOwnershipViaHttp(
        deps.authnBaseUrl,
        lease.getBearerToken(),
        id,
      );
      if (row.kind === "network-error" || row.kind === "unauthorized")
        return true;
      const allowed =
        row.kind === "not-found" ||
        opensReleasedWayOnThisMachine(
          {
            owner: row.host.owner,
            sandbox: row.host.kind === "sandbox" ? {} : null,
          },
          lease.identity.userId,
        );
      answered.set(id, allowed);
      return allowed;
    },
  };
}
