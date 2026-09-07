/**
 * A window reports transport evidence and renders the authority's verdict; it never derives its own effective host or counts deaths.
 * `confirmed-refusal` is this attempt's transport refusal, not a directory DTO gate; there is no classify-this-error entry point.
 */
import {
  SELECTION_AUTHORITY_CONTRACT_VERSION,
  type HostLeaseSnapshot,
  type LiveSessionAnnouncement,
  type SelectionAttachResult,
  type SelectionAuthorityClient,
  type SelectionAuthoritySnapshot,
  type SelectionChange,
  type SelectionIncompatibility,
  type SelectionSubscription,
  type SelectionTransportKind,
} from "./selection-authority-contract";
import {
  RESTART_INTENT_EPISODE_MS,
  type AuthorityLog,
} from "./selection-authority-engine";
import { type TransportEvidenceReporter } from "./transport-evidence";

/**
 * What the window renders from.
 * `selection` is null until the first attach succeeds; `leases` is the authority's aggregate, never this window's own view of its sockets.
 */
export interface SelectionKernelSnapshot {
  readonly attached: boolean;
  readonly preferredHostId: string | null;
  /** Fleet-wide selection target, not the epic-session targetHostId two layers away. */
  readonly targetHostId: string | null;
  readonly effectiveHostId: string | null;
  readonly leases: readonly HostLeaseSnapshot[];
  /** Selection-slice revision, or -1 while detached. Needed so a raw-event consumer does not narrate against stale state. */
  readonly selectionRevision: number;
}

const DETACHED_SNAPSHOT: SelectionKernelSnapshot = {
  attached: false,
  preferredHostId: null,
  targetHostId: null,
  effectiveHostId: null,
  leases: [],
  selectionRevision: -1,
};

export interface SelectionEvidenceKernelOptions {
  readonly client: SelectionAuthorityClient;
  /**
   * Stamps the diagnostic `at` on every report. Identity and ordering come
   * from attemptIds and authority revisions, never from this clock.
   */
  readonly now: () => number;
  readonly log: AuthorityLog;
}

interface KernelSessionRecord {
  readonly hostId: string;
  readonly transportKind: SelectionTransportKind;
}

export class SelectionEvidenceKernel implements TransportEvidenceReporter {
  private readonly options: SelectionEvidenceKernelOptions;
  /** Attach inventory. Recomputing from transports at attach time would leave an empty-session window. */
  private readonly sessions = new Map<string, KernelSessionRecord>();

  /** Restart tombstones observed while unattached, flushed once attach lands. Cleared by proof of life. */
  private readonly retainedRestartIntents = new Map<
    string,
    {
      readonly tombstoneId: string;
      readonly expiresAt: number | null;
      readonly at: number;
    }
  >();

  private current: SelectionKernelSnapshot = DETACHED_SNAPSHOT;
  /** Per-slice high-water marks. Events are partial; a single mark would discard a snapshot that fills the other slice. */
  private appliedSelectionRevision = -1;
  private appliedLeasesRevision = -1;
  /**
   * Which attach attempt is current.
   * A rotation (identity transition) starts a new one while the previous claim may still be in flight; only the latest attempt may publish, and none may publish after dispose.
   */
  private attachAttempt = 0;
  private started = false;
  private disposed = false;
  private readonly subscriptions: SelectionSubscription[] = [];
  private readonly listeners = new Set<
    (snapshot: SelectionKernelSnapshot) => void
  >();

  constructor(options: SelectionEvidenceKernelOptions) {
    this.options = options;
  }

  /** Register listeners, then attach, so the buffer covers the snapshot-to-listener gap. */
  start(): Promise<SelectionAttachResult> {
    if (this.started || this.disposed) {
      return Promise.resolve({ ok: false, kind: "superseded" });
    }
    this.started = true;
    const client = this.options.client;
    this.subscriptions.push(
      client.onSelectionChanged((event) => {
        this.applySelection(event.revision, event.change);
      }),
      client.onLeasesChanged((event) => {
        this.applyLeases(event.revision, event.change);
      }),
      client.onReattachRequired(() => {
        // The mandatory trigger: the client has already rotated to a fresh generation, so this attach carries the same inventory onto the new one atomically.
        void this.attach();
      }),
    );
    return this.attach();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.subscriptions.length = 0;
    this.listeners.clear();
  }

  snapshot(): SelectionKernelSnapshot {
    return this.current;
  }

