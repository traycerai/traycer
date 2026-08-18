/**
 * The per-window evidence kernel (connection registry §1b, P1.1) - the shim
 * that sits in a window's transport layer, REPORTS what its own transports
 * observed to the selection authority, and RENDERS from the authority's
 * aggregated verdict.
 *
 * The division of labour it exists to enforce (registry §1b, mechanism 10):
 *
 *  - A window never derives its own effective host. It has no vote. When its
 *    local evidence disagrees with the authority's verdict (its socket died
 *    while another window's lives), that is a per-lease CONDITION it reports
 *    and renders - never a reason to fail over alone.
 *  - The confirmed-death counter counts THE APP's attempts. This kernel
 *    contributes attempts; it never counts them.
 *
 * ## Dial classification: the one rule that must not be got wrong
 *
 * `confirmed-refusal` means THIS ATTEMPT was terminally refused by the
 * transport itself - connection refused, a Noise/relay handshake rejection, a
 * relay attach refusal, an attach-grant mint that came back
 * `plan-restricted`. It is deliberately NOT
 * `isConfirmedTransportRefusal(entry, hasReadyLiveSession)` from
 * `host-client/remote-fetcher.ts`: that helper is a PRE-DIAL directory gate
 * that folds cloud-DTO verdicts (`offline`, `plan-restricted`) into its
 * answer, so feeding it here would let a DTO flip advance the death counter -
 * exactly what invariant 5 forbids, and exactly the false-Offline window the
 * audit measured (≤4 h relay fuse).
 *
 * That rule is enforced STRUCTURALLY rather than by review: this kernel has
 * no "classify this error" entry point at all. A caller states the outcome it
 * observed through one of the four `reportDial*` methods, and the only one
 * that can produce death evidence with a `plan-restricted` reason takes that
 * detail from the transport error it just handled. There is no argument you
 * can pass that turns a directory verdict into a refusal.
 *
 * ## Producers
 *
 * P1.1 landed the kernel, its inventory and its attach choreography with the
 * producers deliberately unwired; P1.3 wired them through
 * {@link TransportEvidenceReporter}, which this class declares `implements`
 * against so a signature drift fails the build rather than silently orphaning
 * a producer. The transports feeding it are the remote session's connect loop
 * (`host-transport/remote/remote-session.ts` - one `reportDial*` per connect
 * generation, `sessionEstablished` at its ready boundary, `sessionLost` at its
 * teardown funnel), the local WS transport's refcounted per-host connectivity
 * (`host-transport/ws-rpc-client.ts`), and the compat probe
 * (`reportCompatVerdict`). `reportRestartIntent` has two producers, both named
 * `reportRestartIntentIfPresent` and both reacting to a fatal-error frame's
 * `restartIntent` tombstone: the streaming transport
 * (`host-transport/ws-stream-client.ts`) and the remote session
 * (`host-transport/remote/remote-session.ts`). The unary `/rpc` plane
 * (`ws-rpc-client.ts`) deliberately has none - the host does not publish
 * tombstones there.
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
 * What the window renders from. `selection` is null until the first attach
 * succeeds; `leases` is the authority's aggregate, never this window's own
 * view of its sockets.
 */
