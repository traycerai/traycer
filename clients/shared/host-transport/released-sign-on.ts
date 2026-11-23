import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import type { HostOwnerPrincipal } from "@traycer/protocol/host/host-status";
import type {
  BearerSourceProvider,
  OpenFrameBearerSource,
} from "../auth/bearer-source";
import type { RevalidateOutcome } from "../auth/bearer-revalidator";
import {
  authnDidNotAnswer,
  heldWhileAuthnUnreachable,
  type TrackedHostTokens,
} from "../auth/host-token-lease";
import { isUsableHostToken } from "../auth/host-token-store";
import { hostDoorStateOfRefusal } from "./host-door-state";
import type { HostRequestAuthority } from "./host-messenger";

/**
 * The person's sign-in recovery as a transport sees it. `"adopted"` means a
 * sibling's rotation was taken from the store, which authn did not answer for
 * this sequence, so it spends no refresh budget.
 *
 * `refused` is the sign-in the refused request presented, or `null` when the
 * caller cannot tell. A recovery whose stored sign-in is no longer `refused`
 * refreshes nothing and answers `"adopted"`: the refusal was not of the
 * sign-in it holds.
 */
export interface SignInRecovery {
  revalidateForReconnect(
    refused: string | null,
  ): Promise<RevalidateOutcome | "adopted">;
}

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
  readonly recovery: SignInRecovery | null;
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
   * expired. That token is not presented to `instance` again, the process
   * instance whose answer it was. Answers whether it was the held one
   * presented because authn did not answer the mint.
   */
  readonly heldTokenRefused: (
    instance: HostInstance,
    presented: string,
  ) => boolean;
  /** No owner's sign-in can follow that refusal: see `TrackedHostTokens.forgetHeldRefused`. */
  readonly forgetHeldRefusal: (hostId: string) => void;
  /** What this process has seen of each host's answers; see {@link ReleasedHostMemory}. */
  readonly hosts: ReleasedHostMemory;
}

/**
 * The owner of everything this process learns from one process instance of a
 * host id. Only `currentInstance` hands one out, and callers never build one.
 * It is compared by identity. An attempt (a socket, a unary call, a sign-in
 * authority, a plan) reads it at the dial and carries it. Every effect of that
 * attempt's answers names it and does nothing once it is not current.
 * State that belongs to one instance is keyed by this object in a `WeakMap`,
 * in this memory and in any other layer. Replacing the instance drops all of
 * it at once.
 * A host id that no observer reports keeps one instance for the life of the
 * process. Every host reached only through the relay is such a host id, so
 * there the host id stays the key, and a relay host that restarts under the
 * same id is not told apart.
 */
export interface HostInstance {
  readonly hostId: string;
  /**
   * The observer's own identity for this process: the CLI's
   * `${pid}\0${startedAt}`, or the app renderer's and desktop main's pid. It
   * is `null` until a local observer reports this host id, and always `null`
   * for a relay-only host. It is read live and changes at most once, from
   * `null` to the first observation, which this instance adopts. A later,
   * different observation makes a new instance.
   */
  readonly observed: string | null;
}

/** The only implementation: the memory alone builds instances, and only it adopts the first observation. */
class ObservedHostInstance implements HostInstance {
  readonly hostId: string;
  private current: string | null;
  constructor(hostId: string, observed: string | null) {
    this.hostId = hostId;
    this.current = observed;
  }
  get observed(): string | null {
    return this.current;
  }
  adopt(observed: string): void {
    this.current = observed;
  }
}

