import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import type { HostOwnerPrincipal } from "@traycer/protocol/host/host-status";
import type {
  BearerSourceProvider,
  OpenFrameBearerSource,
} from "../auth/bearer-source";
import type { StreamAuthRevalidator } from "../auth/bearer-revalidator";
import { readHostOwnershipViaHttp } from "../host-client/host-ownership";
import { hostDoorStateOfRefusal } from "./host-door-state";
import type { HostRequestAuthority } from "./host-messenger";

/** The directory facts the decision reads; a local row has no `sandbox`. */
export interface ReleasedSignOnRow {
  readonly owner?: HostOwnerPrincipal | null;
  readonly sandbox?: object | null;
}

/** How a transport answers a released host's refusal of the host-only token. */
export interface ReleasedSignOn {
  readonly signIn: BearerSourceProvider;
  /** Recovers a sign-in the released host refused, as a released app did. */
  readonly recovery: StreamAuthRevalidator | null;
  /**
   * `opensReleasedWay` for the host's row, asked only after such a refusal.
   * `false` (or a failed read) keeps the refusal as it is.
   */
  readonly allowed: () => Promise<boolean>;
}

/** For a caller that holds the row: `null` unless the row allows it. */
export function releasedSignOnForRow(
  row: ReleasedSignOnRow,
  userId: string,
  signIn: BearerSourceProvider,
  recovery: StreamAuthRevalidator | null,
): ReleasedSignOn | null {
  return opensReleasedWay(row, userId)
    ? { signIn, recovery, allowed: () => Promise.resolve(true) }
    : null;
}

/**
 * A released host (client level 2) reads a person's own sign-in on `open` and
 * refuses a host-only token as an unknown credential. Only the person's own
 * personal computer is ever handed the sign-in: never a team's computer, a
 * sandbox, or a row whose owner is not known.
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
 * The typed answer of a released host to a host-only token: `UNAUTHORIZED`, no
 * `doorReason`, not retryable. A current host always names its reason, so this
 * never matches one; the message text is never read.
 */
export function isReleasedHostTokenRefusal(
  details: FatalErrorDetails,
): boolean {
  return (
    details.code === "UNAUTHORIZED" &&
    hostDoorStateOfRefusal(details) === "older-host"
  );
}

/** What a unary call is sent with once more after a released host's refusal. */
export interface ReleasedUnarySignOn {
  readonly bearer: OpenFrameBearerSource;
  /** Refreshes a sign-in the released host refused; the call then goes once more. */
  readonly recovery: StreamAuthRevalidator | null;
}

/**
 * `WsRpcClientOptions.releasedSignOnFor` for a caller that holds the rows: the
 * caller's own sign-in lease, for that person's own personal computer only.
 */
export function signInForReleasedRow(
  resolveRow: (hostId: string) => ReleasedSignOnRow | null,
  recovery: StreamAuthRevalidator | null,
): (authority: HostRequestAuthority) => Promise<ReleasedUnarySignOn | null> {
  return (authority) => {
    const row = resolveRow(authority.endpoint.hostId);
    return Promise.resolve(
      row !== null && opensReleasedWay(row, authority.bearer.identity.userId)
        ? { bearer: authority.bearer, recovery }
        : null,
    );
  };
}

/**
 * For a caller that holds no row: the row is read from authn only after a
 * released host refused the host-only token, and kept once authn answers it.
 * An unreachable authn, or one that refuses the sign-in, answers `false` for
 * that refusal and is asked again on the next. `hostId` is the host the
 * client dials now.
 */
export function releasedSignOnFromRegistry(deps: {
  readonly authnBaseUrl: string;
  readonly hostId: () => string | null;
  readonly signIn: BearerSourceProvider;
  readonly recovery: StreamAuthRevalidator | null;
}): ReleasedSignOn {
  const answered = new Map<string, boolean>();
  return {
    signIn: deps.signIn,
    recovery: deps.recovery,
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
        return false;
      const allowed =
        row.kind === "ok" &&
        row.host.kind !== "sandbox" &&
        opensReleasedWay(
          { owner: row.host.owner, sandbox: null },
          lease.identity.userId,
        );
      answered.set(id, allowed);
      return allowed;
    },
  };
}