export interface SelectionKernelSnapshot {
  readonly attached: boolean;
  readonly preferredHostId: string | null;
  /**
   * The fleet-wide selection target: preferred, or the local host when preferred
   * is null (M5), or null when neither exists. Canonical wording lives on
   * `SelectionChange.targetHostId` in `selection-authority-contract.ts`.
   *
   * ⚠ NOT the epic-session `targetHostId`, which is a different concept two
   * layers away: the host a single epic session is being established on, paired
   * there with `originalHostId` (`lib/registries/epic-session-registry.ts`,
   * `providers/epic-session-provider.tsx`). Nine declarations share this
   * identifier across the two meanings, and two careful readers reached a wrong
   * shared conclusion from it inside a day - which is why every declaration of
   * this one now says which it is at the point of declaration, rather than
   * relying on the reader knowing the layer they are in.
   */
  readonly targetHostId: string | null;
  readonly effectiveHostId: string | null;
  readonly leases: readonly HostLeaseSnapshot[];
  /**
   * The authority revision this window's SELECTION slice reflects, or -1 while
   * detached. Published because a consumer that also watches the raw event
   * stream (the bridge does, for `cause`, which no snapshot carries) otherwise
   * has no way to tell whether the kernel has already adopted the revision it
   * is holding - and acting on an event the window has not applied yet
   * narrates a move against stale state.
   */
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

/**
 * One window's kernel. Construct one per renderer load; `start()` registers
 * the authority subscriptions and performs the attach that carries the
 * window's complete live-session inventory.
 */
export class SelectionEvidenceKernel implements TransportEvidenceReporter {
  private readonly options: SelectionEvidenceKernelOptions;
  /**
   * The window's live sessions, keyed by the reporter-generated sessionId.
   * This IS the inventory an attach transfers atomically, which is why it is
   * kept here rather than recomputed from the transports at attach time: a
   * re-announce step after the claim would leave an observable empty-session
   * window in which concurrent refusals could count against sockets that
   * survived (decision 8).
   */
  private readonly sessions = new Map<string, KernelSessionRecord>();

  /**
   * Restart tombstones observed while this window had no accepted
   * incarnation, keyed by host and flushed once the attach lands.
   *
   * The mirror of `sessions` for a different kind of window-knowledge: both
   * are things this window learned that the authority must be told across an
   * attach boundary, and neither survives it on its own. Cleared by proof of
   * life (see `sessionEstablished`) so the two holders of this fact - here and
   * the transport relay - are incapable of disagreeing.
   */
  private readonly retainedRestartIntents = new Map<
    string,
    {
      readonly tombstoneId: string;
      readonly expiresAt: number | null;
      readonly at: number;
    }
  >();

  private current: SelectionKernelSnapshot = DETACHED_SNAPSHOT;
  /**
   * The highest authority revision applied PER SLICE.
   *
   * Two counters, not one, because the events are PARTIAL: `selectionChanged`
   * carries the selection tuple and `leasesChanged` carries the leases, each
   * merged against whatever the other slice already held. The client replays
   * buffered events before the attach promise settles, so the snapshot
   * arrives LAST and at a LOWER revision than what was replayed - and a
   * single high-water mark then discarded the WHOLE snapshot, including the
   * slice the replay never carried. A lone `leasesChanged` at R+1 replayed
   * onto the detached state left the selection null forever even though the
   * snapshot at R knew the target; the mirror case left the leases empty (or,
   * on a re-attach, showed the outgoing identity's). Per-slice revisions let
   * the snapshot fill in exactly the slices nothing newer has superseded.
   */
  private appliedSelectionRevision = -1;
  private appliedLeasesRevision = -1;
  /**
   * Which attach attempt is current. A rotation (identity transition) starts a
   * new one while the previous claim may still be in flight; only the latest
   * attempt may publish, and none may publish after dispose.
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

  /**
   * Registers listeners first, then attaches - the order the buffering
   * protocol requires (module header rule 3): everything the authority emits
   * between the snapshot's capture and the listeners going live is buffered
   * by the client and replayed, so nothing can be lost in the gap.
   */
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
        // The MANDATORY trigger: the client has already rotated to a fresh
        // generation, so this attach carries the same inventory onto the new
        // one atomically.
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
    // The host is back, so the restart it announced is over - the same rule
    // the relay applies, and it agrees with the engine by construction, since
    // this very evidence drives `onHostProvedAlive` there. Flushing a stale
    // intent after the host proved itself alive would hold a HEALTHY host out
    // of selection for a full episode.
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

