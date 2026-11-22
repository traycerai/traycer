import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import type { HostOwnerPrincipal } from "@traycer/protocol/host/host-status";
import type {
  BearerSourceProvider,
  OpenFrameBearerSource,
} from "../auth/bearer-source";
import type { StreamAuthRevalidator } from "../auth/bearer-revalidator";
import {
  authnDidNotAnswer,
  heldWhileAuthnUnreachable,
  type TrackedHostTokens,
} from "../auth/host-token-lease";
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
   * This machine's host only: no host-only token can be presented
   * ({@link hostTokenUnobtainable}). A released client then opened its host
   * with the sign-in, and so does this one.
   */
  readonly hostTokenUnobtainable: () => boolean;
  /**
   * This machine's host only: authn did not answer the mint and no host-only
   * token can be presented ({@link ownerSignInEligible}). Only then is a current
   * host's `owner_sign_in` answer followed by the sign-in.
   */
  readonly ownerSignInEligible: () => boolean;
  /**
   * The host refused `presented`, the host-only token on the open frame, as
   * expired; that token is not presented again. Answers whether it was the held
   * one presented because authn did not answer the mint.
   */
  readonly heldTokenRefused: (presented: string) => boolean;
  /** No owner's sign-in can follow that refusal: see `TrackedHostTokens.forgetHeldRefused`. */
  readonly forgetHeldRefusal: () => void;
  /** What this process has seen of each host's answers; see {@link ReleasedHostMemory}. */
  readonly hosts: ReleasedHostMemory;
}

/**
 * Process memory only, per signed-in person and host id, never on disk and never
 * keyed on a version. A remote host that refused the host-only token the
 * released way and then admitted that person's sign-in skips the refused token
 * dial on that person's later remote dials, whose row is read live from the
 * directory. This machine's doors never skip it: there the sign-in goes only
 * after this dial sequence's own refusal showed the released level. It holds
 * one person: a dial by anyone else forgets it, and so does
 * sign-out (`forgetAll`). It is forgotten for everyone the moment the host admits
 * a host-only token or refuses anything naming its reason (it was updated). A
 * host that has named a reason in this process is never handed the sign-in again.
 * A declined probe is the same person's and host's: it is forgotten with the
 * person, and when the host admits a host-only token.
 */
export interface ReleasedHostMemory {
  readonly opensReleasedWay: (userId: string, hostId: string) => boolean;
  readonly namedReason: (hostId: string) => boolean;
  readonly signInAdmitted: (userId: string, hostId: string) => void;
  readonly hostTokenAdmitted: (hostId: string) => void;
  readonly refusedNamingReason: (hostId: string) => void;
  /**
   * The host refused this person's probe, or the sign-in it invited, naming why
   * (`not_admitted`): it is not probed again for them. `not_provisioned` is not
   * declined, since the host takes an owner without restarting this process.
   */
  readonly declineProbe: (userId: string, hostId: string) => void;
  readonly probeDeclined: (userId: string, hostId: string) => boolean;
  readonly forgetAll: () => void;
}

export function createReleasedHostMemory(): ReleasedHostMemory {
  let person: string | null = null;
  const released = new Set<string>();
  const current = new Set<string>();
  const declined = new Set<string>();
  const forgetAll = (): void => {
    person = null;
    released.clear();
    declined.clear();
  };
  return {
    opensReleasedWay: (userId, hostId) => {
      if (person !== userId) forgetAll();
      return released.has(hostId);
    },
    namedReason: (hostId) => current.has(hostId),
    signInAdmitted: (userId, hostId) => {
      if (current.has(hostId)) return;
      if (person !== userId) forgetAll();
      person = userId;
      released.add(hostId);
    },
    hostTokenAdmitted: (hostId) => {
      released.delete(hostId);
      declined.delete(hostId);
    },
    refusedNamingReason: (hostId) => {
      released.delete(hostId);
      current.add(hostId);
    },
    declineProbe: (userId, hostId) => {
      if (person !== userId) forgetAll();
      person = userId;
      declined.add(hostId);
    },
    probeDeclined: (userId, hostId) =>
      person === userId && declined.has(hostId),
    forgetAll,
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
 * No host-only token can be presented to this machine's host: authn has no row
 * for this person, or {@link ownerSignInEligible}.
 */
export function hostTokenUnobtainable(
  tokens: TrackedHostTokens,
  userId: string,
  hostId: string,
): boolean {
  return (
    tokens.lastMintFailure(userId, hostId) === "not-admitted" ||
    ownerSignInEligible(tokens, userId, hostId)
  );
}

/**
 * The last mint ended without authn answering it (`authnDidNotAnswer`), and no
 * held host-only token can be presented: none is held, or the host refused it
 * as expired.
 */
export function ownerSignInEligible(
  tokens: TrackedHostTokens,
  userId: string,
  hostId: string,
): boolean {
  return (
    authnDidNotAnswer(tokens, userId, hostId) &&
    heldWhileAuthnUnreachable(tokens, userId, hostId) === null
  );
}

/** See {@link ReleasedSignOn.heldTokenRefused}. */
export function heldTokenRefused(
  tokens: TrackedHostTokens,
  userId: string,
  hostId: string,
  presented: string,
): boolean {
  const held = heldWhileAuthnUnreachable(tokens, userId, hostId);
  tokens.noteHeldRefused(userId, hostId, presented);
  return held !== null && held.token === presented;
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
        hostTokenUnobtainable: () =>
          hostTokenUnobtainable(tokens, userId, hostId),
        ownerSignInEligible: () => ownerSignInEligible(tokens, userId, hostId),
        heldTokenRefused: (presented) =>
          heldTokenRefused(tokens, userId, hostId, presented),
        forgetHeldRefusal: () => tokens.forgetHeldRefused(userId, hostId),
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

/**
 * Why the unary client asks: the host refused the token, none could be
 * presented, or a current host answered the probe `owner_sign_in`.
 */
export type ReleasedUnaryCause = "refused" | "no-host-token" | "owner-sign-in";

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
      (cause === "refused" ||
        (cause === "owner-sign-in"
          ? ownerSignInEligible(tokens, userId, hostId)
          : hostTokenUnobtainable(tokens, userId, hostId)));
    return Promise.resolve(
      allowed ? { bearer: authority.bearer, recovery } : null,
    );
  };
}
