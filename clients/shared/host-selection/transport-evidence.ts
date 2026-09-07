/**
 * This module is the wiring, and it exists as its own narrow interface rather than passing the kernel itself so that `host-transport` never depends on the authority's client/IPC surface.
 * Counting those would let one cloud outage reach the confirmed-death streak on every remote host at once and fail the whole fleet over, which is the false-Offline class invariant 5 exists to prevent.
 */
import type {
  SelectionIncompatibility,
  SelectionTransportKind,
} from "./selection-authority-contract";

/**
 * What a transport reports.
 * Structurally identical to the matching methods of `SelectionEvidenceKernel`, which declares `implements` against it so a signature drift is a compile error rather than a silently dead producer.
 */
export interface TransportEvidenceReporter {
  /** A transport session for `hostId` is now live. */
  sessionEstablished(
    hostId: string,
    sessionId: string,
    transportKind: SelectionTransportKind,
  ): void;
  sessionLost(
    hostId: string,
    sessionId: string,
    transportKind: SelectionTransportKind,
  ): void;
  /** A dial that reached the host. Clears the host's death streak. */
  reportDialSuccess(
    hostId: string,
    attemptId: string,
    transportKind: SelectionTransportKind,
  ): void;
  /**
   * A dial the host's transport plane terminally refused.
   * `refusalDetail` is `"plan-restricted"` only when this attempt's own error carried the entitlement denial - see the module header.
   */
  reportDialRefusal(
    hostId: string,
    attemptId: string,
    transportKind: SelectionTransportKind,
    refusalDetail: "plan-restricted" | null,
  ): void;
  /** A dial that ran out of time without an answer. Death evidence. */
  reportDialTimeout(
    hostId: string,
    attemptId: string,
    transportKind: SelectionTransportKind,
  ): void;
  /** An attempt that says nothing about the host. Inert by contract. */
  reportDialIndeterminate(
    hostId: string,
    attemptId: string,
    transportKind: SelectionTransportKind,
  ): void;
  reportCompatVerdict(input: {
    readonly hostId: string;
    readonly probedOnSessionId: string | null;
    readonly hostVersion: string | null;
    readonly incompatibility: SelectionIncompatibility | null;
  }): void;
  /** Report it and keep going. */
  reportRestartIntent(
    hostId: string,
    tombstoneId: string,
    expiresAt: number | null,
  ): void;
}

/**
 * For shells that have no selection authority to feed - the CLI, and every test that builds a transport to exercise something else.
 * Named rather than defaulted: the transports take their reporter as a required option, so a new construction site has to say which of the two it means.
 */
export const NO_TRANSPORT_EVIDENCE: TransportEvidenceReporter = {
  sessionEstablished: () => undefined,
  sessionLost: () => undefined,
  reportDialSuccess: () => undefined,
  reportDialRefusal: () => undefined,
  reportDialTimeout: () => undefined,
  reportDialIndeterminate: () => undefined,
  reportCompatVerdict: () => undefined,
  reportRestartIntent: () => undefined,
};

/**
 * A stable reporter whose target can be swapped underneath live transports.
 * The invariant: the relay's scope must equal the pooled transports' scope.
 */
export class TransportEvidenceRelay implements TransportEvidenceReporter {
  private target: TransportEvidenceReporter | null = null;
  /**
   * But a kernel only learns about a session when one is announced, and a pooled remote session announces exactly once, at its own ready boundary: on a cache hit the session-building factory never runs.
   * The relay is the one object whose lifetime already equals the session pool's - that is this module's stated invariant - so it is where pool-scoped state belongs.
   */
  private readonly liveSessions = new Map<
    string,
    { readonly hostId: string; readonly transportKind: SelectionTransportKind }
  >();
  /**
   * Per host, the id of the session most recently established through it.
   * Names the current session for anchor-binding; never consulted for liveness - the kernel owns that.
   */
  private readonly currentSessionIds = new Map<string, string>();
  /**
   * Restart tombstones observed while no kernel was bound, keyed by host.
   * A tombstone looks like an event, and replaying events is where phantom-liveness bugs come from - so it is worth being exact about why this one is state.
   */
  private readonly retainedRestartIntents = new Map<
    string,
    { readonly tombstoneId: string; readonly expiresAt: number | null }
  >();

