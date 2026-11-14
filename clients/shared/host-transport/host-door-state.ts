import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import type { HostRpcError } from "@traycer/protocol/host-transport/remote/rpc-types";
import {
  readDoorReason,
  type HostDoorReason,
} from "@traycer/protocol/framework/door-reason";

/**
 * Why the app cannot use a host right now, as the app's own state: the eight
 * messages of the team host identity plan ("The eight messages, end to end"),
 * plus the three refusals that sit beside them.
 *
 * Every recovery is keyed on the host's `doorReason`, never on its `code`, and
 * nothing a host says starts sign-in recovery. `session_revoked` is not a
 * state here: it takes the ordinary sign-out path.
 */
export type HostDoorStateKind =
  /** authn unreachable when opening, and no usable token on disk. */
  | "token-unavailable"
  /** A renewal failed; the host keeps the connection under its outage exception. */
  | "access-check-delayed"
  /** `keys_unavailable`: the host has never fetched its verification keys. */
  | "keys-unavailable"
  /** `clock_skew`: the host's clock is wrong. */
  | "clock-skew"
  /** The token ran out offline, or the host answered `token_expired` and the app cannot renew. */
  | "token-expired"
  /** `enrolment_broken`: a team computer holds no valid credential of its own. */
  | "enrolment-broken"
  /** `membership_removed`: removed from the team while connected. */
  | "membership-removed"
  /** authn refused the token and its answer says the computer is a team's. */
  | "not-a-member"
  /** A second `not_admitted` after one fresh token, or a mint refusal that does not say "team". */
  | "not-admitted"
  /** `host_claimed`: a member claimed the computer. */
  | "host-claimed"
  /** A host-only token refused with no `doorReason`: `UNAUTHORIZED` or a team-membership code. */
  | "older-host"
  /** A `doorReason` this app does not know: a newer host, never an older one. */
  | "unrecognised-refusal";

/** Who raises a state. A mint that cannot reach authn never reaches a host. */
export type HostDoorStateSource = "app" | "host" | "authn";

/**
 * How the app gets out of a state by itself:
 * - `backoff`: it keeps retrying on the reconnect ladder.
 * - `when-online`: it retries once the network is back.
 * - `none`: it waits for the person or an Admin to act.
 */
export type HostDoorStateRetry = "backoff" | "when-online" | "none";

/** What clears a state. */
export type HostDoorStateClears =
  | "token-obtained"
  | "renewal-succeeded"
  | "host-connects-once"
  | "clock-corrected"
  | "admin-restores-enrolment"
  | "admin-adds-back"
  | "account-switched"
  | "host-updated";

export interface HostDoorStatePolicy {
  readonly raisedBy: readonly HostDoorStateSource[];
  readonly blocks: boolean;
  readonly retry: HostDoorStateRetry;
  /** `null` where nothing the app can watch clears it: a newer host's reason, a claimed computer. */
  readonly clears: HostDoorStateClears | null;
}

export const HOST_DOOR_STATE_POLICY: Readonly<
  Record<HostDoorStateKind, HostDoorStatePolicy>
> = {
  "token-unavailable": {
    raisedBy: ["app"],
    blocks: true,
    retry: "backoff",
    clears: "token-obtained",
  },
  "access-check-delayed": {
    raisedBy: ["app"],
    blocks: false,
    retry: "backoff",
    clears: "renewal-succeeded",
  },
  "keys-unavailable": {
    raisedBy: ["host"],
    blocks: true,
    retry: "backoff",
    clears: "host-connects-once",
  },
  "clock-skew": {
    raisedBy: ["host"],
    blocks: true,
    retry: "backoff",
    clears: "clock-corrected",
  },
  "token-expired": {
    raisedBy: ["app", "host"],
    blocks: true,
    retry: "when-online",
    clears: "token-obtained",
  },
  "enrolment-broken": {
    raisedBy: ["host"],
    blocks: true,
    retry: "backoff",
    clears: "admin-restores-enrolment",
  },
  "membership-removed": {
    raisedBy: ["host"],
    blocks: true,
    retry: "none",
    clears: "admin-adds-back",
  },
  "not-a-member": {
    raisedBy: ["authn"],
    blocks: true,
    retry: "none",
    clears: "account-switched",
  },
  "not-admitted": {
    raisedBy: ["host", "authn"],
    blocks: true,
    retry: "none",
    clears: "account-switched",
  },
  "host-claimed": {
    raisedBy: ["host"],
    blocks: true,
    retry: "none",
    clears: null,
  },
  "older-host": {
    raisedBy: ["host"],
    blocks: true,
    retry: "none",
    clears: "host-updated",
  },
  "unrecognised-refusal": {
    raisedBy: ["host"],
    blocks: true,
    retry: "none",
    clears: null,
  },
};

/**
 * One host's door state. `detail` is the refusal's code and reason as the
 * host or authn sent them, for the detail block; `null` for a state the app
 * raised itself.
 */
export interface HostDoorState {
  readonly hostId: string;
  readonly kind: HostDoorStateKind;
  readonly detail: {
    readonly code: string;
    readonly doorReason: string | null;
  } | null;
}

const DOOR_REASON_STATES: Readonly<
  Record<HostDoorReason, HostDoorStateKind | null>
> = {
  keys_unavailable: "keys-unavailable",
  clock_skew: "clock-skew",
  enrolment_broken: "enrolment-broken",
  membership_removed: "membership-removed",
  host_claimed: "host-claimed",
  // Recovered without a state: a fresh token, or the ordinary sign-out path.
  token_expired: null,
  not_admitted: null,
  session_revoked: null,
};

/**
 * The host's refusal an error carries, read one way: at the door
 * (`fatalDetails`), or of this one request on a persistent session
 * (`doorRefusal`).
 */
export function hostRefusalOf(error: HostRpcError): FatalErrorDetails | null {
  return error.fatalDetails ?? error.doorRefusal;
}

/** The codes an older host refuses a host-only token with, carrying no reason. */
const OLDER_HOST_TOKEN_REFUSALS: ReadonlySet<string> = new Set([
  "UNAUTHORIZED",
  "TEAM_MEMBERSHIP_REQUIRED",
  "TEAM_MEMBERSHIP_UNAVAILABLE",
]);

/**
 * The state a refusal the HOST sent raises, or `null` for one that raises
 * none here (it is recovered by a fresh token, or is not a door refusal at
 * all). A recognised reason decides alone, whatever its code.
 *
 * With no reason, only a refusal of the token itself means an older host.
 * Every other code keeps its own meaning: a refusal before the token step
 * (`INCOMPATIBLE`, `REMOTE_ACCESS_OFF`), a fatal that is not about the
 * credential (`HOST_RESTARTING`), or a stream's own refusal (`FORBIDDEN`
 * when access to an epic is lost).
 *
 * Only for a host's own frames on a connection that presented a host-only
 * token: those are the only connections given a door observer. A relay's
 * session kill, and the server pool, never reach this.
 */
export function hostDoorStateOfRefusal(
  details: FatalErrorDetails,
): HostDoorStateKind | null {
  const reason = readDoorReason(details.doorReason);
  if (reason === "absent")
    return OLDER_HOST_TOKEN_REFUSALS.has(details.code) ? "older-host" : null;
  if (reason === "unrecognised") return "unrecognised-refusal";
  return DOOR_REASON_STATES[reason];
}
