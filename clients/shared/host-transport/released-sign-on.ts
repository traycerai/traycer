import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import type { HostOwnerPrincipal } from "@traycer/protocol/host/host-status";
import type {
  BearerSourceProvider,
  OpenFrameBearerSource,
} from "../auth/bearer-source";
import type { StreamAuthRevalidator } from "../auth/bearer-revalidator";
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
export function isReleasedHostTokenRefusal(details: FatalErrorDetails): boolean {
  return (
    details.code === "UNAUTHORIZED" &&
    hostDoorStateOfRefusal(details) === "older-host"
  );
}

/**
 * `WsRpcClientOptions.releasedSignOnFor` for a caller that holds the rows: the
 * caller's own sign-in lease, for that person's own personal computer only.
 */
export function signInForReleasedRow(
  resolveRow: (hostId: string) => ReleasedSignOnRow | null,
): (authority: HostRequestAuthority) => Promise<OpenFrameBearerSource | null> {
  return (authority) => {
    const row = resolveRow(authority.endpoint.hostId);
    return Promise.resolve(
      row !== null && opensReleasedWay(row, authority.bearer.identity.userId)
        ? authority.bearer
        : null,
    );
  };
}