  /**
   * A dial the TRANSPORT terminally refused. `refusalDetail` is
   * `"plan-restricted"` only when the attempt's own error carried the plan
   * restriction (an attach-grant mint refused with `plan_restricted`); it is
   * the sole provenance of `dead("plan-restricted")`.
   */
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
   * An attempt that says nothing about the host - a liveness read that
   * failed, an attempt abandoned for unrelated reasons (the window slept, the
   * credential rotated mid-dial). Inert by contract: it never advances a
   * counter, and reporting it is still worth doing for diagnostics.
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
   * A restart tombstone observed on the liveness plane (P1.4's producer).
   * `expiresAt` is the HOST's clock and is display-only - the authority
   * bounds the episode with its own ceiling.
   */
  reportRestartIntent(
    hostId: string,
    tombstoneId: string,
    expiresAt: number | null,
  ): void {
    const at = this.options.now();
    if (!this.current.attached) {
      // RETAINED, because the client would otherwise drop this on the floor:
      // evidence produced before the attach BEGINS is discarded outright
      // (`attachStarted` is still false), and that window is exactly where a
      // replayed tombstone lands - the composition root binds the relay to
      // this kernel and only then calls `start()`.
      //
      // Sessions already survive that window and it is worth being precise
      // about why, because it is the reason intents did not: a session is
      // recorded in `this.sessions` and the ATTACH INVENTORY is read from
      // there, so the inventory carries it across the boundary. An intent has
      // no such carrier, so it needs this one. Same class of
      // window-knowledge, same treatment.
      //
      // Latest-per-host, matching the relay's own retention bound: a newer
      // tombstone describes the restart actually in progress, and the engine
      // would ignore the older id as a duplicate episode anyway.
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
          // A superseded attempt (a re-attach already started) or a kernel
          // that has since been torn down. Publishing here would put the
          // OUTGOING account's snapshot on screen after its wipe.
          this.options.log.debug("[selection-kernel] stale attach ignored", {
            ok: result.ok,
          });
          return result;
        }
        if (!result.ok) {
          // Every failure arm is terminal for that generation: `superseded`
          // means a newer load already owns the reporter, and
          // `version-mismatch` / `malformed-request` mean this bundle can
          // never attach with the seq it was issued. Recovery is a fresh load
          // (or the next `reattachRequired`), never a retry loop here.
          this.options.log.warn("[selection-kernel] attach refused", {
            kind: result.kind,
          });
          this.appliedSelectionRevision = -1;
          this.appliedLeasesRevision = -1;
          this.publish(DETACHED_SNAPSHOT);
          return result;
        }
        this.installSnapshot(result.snapshot);
        // FIRST THING after the attach lands, before any post-attach evidence
        // can race it: a tombstone describes a host that is ALREADY going
        // down, so anything that arrives after it should be interpreted
        // against the episode, not ahead of it.
        this.flushRetainedRestartIntents();
        return result;
      });
  }

  /**
   * Hands the authority the restart intents this window observed while it had
   * no accepted incarnation, and forgets them.
   *
   * CONSUMED, not re-announced - the semantics are "these were observed while
   * nobody could hear them; deliver them once", and a later attach must not
   * re-open a settled episode. A redundant delivery would be inert anyway
   * (the engine keys episodes on `(hostId, tombstoneId)` and a duplicate can
   * never extend one), which is also why no third dedup mechanism is added
   * here if the relay's own retention and this one ever overlap: the engine
   * already bounds a double delivery.
   *
   * BOUNDED BY AGE, on this kernel's own clock. A retained value needs its own
   * expiry: the only releases were a successful attach and a `sessionEstablished`
   * for the host, so a refused first attach (`superseded` by a rotation) kept
   * an intent for as long as the window stayed unattached and then delivered
   * it at the next attach - where the engine stamps a FRESH episode from its
   * `now`, opening a 60 s `restarting-expected` hold on a host that had been
   * up the whole time and never re-announced a session to this kernel. An
   * intent older than one episode length describes an outage the authority
   * has already finished bounding; it is dropped, not delivered.
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

  /**
   * Merges the accepted attach snapshot into every slice nothing newer has
   * already superseded, then publishes ONCE. A slice already carrying a
   * higher revision keeps its value; a slice still below the snapshot takes
   * the snapshot's. `attached` latches either way - it is a fact about this
   * kernel's claim, not about authority state.
   */
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