  /** Lease/selection subscription surface consumed by P1.2+ surfaces. */
  onChange(
    listener: (snapshot: SelectionKernelSnapshot) => void,
  ): SelectionSubscription {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  /** This window's own live-session count for a host (divergence display). */
  localSessionCount(hostId: string): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.hostId === hostId) count += 1;
    }
    return count;
  }

  // -------------------------------------------------------------- sessions

  sessionEstablished(
    hostId: string,
    sessionId: string,
    transportKind: SelectionTransportKind,
  ): void {
    this.sessions.set(sessionId, { hostId, transportKind });
    // The host is back, so the restart it announced is over - the same rule the relay applies, and it agrees with the engine by construction, since this very evidence drives `onHostProvedAlive` there.
    // Flushing a stale intent after the host proved itself alive would hold a healthy host out of selection for a full episode.
    this.retainedRestartIntents.delete(hostId);
    void this.options.client.reportEvidence({
      kind: "session",
      hostId,
      sessionId,
      transition: "established",
      transportKind,
      at: this.options.now(),
    });
  }

  sessionLost(
    hostId: string,
    sessionId: string,
    transportKind: SelectionTransportKind,
  ): void {
    this.sessions.delete(sessionId);
    void this.options.client.reportEvidence({
      kind: "session",
      hostId,
      sessionId,
      transition: "lost",
      transportKind,
      at: this.options.now(),
    });
  }

  // ----------------------------------------------------------------- dials

  /** A dial that reached the host. Clears the host's death streak. */
  reportDialSuccess(
    hostId: string,
    attemptId: string,
    transportKind: SelectionTransportKind,
  ): void {
    this.reportDial(hostId, attemptId, transportKind, "success");
  }

  /** plan-restricted only when this attempt's error carried it; sole provenance of dead(plan-restricted). */
  reportDialRefusal(
    hostId: string,
    attemptId: string,
    transportKind: SelectionTransportKind,
    refusalDetail: "plan-restricted" | null,
  ): void {
    void this.options.client.reportEvidence({
      kind: "dial",
      hostId,
      attemptId,
      outcome: "confirmed-refusal",
      refusalDetail,
      transportKind,
      at: this.options.now(),
    });
  }

  /** A dial that ran out of time without an answer. Death evidence. */
  reportDialTimeout(
    hostId: string,
    attemptId: string,
    transportKind: SelectionTransportKind,
  ): void {
    this.reportDial(hostId, attemptId, transportKind, "timeout");
  }

  /**
   * An attempt that says nothing about the host - a liveness read that failed, an attempt abandoned for unrelated reasons (the window slept, the credential rotated mid-dial).
   * Inert by contract: it never advances a counter, and reporting it is still worth doing for diagnostics.
   */
  reportDialIndeterminate(
    hostId: string,
    attemptId: string,
    transportKind: SelectionTransportKind,
  ): void {
    this.reportDial(hostId, attemptId, transportKind, "indeterminate");
  }

  // ------------------------------------------------------- compat / restart

  reportCompatVerdict(input: {
    readonly hostId: string;
    readonly probedOnSessionId: string | null;
    readonly hostVersion: string | null;
    readonly incompatibility: SelectionIncompatibility | null;
  }): void {
    const at = this.options.now();
    if (input.incompatibility === null) {
      void this.options.client.reportEvidence({
        kind: "compat",
        hostId: input.hostId,
        probedOnSessionId: input.probedOnSessionId,
        hostVersion: input.hostVersion,
        verdict: "compatible",
        incompatibility: null,
        at,
      });
      return;
    }
    void this.options.client.reportEvidence({
      kind: "compat",
      hostId: input.hostId,
      probedOnSessionId: input.probedOnSessionId,
      hostVersion: input.hostVersion,
      verdict: "incompatible",
      incompatibility: input.incompatibility,
      at,
    });
  }

  /**
   * `expiresAt` is the host's clock and is display-only - the authority bounds the episode with its own ceiling.
   */
  reportRestartIntent(
    hostId: string,
    tombstoneId: string,
    expiresAt: number | null,
  ): void {
    const at = this.options.now();
    if (!this.current.attached) {
      // Retain pre-attach intents: they have no inventory carrier. Latest-per-host, matching the relay's bound.
      this.retainedRestartIntents.set(hostId, { tombstoneId, expiresAt, at });
      return;
    }
    void this.options.client.reportEvidence({
      kind: "restart-intent",
      hostId,
      tombstoneId,
      expiresAt,
      at,
    });
  }

  // ------------------------------------------------------------- internals

  private reportDial(
    hostId: string,
    attemptId: string,
    transportKind: SelectionTransportKind,
    outcome: "success" | "timeout" | "indeterminate",
  ): void {
    void this.options.client.reportEvidence({
      kind: "dial",
      hostId,
      attemptId,
      outcome,
      transportKind,
      at: this.options.now(),
    });
  }

  private inventory(): readonly LiveSessionAnnouncement[] {
    const announcements: LiveSessionAnnouncement[] = [];
    for (const [sessionId, session] of this.sessions) {
      announcements.push({
        hostId: session.hostId,
        sessionId,
        transportKind: session.transportKind,
      });
    }
    return announcements;
  }

  private attach(): Promise<SelectionAttachResult> {
    this.attachAttempt += 1;
    const attempt = this.attachAttempt;
    return this.options.client
      .attach(SELECTION_AUTHORITY_CONTRACT_VERSION, this.inventory())
      .then((result) => {
        if (this.disposed || attempt !== this.attachAttempt) {
          // A superseded attempt (a re-attach already started) or a kernel that has since been torn down.
          // Publishing here would put the outgoing account's snapshot on screen after its wipe.
          this.options.log.debug("[selection-kernel] stale attach ignored", {
            ok: result.ok,
          });
          return result;
        }
        if (!result.ok) {
          // Every failure arm is terminal for that generation: `superseded` means a newer load already owns the reporter, and `version-mismatch` / `malformed-request` mean this bundle can never attach with the seq it was issued.
          // Recovery is a fresh load (or the next `reattachRequired`), never a retry loop here.
          this.options.log.warn("[selection-kernel] attach refused", {
            kind: result.kind,
          });
          this.appliedSelectionRevision = -1;
          this.appliedLeasesRevision = -1;
          this.publish(DETACHED_SNAPSHOT);
          return result;
        }
        this.installSnapshot(result.snapshot);
        this.flushRetainedRestartIntents();
        return result;
      });
  }

  /**
   * Deliver intents observed while unattached once, then forget them. Drop intents older than one episode length; delivering them would stamp a fresh hold on a host that never re-announced.
   */
  private flushRetainedRestartIntents(): void {
    const retained = Array.from(this.retainedRestartIntents);
    this.retainedRestartIntents.clear();
    const now = this.options.now();
    for (const [hostId, intent] of retained) {
      if (now - intent.at > RESTART_INTENT_EPISODE_MS) continue;
      void this.options.client.reportEvidence({
        kind: "restart-intent",
        hostId,
        tombstoneId: intent.tombstoneId,
        expiresAt: intent.expiresAt,
        at: intent.at,
      });
    }
  }

  private applySelection(revision: number, change: SelectionChange): void {
    if (revision <= this.appliedSelectionRevision) return;
    this.appliedSelectionRevision = revision;
    this.publish({
      attached: true,
      preferredHostId: change.preferredHostId,
      targetHostId: change.targetHostId,
      effectiveHostId: change.effectiveHostId,
      leases: this.current.leases,
      selectionRevision: revision,
    });
  }

  private applyLeases(
    revision: number,
    leases: readonly HostLeaseSnapshot[],
  ): void {
    if (revision <= this.appliedLeasesRevision) return;
    this.appliedLeasesRevision = revision;
    this.publish({ ...this.current, leases });
  }

  /** Merge snapshot into slices nothing newer has superseded, then publish once. */
  private installSnapshot(snapshot: SelectionAuthoritySnapshot): void {
    const selectionIsFresher =
      this.appliedSelectionRevision < snapshot.revision;
    const leasesAreFresher = this.appliedLeasesRevision < snapshot.revision;
    if (selectionIsFresher) this.appliedSelectionRevision = snapshot.revision;
    if (leasesAreFresher) this.appliedLeasesRevision = snapshot.revision;
    this.publish({
      attached: true,
      preferredHostId: selectionIsFresher
        ? snapshot.preferredHostId
        : this.current.preferredHostId,
      targetHostId: selectionIsFresher
        ? snapshot.targetHostId
        : this.current.targetHostId,
      effectiveHostId: selectionIsFresher
        ? snapshot.effectiveHostId
        : this.current.effectiveHostId,
      leases: leasesAreFresher ? snapshot.leases : this.current.leases,
      selectionRevision: this.appliedSelectionRevision,
    });
  }

  private publish(snapshot: SelectionKernelSnapshot): void {
    this.current = snapshot;
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(snapshot);
      } catch (error: unknown) {
        this.options.log.warn("[selection-kernel] listener threw", {
          error: String(error),
        });
      }
    }
  }
}
