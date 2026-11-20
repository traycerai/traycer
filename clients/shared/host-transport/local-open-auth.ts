import { remoteOpenAuthFor } from "./remote/open-auth";
import type { HostTransportEndpoint } from "./host-messenger";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import type { OpenFrameBearerSource } from "../auth/bearer-source";
import { untilAborted } from "../auth/request-abort";

export const SESSION_GRANT_REQUIRED = "SESSION_GRANT_REQUIRED";
export const TEAM_MEMBERSHIP_REQUIRED = "TEAM_MEMBERSHIP_REQUIRED";
export const TEAM_MEMBERSHIP_UNAVAILABLE = "TEAM_MEMBERSHIP_UNAVAILABLE";

export const TEAM_MEMBERSHIP_REQUIRED_MESSAGE =
  "This computer belongs to a team. This account is not a member. Switch accounts to use Traycer here.";
export const TEAM_MEMBERSHIP_UNAVAILABLE_MESSAGE =
  "Traycer cannot reach the cloud to check team membership. It will try again.";

export type LocalTeamAdmissionState =
  | "checking"
  | "required"
  | "unavailable"
  | "admitted";

export type LocalMemberReadiness =
  | { readonly kind: "ready" }
  | { readonly kind: "reprobe"; readonly fatal: FatalErrorDetails }
  | { readonly kind: "refused"; readonly fatal: FatalErrorDetails }
  | { readonly kind: "unavailable"; readonly retryCause?: FatalErrorDetails };

type ProvisionMember = (
  endpoint: HostTransportEndpoint,
  bearer: OpenFrameBearerSource,
  signal: AbortSignal,
) => Promise<LocalMemberReadiness>;

interface CachedRefusal {
  readonly fatal: FatalErrorDetails;
  readonly revision: number;
}

interface MemberBarrier {
  readonly settled: Promise<LocalMemberReadiness>;
  readonly abort: AbortController;
  waiters: number;
}

export type LocalSessionGrantProvision =
  | { readonly kind: "ok"; readonly token: string }
  | { readonly kind: "refused"; readonly fatal: FatalErrorDetails }
  | { readonly kind: "unavailable"; readonly retryCause?: FatalErrorDetails };

export function isLocalAdmissionFatal(code: string): boolean {
  return (
    code === SESSION_GRANT_REQUIRED ||
    code === TEAM_MEMBERSHIP_REQUIRED ||
    code === TEAM_MEMBERSHIP_UNAVAILABLE
  );
}

export function teamMembershipUnavailable(): FatalErrorDetails {
  return {
    code: TEAM_MEMBERSHIP_UNAVAILABLE,
    reason: TEAM_MEMBERSHIP_UNAVAILABLE_MESSAGE,
    retryable: true,
    incompatibleMethods: null,
    upgradeGuidance: null,
  };
}

/**
 * A local door's challenge is admission evidence, not a directory owner.
 * Remember it across new sockets, but keep a membership refusal bound to the
 * credential lease: changing accounts must allow a new admission attempt.
 */
export class LocalOpenAuth {
  private readonly onAdmissionState:
    | ((hostId: string, userId: string, state: LocalTeamAdmissionState) => void)
    | undefined;
  private readonly provisionMember: ProvisionMember | null;
  private readonly onAdmissionInvalidated:
    | ((hostId: string) => void)
    | undefined;
  private readonly revisions = new Map<string, number>();
  private readonly reprobeFatals = new Map<string, FatalErrorDetails>();
  private readonly activeBarriers = new Map<string, Set<MemberBarrier>>();
  private readonly invalidationListeners = new Set<(hostId: string) => void>();
  private readonly barriers = new WeakMap<
    OpenFrameBearerSource,
    Map<string, MemberBarrier>
  >();
  private readonly challengedHosts = new Set<string>();
  private readonly refusals = new WeakMap<
    OpenFrameBearerSource,
    Map<string, CachedRefusal>
  >();
  private readonly mintSessionGrant: (
    hostId: string,
    bearer: OpenFrameBearerSource,
    signal: AbortSignal,
  ) => Promise<LocalSessionGrantProvision>;

  constructor(options: {
    readonly provisionMember: ProvisionMember | null;
    readonly onAdmissionInvalidated?: (hostId: string) => void;
    readonly onAdmissionState?: (
      hostId: string,
      userId: string,
      state: LocalTeamAdmissionState,
    ) => void;
    readonly mintSessionGrant: (
      hostId: string,
      bearer: OpenFrameBearerSource,
      signal: AbortSignal,
    ) => Promise<LocalSessionGrantProvision>;
  }) {
    this.provisionMember = options.provisionMember;
    this.onAdmissionInvalidated = options.onAdmissionInvalidated;
    this.mintSessionGrant = options.mintSessionGrant;
    this.onAdmissionState = options.onAdmissionState;
  }

  requiresSessionGrant(hostId: string): boolean {
    return (
      remoteOpenAuthFor({
        localAdmission: this.challengedHosts.has(hostId)
          ? SESSION_GRANT_REQUIRED
          : null,
      }) === "session-grant"
    );
  }

  noteSessionGrantRequired(hostId: string): void {
    this.challengedHosts.add(hostId);
  }

  noteRefusal(
    hostId: string,
    bearer: OpenFrameBearerSource,
    fatal: FatalErrorDetails,
  ): void {
    if (
      fatal.code === TEAM_MEMBERSHIP_REQUIRED ||
      fatal.code === TEAM_MEMBERSHIP_UNAVAILABLE
    ) {
      this.challengedHosts.add(hostId);
      this.onAdmissionState?.(
        hostId,
        bearer.identity.userId,
        fatal.code === TEAM_MEMBERSHIP_REQUIRED ? "required" : "unavailable",
      );
    }
    if (fatal.code !== TEAM_MEMBERSHIP_REQUIRED) return;
    let forLease = this.refusals.get(bearer);
    if (forLease === undefined) {
      forLease = new Map();
      this.refusals.set(bearer, forLease);
    }
    forLease.set(hostId, { fatal, revision: this.revisionFor(hostId) });
  }

