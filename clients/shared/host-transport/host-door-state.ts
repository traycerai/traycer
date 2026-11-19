import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import type { HostRpcError } from "@traycer/protocol/host-transport/remote/rpc-types";
import {
  readDoorReason,
  type HostDoorReason,
} from "@traycer/protocol/framework/door-reason";

/**
 * Keyed on the host's `doorReason`, never its `code`; nothing a host says starts
 * sign-in recovery. `session_revoked` takes the ordinary sign-out path.
 */
export type HostDoorStateKind =
  /** authn unreachable when opening, and no usable token on disk. */
  | "token-unavailable"
  /** The host keeps the connection under its outage exception. */
  | "access-check-delayed"
  | "keys-unavailable"
  | "clock-skew"
  | "token-expired"
  | "enrolment-broken"
  | "membership-removed"
  /** authn refused the token and its answer says the computer is a team's. */
  | "not-a-member"
  /** A second `not_admitted` after one fresh token, or a mint refusal that does not say "team". */
  | "not-admitted"
  | "host-claimed"
  /** A host-only token refused with no `doorReason` and not retryable: an older host. */
  | "older-host"
  /** A newer host, never an older one. */
  | "unrecognised-refusal";

/** A mint that cannot reach authn never reaches a host. */
export type HostDoorStateSource = "app" | "host" | "authn";

export type HostDoorStateRetry = "backoff" | "when-online" | "none";

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
  /** `null` where nothing the app can watch clears it. */
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

/** `detail` is the refusal's code and reason as sent; `null` for a state the app raised. */
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
  // Recovered by a fresh token.
  token_expired: null,
  not_admitted: null,
  session_revoked: null,
};

export function hostRefusalOf(error: HostRpcError): FatalErrorDetails | null {
  return error.fatalDetails ?? error.doorRefusal;
}

/** `TEAM_MEMBERSHIP_UNAVAILABLE` is not one: a host sends it only as retryable. */
const OLDER_HOST_TOKEN_REFUSALS: ReadonlySet<string> = new Set([
  "UNAUTHORIZED",
  "TEAM_MEMBERSHIP_REQUIRED",
]);

// A host's own error envelope, final rather than retryable: an answer from past its
// door. Marked where the envelope is read.
const hostAnswers = new WeakSet<HostRpcError>();

export function asHostAnswer(error: HostRpcError): HostRpcError {
  hostAnswers.add(error);
  return error;
}

/** The host answered the call and refused no token, so its door admitted the token. */
export function isAdmittingAnswer(error: HostRpcError): boolean {
  return (
    hostAnswers.has(error) &&
    hostRefusalOf(error) === null &&
    !OLDER_HOST_TOKEN_REFUSALS.has(error.code)
  );
}

/**
 * A recognised reason raises a state alone, whatever its code; with no reason only
 * a refusal of the token itself does (an older host). A retryable refusal never does.
 */
export function hostDoorStateOfRefusal(
  details: FatalErrorDetails,
): HostDoorStateKind | null {
  const reason = readDoorReason(details.doorReason);
  if (reason === "absent")
    return details.retryable !== true &&
      OLDER_HOST_TOKEN_REFUSALS.has(details.code)
      ? "older-host"
      : null;
  if (reason === "unrecognised") return "unrecognised-refusal";
  return DOOR_REASON_STATES[reason];
}
