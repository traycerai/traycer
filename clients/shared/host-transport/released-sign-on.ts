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
import { isUsableHostToken } from "../auth/host-token-store";
import { hostDoorStateOfRefusal } from "./host-door-state";
import type { HostRequestAuthority } from "./host-messenger";

/** The directory facts the decision reads; a local row has no `sandbox`. */
export interface ReleasedSignOnRow {
  readonly owner?: HostOwnerPrincipal | null;
  readonly sandbox?: object | null;
}

/**
 * How a transport opens a released host with the person's sign-in, and how a
 * local door probes a host it can present no host-only token to.
 */
export interface ReleasedSignOn {
  /** The person's sign-in: their identity for the probe, and the credential the sign-in plans present. */
  readonly signIn: BearerSourceProvider;
  /**
   * The row rule: whether this host's row may be handed the sign-in at all.
   * It gates only the sign-in, never the probe, whose placeholder carries no
   * credential.
   */
  readonly mayPresentSignIn: () => boolean;
  /** Recovers a sign-in the released host refused, as a released app did. */
  readonly recovery: StreamAuthRevalidator | null;
  /*
   * Each callback below is asked with the host the socket it answers for was
   * selected for, never with what the caller's endpoint reads now. A builder
   * bound to one host answers for no other.
   */
  /**
   * This machine's host only: no host-only token can be presented
   * ({@link hostTokenUnobtainable}). A released client then opened its host
   * with the sign-in, and so does this one.
   */
  readonly hostTokenUnobtainable: (hostId: string) => boolean;
  /**
   * This machine's host only: authn did not answer the mint and no host-only
   * token can be presented ({@link ownerSignInEligible}). Only then is a current
   * host's `owner_sign_in` answer followed by the sign-in.
   */
  readonly ownerSignInEligible: (hostId: string) => boolean;
  /**
   * The host refused `presented`, the host-only token on the open frame, as
   * expired; that token is not presented again. Answers whether it was the held
   * one presented because authn did not answer the mint.
   */
  readonly heldTokenRefused: (hostId: string, presented: string) => boolean;
  /** No owner's sign-in can follow that refusal: see `TrackedHostTokens.forgetHeldRefused`. */
  readonly forgetHeldRefusal: (hostId: string) => void;
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
 * a host-only token or refuses anything naming its reason (it was updated).
 * Once a host names a reason, no transport in this process hands it the
 * released-way sign-in again, until this process sees that host's local
 * process instance change.
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
  /**
   * An open carrying the sign-in a current host invited (`owner_sign_in`) was
   * written to this host and has had no answer yet: no ack, no refusal, and
   * the socket has not ended. Counted per host, since transports overlap.
   */
  readonly invitedSignInPending: (hostId: string) => boolean;
  readonly invitedSignInWritten: (hostId: string) => void;
  /** Once per written open: its ack, its refusal, or the end of its socket. */
  readonly invitedSignInAnswered: (hostId: string) => void;
  /**
   * Forgets this host's named-reason mark and its declined probe: its local
   * process instance changed, and a restarted host may answer differently.
   * Never called on a refusal: a team computer could then receive the sign-in.
   */
  readonly forgetNamed: (hostId: string) => void;
  readonly forgetAll: () => void;
}