  revisionFor(hostId: string): number {
    return this.revisions.get(hostId) ?? 0;
  }

  invalidateHost(hostId: string, refusal: FatalErrorDetails | null): void {
    if (refusal === null) this.reprobeFatals.delete(hostId);
    else this.reprobeFatals.set(hostId, refusal);
    this.revisions.set(hostId, this.revisionFor(hostId) + 1);
    this.challengedHosts.delete(hostId);
    const active = this.activeBarriers.get(hostId);
    this.activeBarriers.delete(hostId);
    if (active !== undefined) {
      for (const barrier of active) barrier.abort.abort();
    }
    this.onAdmissionInvalidated?.(hostId);
    for (const listener of Array.from(this.invalidationListeners))
      listener(hostId);
  }

  onHostInvalidated(listener: (hostId: string) => void): () => void {
    this.invalidationListeners.add(listener);
    return () => {
      this.invalidationListeners.delete(listener);
    };
  }

  private refusalFor(
    hostId: string,
    bearer: OpenFrameBearerSource,
  ): FatalErrorDetails | null {
    const cached = this.refusals.get(bearer)?.get(hostId);
    return cached?.revision === this.revisionFor(hostId) ? cached.fatal : null;
  }

  async ensureMemberReady(
    endpoint: HostTransportEndpoint,
    bearer: OpenFrameBearerSource,
    signal: AbortSignal,
  ): Promise<LocalMemberReadiness> {
    if (signal.aborted) throw signal.reason;
    const refused = this.refusalFor(endpoint.hostId, bearer);
    if (refused !== null) return { kind: "refused", fatal: refused };
    const provision = this.provisionMember;
    if (provision === null) return { kind: "ready" };
    let forLease = this.barriers.get(bearer);
    if (forLease === undefined) {
      forLease = new Map();
      this.barriers.set(bearer, forLease);
    }
    const revision = this.revisionFor(endpoint.hostId);
    const key = `${endpoint.hostId}\u0000${endpoint.websocketUrl ?? ""}\u0000${revision}`;
    let barrier = forLease.get(key);
    if (barrier === undefined) {
      const abort = new AbortController();
      const settled = provision(endpoint, bearer, abort.signal).catch(
        (): LocalMemberReadiness => ({ kind: "unavailable" }),
      );
      barrier = { settled, abort, waiters: 0 };
      forLease.set(key, barrier);
      let active = this.activeBarriers.get(endpoint.hostId);
      if (active === undefined) {
        active = new Set();
        this.activeBarriers.set(endpoint.hostId, active);
      }
      active.add(barrier);
      const activeForHost = active;
      const owned = barrier;
      const leaseBarriers = forLease;
      void settled.finally(() => {
        if (leaseBarriers.get(key) === owned) leaseBarriers.delete(key);
        activeForHost.delete(owned);
        if (
          activeForHost.size === 0 &&
          this.activeBarriers.get(endpoint.hostId) === activeForHost
        )
          this.activeBarriers.delete(endpoint.hostId);
      });
    }
    barrier.waiters += 1;
    try {
      const result = await untilAborted(barrier.settled, signal);
      if (revision !== this.revisionFor(endpoint.hostId)) {
        const fatal = this.reprobeFatals.get(endpoint.hostId);
        return fatal === undefined
          ? { kind: "unavailable" }
          : { kind: "reprobe", fatal };
      }
      if (result.kind === "refused") {
        this.noteRefusal(endpoint.hostId, bearer, result.fatal);
      } else if (result.kind === "unavailable") {
        this.noteRefusal(endpoint.hostId, bearer, teamMembershipUnavailable());
      }
      return result;
    } finally {
      barrier.waiters -= 1;
      if (barrier.waiters === 0) {
        if (forLease.get(key) === barrier) forLease.delete(key);
        barrier.abort.abort();
      }
    }
  }

  noteAdmitted(hostId: string, bearer: OpenFrameBearerSource): void {
    this.onAdmissionState?.(hostId, bearer.identity.userId, "admitted");
  }

  async mint(
    hostId: string,
    bearer: OpenFrameBearerSource,
    signal: AbortSignal,
  ): Promise<LocalSessionGrantProvision> {
    if (signal.aborted) throw signal.reason;
    const refused = this.refusalFor(hostId, bearer);
    if (refused !== null) {
      this.onAdmissionState?.(hostId, bearer.identity.userId, "required");
      return { kind: "refused", fatal: refused };
    }
    this.onAdmissionState?.(hostId, bearer.identity.userId, "checking");
    const revision = this.revisionFor(hostId);
    let result: LocalSessionGrantProvision;
    try {
      result = await untilAborted(
        this.mintSessionGrant(hostId, bearer, signal),
        signal,
      );
    } catch (cause) {
      if (signal.aborted) throw cause;
      result = { kind: "unavailable" };
    }
    if (revision !== this.revisionFor(hostId)) return { kind: "unavailable" };
    if (result.kind === "refused") {
      this.noteRefusal(hostId, bearer, result.fatal);
    }
    if (
      result.kind === "unavailable" ||
      (result.kind === "ok" && result.token.length === 0)
    ) {
      this.onAdmissionState?.(hostId, bearer.identity.userId, "unavailable");
      return result.kind === "unavailable" ? result : { kind: "unavailable" };
    }
    return result;
  }
}