  /**
   * Points the relay at `target`, replays what it already knows, and returns the unbind.
   * A second bind replaces the first outright rather than stacking - two live kernels for one window is not a state this design has, and silently fanning out to both would double every streak the authority counts.
   */
  bind(target: TransportEvidenceReporter): () => void {
    this.target = target;
    for (const [sessionId, session] of this.liveSessions) {
      target.sessionEstablished(
        session.hostId,
        sessionId,
        session.transportKind,
      );
    }
    // Consumed, not re-announced.
    const intents = Array.from(this.retainedRestartIntents);
    this.retainedRestartIntents.clear();
    for (const [hostId, intent] of intents) {
      target.reportRestartIntent(hostId, intent.tombstoneId, intent.expiresAt);
    }
    return () => {
      if (this.target === target) {
        this.target = null;
      }
    };
  }

  sessionEstablished(
    hostId: string,
    sessionId: string,
    transportKind: SelectionTransportKind,
  ): void {
    this.liveSessions.set(sessionId, { hostId, transportKind });
    // Newest established wins outright: a host that opens a second session while the first is still up is a host whose current session is the new one, and a verdict produced from here on names it.
    this.currentSessionIds.set(hostId, sessionId);
    // Retention rule 1: the host is back, so the restart it announced is over.
    this.retainedRestartIntents.delete(hostId);
    this.target?.sessionEstablished(hostId, sessionId, transportKind);
  }

  sessionLost(
    hostId: string,
    sessionId: string,
    transportKind: SelectionTransportKind,
  ): void {
    // Dropped from the inventory whether or not a target is bound.
    this.liveSessions.delete(sessionId);
    // Cleared only BY its own ID.
    if (this.currentSessionIds.get(hostId) === sessionId) {
      // Fall back TO A surviving session for the same host before blanking the name.
      const survivor = this.latestLiveSessionFor(hostId);
      if (survivor === null) {
        this.currentSessionIds.delete(hostId);
      } else {
        this.currentSessionIds.set(hostId, survivor);
      }
    }
    this.target?.sessionLost(hostId, sessionId, transportKind);
  }

  /** The most recently established session still live for `hostId`, or `null`. */
  private latestLiveSessionFor(hostId: string): string | null {
    let latest: string | null = null;
    for (const [sessionId, session] of this.liveSessions) {
      if (session.hostId === hostId) latest = sessionId;
    }
    return latest;
  }

  /**
   * What to call the session `hostId` is currently connected through, or `null` when this relay knows of none.
   * Read IT TO name A session, never TO test one.
   */
  currentSessionIdFor(hostId: string): string | null {
    return this.currentSessionIds.get(hostId) ?? null;
  }

  reportDialSuccess(
    hostId: string,
    attemptId: string,
    transportKind: SelectionTransportKind,
  ): void {
    this.target?.reportDialSuccess(hostId, attemptId, transportKind);
  }

  reportDialRefusal(
    hostId: string,
    attemptId: string,
    transportKind: SelectionTransportKind,
    refusalDetail: "plan-restricted" | null,
  ): void {
    this.target?.reportDialRefusal(
      hostId,
      attemptId,
      transportKind,
      refusalDetail,
    );
  }

  reportDialTimeout(
    hostId: string,
    attemptId: string,
    transportKind: SelectionTransportKind,
  ): void {
    this.target?.reportDialTimeout(hostId, attemptId, transportKind);
  }

  reportDialIndeterminate(
    hostId: string,
    attemptId: string,
    transportKind: SelectionTransportKind,
  ): void {
    this.target?.reportDialIndeterminate(hostId, attemptId, transportKind);
  }

  reportCompatVerdict(input: {
    readonly hostId: string;
    readonly probedOnSessionId: string | null;
    readonly hostVersion: string | null;
    readonly incompatibility: SelectionIncompatibility | null;
  }): void {
    this.target?.reportCompatVerdict(input);
  }

  reportRestartIntent(
    hostId: string,
    tombstoneId: string,
    expiresAt: number | null,
  ): void {
    // Retained only while unbound.
    // With a kernel bound the report reaches it now and there is nothing to hold; retaining anyway would mean replaying it again at the next bind, re-opening an episode the authority already knows about.
    if (this.target === null) {
      // Last write wins per host: a newer tombstone describes the restart that is actually in progress, and the engine would ignore the older id as a duplicate episode anyway.
      this.retainedRestartIntents.set(hostId, { tombstoneId, expiresAt });
      return;
    }
    this.target.reportRestartIntent(hostId, tombstoneId, expiresAt);
  }
}