export function createReleasedHostMemory(): ReleasedHostMemory {
  let person: string | null = null;
  const released = new Set<string>();
  const current = new Set<string>();
  const declined = new Set<string>();
  const invitedPending = new Map<string, number>();
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
    invitedSignInPending: (hostId) => (invitedPending.get(hostId) ?? 0) > 0,
    invitedSignInWritten: (hostId) => {
      invitedPending.set(hostId, (invitedPending.get(hostId) ?? 0) + 1);
    },
    invitedSignInAnswered: (hostId) => {
      const pending = (invitedPending.get(hostId) ?? 0) - 1;
      if (pending > 0) invitedPending.set(hostId, pending);
      else invitedPending.delete(hostId);
    },
    forgetNamed: (hostId) => {
      current.delete(hostId);
      declined.delete(hostId);
    },
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

/**
 * See {@link ReleasedSignOn.heldTokenRefused}. Only a held token already past
 * its end here: one this clock still calls usable, refused as expired, takes
 * the fresh-mint recovery instead.
 */
export function heldTokenRefused(
  tokens: TrackedHostTokens,
  userId: string,
  hostId: string,
  presented: string,
): boolean {
  const held = heldWhileAuthnUnreachable(tokens, userId, hostId);
  // A late refusal of an older token never overwrites the current one's mark.
  if (tokens.current(userId, hostId)?.token === presented)
    tokens.noteHeldRefused(userId, hostId, presented);
  return (
    held !== null &&
    held.token === presented &&
    !isUsableHostToken(held, Date.now())
  );
}

/**
 * For this machine's host, for a caller holding its row in memory. Every row
 * probes; only a row {@link opensReleasedWayOnThisMachine} allows is handed the
 * sign-in, read again at every ask (`mayPresentSignIn`). Never a cloud read.
 */
export function releasedSignOnForLocalRow(
  readRow: () => ReleasedSignOnRow | null,
  hostId: string,
  userId: string,
  signIn: BearerSourceProvider,
  recovery: StreamAuthRevalidator | null,
  tokens: TrackedHostTokens,
  hosts: ReleasedHostMemory,
): ReleasedSignOn {
  return {
    signIn,
    mayPresentSignIn: () => opensReleasedWayOnThisMachine(readRow(), userId),
    recovery,
    hostTokenUnobtainable: (asked) =>
      asked === hostId && hostTokenUnobtainable(tokens, userId, hostId),
    ownerSignInEligible: (asked) =>
      asked === hostId && ownerSignInEligible(tokens, userId, hostId),
    heldTokenRefused: (asked, presented) =>
      asked === hostId && heldTokenRefused(tokens, userId, hostId, presented),
    forgetHeldRefusal: (asked) => {
      if (asked === hostId) tokens.forgetHeldRefused(userId, hostId);
    },
    hosts,
  };
}

/** A released host's bare refusal of an open that carried the person's sign-in: the fatal details of a stream's close, or a unary call's error. */
const releasedSignInRefusals = new WeakSet<object>();
export function markReleasedSignInRefusal(refusal: object): void {
  releasedSignInRefusals.add(refusal);
}
export function isReleasedSignInRefusal(refusal: unknown): boolean {
  return (
    typeof refusal === "object" &&
    refusal !== null &&
    releasedSignInRefusals.has(refusal)
  );
}

/** What a unary call is sent with instead of, or after, the host-only token. */
export interface ReleasedUnarySignOn {
  readonly bearer: OpenFrameBearerSource;
  /** Refreshes a sign-in the released host refused; the call then goes once more. */
  readonly recovery: StreamAuthRevalidator | null;
}

/**
 * Why the unary client asks: the host refused the token, none could be
 * presented, the host refused the held one as expired, or a current host
 * answered the probe `owner_sign_in`. For `no-host-token` and
 * `held-token-refused` the answer is whether the call may PROBE. With no
 * host-only token held no row is asked, since the placeholder carries no
 * credential; a held token the host refused is a token held, so the row rule
 * gates that probe, as it gates the two causes that send the sign-in.
 */
export type ReleasedUnaryCause =
  | "refused"
  | "no-host-token"
  | "held-token-refused"
  | "owner-sign-in";

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
      cause === "no-host-token"
        ? hostTokenUnobtainable(tokens, userId, hostId)
        : opensReleasedWayOnThisMachine(resolveRow(hostId), userId) &&
          (cause === "refused" ||
            (cause === "owner-sign-in"
              ? ownerSignInEligible(tokens, userId, hostId)
              : hostTokenUnobtainable(tokens, userId, hostId)));
    return Promise.resolve(
      allowed ? { bearer: authority.bearer, recovery } : null,
    );
  };
}
