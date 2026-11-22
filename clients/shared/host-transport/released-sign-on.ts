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
 * The process instance of a host id that a {@link ReleasedHostMemory} last saw.
 * Only `currentInstance` hands one out and callers never build one. It is
 * compared by identity. An attempt (a socket, a unary call) reads it at the
 * dial and carries it, so each answer applies to the instance that gave it.
 * A host id that no observer reports, which is every remote host, keeps one
 * stamp for the life of the process. There the host id stays the key, and a
 * remote host that restarts under the same id is not told apart.
 */
export interface HostInstanceStamp {
  readonly hostId: string;
}

/** Opaque: an invitation as its attempt heard it. Only `invitationHeard` makes one. */
export interface InvitationMark {
  readonly stamp: HostInstanceStamp;
  readonly refusalsBefore: number;
}

/**
 * Process memory only, per signed-in person and host instance, never on disk
 * and never keyed on a version. A remote host that refused the host-only token
 * the released way and then admitted that person's sign-in skips the refused
 * token dial on that person's later remote dials, whose row is read live from
 * the directory. This machine's doors never skip it: there the sign-in goes
 * only after this dial sequence's own refusal showed the released level. It
 * holds one person: a dial by anyone else forgets it, and so does sign-out
 * (`forgetAll`). It is forgotten for everyone the moment the host admits a
 * host-only token or refuses anything naming its reason (it was updated).
 * Once a host names a reason, no transport in this process hands it the
 * released-way sign-in again, until this process sees that host's local
 * process instance change.
 * A declined probe is the same person's and host's: it is forgotten with the
 * person, and when the host admits a host-only token.
 *
 * Every write takes the stamp of the attempt that heard the answer. It does
 * nothing unless that stamp is still the current instance, so a late answer
 * from an earlier process marks nothing for the one observed now. Every read
 * is by host id and answers for the current instance only.
 */
export interface ReleasedHostMemory {
  /** Read at the dial and carried by the attempt. */
  readonly currentInstance: (hostId: string) => HostInstanceStamp;
  /** Whether no other process instance has been observed for the stamp's host id since that stamp was read. */
  readonly isCurrentInstance: (stamp: HostInstanceStamp) => boolean;
  /**
   * For observers of this machine's host processes only. `observed` is the
   * observer's own identity for the process. The first observation of a host
   * id is the instance that attempts already read. A different `observed`
   * starts a new instance: a restarted host may answer differently, so nothing
   * the earlier one answered applies to it. This is never done on a refusal,
   * or a team computer could then receive the sign-in.
   */
  readonly observeInstance: (hostId: string, observed: string) => void;
  readonly opensReleasedWay: (userId: string, hostId: string) => boolean;
  readonly namedReason: (hostId: string) => boolean;
  readonly signInAdmitted: (userId: string, stamp: HostInstanceStamp) => void;
  readonly hostTokenAdmitted: (stamp: HostInstanceStamp) => void;
  /**
   * The host refused an open naming its reason. `invitation` is true for the
   * reason that invites the sign-in (`owner_sign_in`). Every other reason
   * also withdraws each invitation heard before it ({@link invitationWithdrawn}).
   */
  readonly refusedNamingReason: (
    stamp: HostInstanceStamp,
    invitation: boolean,
  ) => void;
  /**
   * Taken when the attempt hears the invitation (`owner_sign_in`), and kept
   * with the plan and the sign-in it invited.
   */
  readonly invitationHeard: (stamp: HostInstanceStamp) => InvitationMark;
  /**
   * Whether the sign-in that `mark` invited may no longer go to its host. That
   * is the case when the host restarted, or when any transport has heard it
   * refuse an open naming a reason other than an invitation since then. A
   * refusal from before the invitation does not count, so the expiry refusal
   * that let the invitation be followed does not count either.
   */
  readonly invitationWithdrawn: (mark: InvitationMark) => boolean;
  /**
   * The host refused this person's probe, or the sign-in it invited, naming why
   * (`not_admitted`): it is not probed again for them. `not_provisioned` is not
   * declined, since the host takes an owner without restarting this process.
   */
  readonly declineProbe: (userId: string, stamp: HostInstanceStamp) => void;
  readonly probeDeclined: (userId: string, hostId: string) => boolean;
  /**
   * An open carrying the sign-in a current host invited (`owner_sign_in`) was
   * written to this host instance and has had no answer yet: no ack, no
   * refusal, and the socket has not ended. Counted per instance, since
   * transports overlap.
   */
  readonly invitedSignInPending: (hostId: string) => boolean;
  readonly invitedSignInWritten: (stamp: HostInstanceStamp) => void;
  /**
   * Once per written open: its ack, its refusal, or the end of its socket,
   * with the stamp its write carried. An earlier instance's count was dropped
   * with that instance, so its answer changes nothing.
   */
  readonly invitedSignInAnswered: (stamp: HostInstanceStamp) => void;
  readonly forgetAll: () => void;
}