/** Opaque: an invitation as its attempt heard it. Only `invitationHeard` makes one. */
export interface InvitationMark {
  readonly instance: HostInstance;
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
 * Every write takes the instance of the attempt that heard the answer, and
 * does nothing unless that instance is current. A late answer from an earlier
 * process marks nothing for the one observed now. Every read is by host id and
 * answers for the current instance only.
 */
export interface ReleasedHostMemory {
  /** Read at the dial and carried by the attempt. */
  readonly currentInstance: (hostId: string) => HostInstance;
  /** Whether no other process instance has been observed for its host id since `instance` was read. */
  readonly isCurrent: (instance: HostInstance) => boolean;
  /**
   * For observers of this machine's host processes only. `observed` is the
   * observer's own identity for the process. The first observation of a host
   * id is the instance that attempts already read. A different `observed`
   * replaces the instance: a restarted host may answer differently, so nothing
   * the earlier one answered applies to it. This is never done on a refusal,
   * or a team computer could then receive the sign-in.
   */
  readonly observeInstance: (hostId: string, observed: string) => void;
  readonly opensReleasedWay: (userId: string, hostId: string) => boolean;
  readonly namedReason: (hostId: string) => boolean;
  readonly signInAdmitted: (userId: string, instance: HostInstance) => void;
  readonly hostTokenAdmitted: (instance: HostInstance) => void;
  /**
   * The host refused an open naming its reason. `invitation` is true for the
   * reason that invites the sign-in (`owner_sign_in`). Every other reason
   * also withdraws each invitation heard before it ({@link invitationWithdrawn}).
   */
  readonly refusedNamingReason: (
    instance: HostInstance,
    invitation: boolean,
  ) => void;
  /**
   * Taken when the attempt hears the invitation (`owner_sign_in`), and kept
   * with the plan and the sign-in it invited.
   */
  readonly invitationHeard: (instance: HostInstance) => InvitationMark;
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
  readonly declineProbe: (userId: string, instance: HostInstance) => void;
  readonly probeDeclined: (userId: string, hostId: string) => boolean;
  /**
   * An open carrying the sign-in a current host invited (`owner_sign_in`) was
   * written to this host instance and has had no answer yet: no ack, no
   * refusal, and the socket has not ended. Counted per instance, since
   * transports overlap.
   */
  readonly invitedSignInPending: (hostId: string) => boolean;
  readonly invitedSignInWritten: (instance: HostInstance) => void;
  /**
   * Once per written open: its ack, its refusal, or the end of its socket,
   * with the instance its write carried. An earlier instance's count went with
   * that instance, so its answer changes nothing.
   */
  readonly invitedSignInAnswered: (instance: HostInstance) => void;
  readonly forgetAll: () => void;
}

/** What this memory knows of one host instance. */
interface InstanceMarks {
  named: boolean;
  /** Non-invitation named refusals; `InvitationMark.refusalsBefore` is read from here. */
  refusals: number;
  invitedPending: number;
  /** The person's era it was admitted or declined in: an older era is forgotten. */
  released: object | null;
  declined: object | null;
}

export function createReleasedHostMemory(): ReleasedHostMemory {
  let person: string | null = null;
  /** Replaced by `forgetAll`, so every released and declined mark of the earlier person ends. */
  let personEra: object = {};
  /** Per host id: its current instance. */
  const instances = new Map<string, ObservedHostInstance>();
  const marks = new WeakMap<HostInstance, InstanceMarks>();
  const marksOf = (instance: HostInstance): InstanceMarks => {
    const known = marks.get(instance);
    if (known !== undefined) return known;
    const created: InstanceMarks = {
      named: false,
      refusals: 0,
      invitedPending: 0,
      released: null,
      declined: null,
    };
    marks.set(instance, created);
    return created;
  };
  const currentInstance = (hostId: string): HostInstance => {
    const known = instances.get(hostId);
    if (known !== undefined) return known;
    const instance = new ObservedHostInstance(hostId, null);
    instances.set(hostId, instance);
    return instance;
  };
  const isCurrent = (instance: HostInstance): boolean =>
    instances.get(instance.hostId) === instance;
  /** The current instance's marks, or `null` for a host id never read. */
  const currentMarks = (hostId: string): InstanceMarks | null => {
    const known = instances.get(hostId);
    return known === undefined ? null : (marks.get(known) ?? null);
  };
  const forgetAll = (): void => {
    person = null;
    personEra = {};
  };
  const forPerson = (userId: string): void => {
    if (person !== userId) forgetAll();
    person = userId;
  };
  return {
    currentInstance,
    isCurrent,
    observeInstance: (hostId, observed) => {
      const known = instances.get(hostId);
      if (known === undefined) {
        instances.set(hostId, new ObservedHostInstance(hostId, observed));
        return;
      }
      if (known.observed === null) {
        known.adopt(observed);
        return;
      }
      if (known.observed === observed) return;
      instances.set(hostId, new ObservedHostInstance(hostId, observed));
    },
    opensReleasedWay: (userId, hostId) => {
      if (person !== userId) forgetAll();
      return currentMarks(hostId)?.released === personEra;
    },
    namedReason: (hostId) => currentMarks(hostId)?.named === true,
    signInAdmitted: (userId, instance) => {
      if (!isCurrent(instance)) return;
      const own = marksOf(instance);
      if (own.named) return;
      forPerson(userId);
      own.released = personEra;
    },
    hostTokenAdmitted: (instance) => {
      if (!isCurrent(instance)) return;
      const own = marksOf(instance);
      own.released = null;
      own.declined = null;
    },
    refusedNamingReason: (instance, invitation) => {
      if (!isCurrent(instance)) return;
      const own = marksOf(instance);
      own.released = null;
      own.named = true;
      if (!invitation) own.refusals += 1;
    },
    invitationHeard: (instance) => ({
      instance,
      refusalsBefore: marksOf(instance).refusals,
    }),
    invitationWithdrawn: (mark) =>
      !isCurrent(mark.instance) ||
      marksOf(mark.instance).refusals > mark.refusalsBefore,
    declineProbe: (userId, instance) => {
      if (!isCurrent(instance)) return;
      forPerson(userId);
      marksOf(instance).declined = personEra;
    },
    probeDeclined: (userId, hostId) =>
      person === userId && currentMarks(hostId)?.declined === personEra,
    invitedSignInPending: (hostId) =>
      (currentMarks(hostId)?.invitedPending ?? 0) > 0,
    invitedSignInWritten: (instance) => {
      if (!isCurrent(instance)) return;
      marksOf(instance).invitedPending += 1;
    },
    invitedSignInAnswered: (instance) => {
      const own = marks.get(instance);
      if (own !== undefined && own.invitedPending > 0) own.invitedPending -= 1;
    },
    forgetAll,
  };
}

/** Who a frame carrying the person's sign-in is written for. Each kind names what makes it stale. */
export type SignInAuthority =
  /** This dial sequence's own bare refusal showed the released level. */
  | { readonly kind: "released"; readonly owner: HostInstance }
  /** The relay's memory that this host admitted this person's sign-in. */
  | { readonly kind: "remembered"; readonly owner: HostInstance }
  /** A current host's `owner_sign_in`, as the attempt heard it. */
  | { readonly kind: "invited"; readonly invitation: InvitationMark };

/** Local, synchronous reads only, asked again at each write. */
export interface SignInWriteCheck {
  readonly hosts: Pick<
    ReleasedHostMemory,
    "isCurrent" | "namedReason" | "invitationWithdrawn"
  >;
  /**
   * The row rule, read now: whether this host's row may be handed the
   * sign-in. A surface that can read the row only by an await awaits it
   * before asking, and writes with no await after.
   */
  readonly rowAllows: () => boolean;
  /** Asked only for an invited OPEN: authn did not answer the mint and no host-only token can be presented. */
  readonly ownerSignInEligible: (hostId: string) => boolean;
}

/**
 * Whether a frame carrying the person's sign-in may be written now: an OPEN,
 * a credential update or a pooled request frame. Nothing may be awaited
 * between this answer and the write. `atOpen` is true for the OPEN only. A
 * definitive mint result that lands before the invited OPEN wins, and after
 * that OPEN an invited sign-in is not re-checked for eligibility.
 */
export function signInMayBeWritten(
  check: SignInWriteCheck,
  authority: SignInAuthority,
  atOpen: boolean,
): boolean {
  if (!check.rowAllows()) return false;
  if (authority.kind === "invited") {
    const { invitation } = authority;
    return (
      !check.hosts.invitationWithdrawn(invitation) &&
      (!atOpen || check.ownerSignInEligible(invitation.instance.hostId))
    );
  }
  return (
    check.hosts.isCurrent(authority.owner) &&
    !check.hosts.namedReason(authority.owner.hostId)
  );
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
 * the fresh-mint recovery instead. The mark is the refusing instance's and
 * ends with it.
 */
export function heldTokenRefused(
  tokens: TrackedHostTokens,
  userId: string,
  instance: HostInstance,
  presented: string,
): boolean {
  const hostId = instance.hostId;
  const held = heldWhileAuthnUnreachable(tokens, userId, hostId);
  // A late refusal of an older token never overwrites the current one's mark.
  if (tokens.current(userId, hostId)?.token === presented)
    tokens.noteHeldRefused(instance, userId, presented);
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
  recovery: SignInRecovery | null,
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
    heldTokenRefused: (instance, presented) =>
      instance.hostId === hostId &&
      heldTokenRefused(tokens, userId, instance, presented),
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
  readonly recovery: SignInRecovery | null;
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
 * that holds the rows: the caller's own sign-in lease. Synchronous, since the
 * unary asks it again at each write of a frame carrying the sign-in.
 */
export function signInForLocalRow(
  resolveRow: (hostId: string) => ReleasedSignOnRow | null,
  recovery: SignInRecovery | null,
  tokens: TrackedHostTokens,
): (
  authority: HostRequestAuthority,
  cause: ReleasedUnaryCause,
) => ReleasedUnarySignOn | null {
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
    return allowed ? { bearer: authority.bearer, recovery } : null;
  };
}