export function createReleasedHostMemory(): ReleasedHostMemory {
  let person: string | null = null;
  /** Per host id: its current stamp and the observer's identity for it, `null` until observed. */
  const instances = new Map<
    string,
    { readonly stamp: HostInstanceStamp; observed: string | null }
  >();
  const released = new Set<HostInstanceStamp>();
  const named = new Set<HostInstanceStamp>();
  const declined = new Set<HostInstanceStamp>();
  const invitedPending = new Map<HostInstanceStamp, number>();
  /**
   * Per host id: refusals naming a reason other than an invitation, counted
   * only from the current instance. Never reset, not even by a restart or
   * sign-out, so a larger count than an invitation's `refusalsBefore` means a
   * refusal since that invitation.
   */
  const refusals = new Map<string, number>();
  const currentInstance = (hostId: string): HostInstanceStamp => {
    const known = instances.get(hostId);
    if (known !== undefined) return known.stamp;
    const stamp: HostInstanceStamp = { hostId };
    instances.set(hostId, { stamp, observed: null });
    return stamp;
  };
  const isCurrentInstance = (stamp: HostInstanceStamp): boolean =>
    instances.get(stamp.hostId)?.stamp === stamp;
  const known = (hostId: string): HostInstanceStamp | null =>
    instances.get(hostId)?.stamp ?? null;
  const forgetAll = (): void => {
    person = null;
    released.clear();
    declined.clear();
  };
  return {
    currentInstance,
    isCurrentInstance,
    observeInstance: (hostId, observed) => {
      const entry = instances.get(hostId);
      if (entry === undefined) {
        instances.set(hostId, { stamp: { hostId }, observed });
        return;
      }
      if (entry.observed === null) {
        entry.observed = observed;
        return;
      }
      if (entry.observed === observed) return;
      const earlier = entry.stamp;
      released.delete(earlier);
      named.delete(earlier);
      declined.delete(earlier);
      invitedPending.delete(earlier);
      instances.set(hostId, { stamp: { hostId }, observed });
    },
    opensReleasedWay: (userId, hostId) => {
      if (person !== userId) forgetAll();
      const stamp = known(hostId);
      return stamp !== null && released.has(stamp);
    },
    namedReason: (hostId) => {
      const stamp = known(hostId);
      return stamp !== null && named.has(stamp);
    },
    signInAdmitted: (userId, stamp) => {
      if (!isCurrentInstance(stamp) || named.has(stamp)) return;
      if (person !== userId) forgetAll();
      person = userId;
      released.add(stamp);
    },
    hostTokenAdmitted: (stamp) => {
      if (!isCurrentInstance(stamp)) return;
      released.delete(stamp);
      declined.delete(stamp);
    },
    refusedNamingReason: (stamp, invitation) => {
      if (!isCurrentInstance(stamp)) return;
      released.delete(stamp);
      named.add(stamp);
      if (!invitation)
        refusals.set(stamp.hostId, (refusals.get(stamp.hostId) ?? 0) + 1);
    },
    invitationHeard: (stamp) => ({
      stamp,
      refusalsBefore: refusals.get(stamp.hostId) ?? 0,
    }),
    invitationWithdrawn: (mark) =>
      !isCurrentInstance(mark.stamp) ||
      (refusals.get(mark.stamp.hostId) ?? 0) > mark.refusalsBefore,
    declineProbe: (userId, stamp) => {
      if (!isCurrentInstance(stamp)) return;
      if (person !== userId) forgetAll();
      person = userId;
      declined.add(stamp);
    },
    probeDeclined: (userId, hostId) => {
      const stamp = known(hostId);
      return person === userId && stamp !== null && declined.has(stamp);
    },
    invitedSignInPending: (hostId) => {
      const stamp = known(hostId);
      return stamp !== null && (invitedPending.get(stamp) ?? 0) > 0;
    },
    invitedSignInWritten: (stamp) => {
      if (!isCurrentInstance(stamp)) return;
      invitedPending.set(stamp, (invitedPending.get(stamp) ?? 0) + 1);
    },
    invitedSignInAnswered: (stamp) => {
      const before = invitedPending.get(stamp);
      if (before === undefined) return;
      if (before > 1) invitedPending.set(stamp, before - 1);
      else invitedPending.delete(stamp);
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
    tokens.lastFailure(userId, hostId) === "not-admitted" ||
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
