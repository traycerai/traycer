/**
 * The client half of the selection-authority attach choreography (P1.1),
 * transport-agnostic so exactly ONE implementation serves both bindings:
 *
 *  - desktop: the preload builds it over `ipcRenderer` (parsers at ingress);
 *  - browser/dev: the in-process adapter builds it over the engine directly.
 *
 * Two layers, matching the contract's two ideas:
 *
 *  - {@link BufferedSelectionAuthorityClient} is ONE client instance: one
 *    engine-issued `attachSeq`, at most one attach, and the
 *    buffer-then-install-then-replay protocol (module header rules 2-7).
 *  - {@link RotatingSelectionAuthorityClient} is the stable object a consumer
 *    holds. `reattachRequired` is the MANDATORY post-identity-transition
 *    trigger, and the contract's answer to it is a NEW instance with a
 *    FRESHLY ALLOCATED seq - so this layer retires the current instance,
 *    builds the next one (which starts buffering immediately), and only then
 *    tells the consumer, whose `attach()` therefore lands on the new
 *    generation with its own live-session inventory.
 *
 * Neither layer parses: the transport hands over values that already crossed
 * their parser boundary, so domain code here never sees unparsed input.
 */
import {
  type ActivateResult,
  type HostLeaseSnapshot,
  type LiveSessionAnnouncement,
  type SelectionAttachRequest,
  type SelectionAttachResult,
  type SelectionAuthorityClient,
  type SelectionChange,
  type SelectionEvidenceReport,
  type SelectionReattachRequired,
  type SelectionRevisioned,
  type SelectionSubscription,
} from "./selection-authority-contract";
import { type AuthorityLog } from "./selection-authority-engine";

/**
 * What one client instance needs from its binding. Every method is the
 * post-parse form: the desktop transport runs the wire parsers, the
 * in-process transport has no wire to cross.
 */
export interface SelectionAuthorityClientTransport {
  /**
   * The engine-issued attach generation for THIS instance (module header
   * rule 1). Called exactly once, at instance construction - allocation
   * advances the reporter's supersession fence, so an instance that is built
   * and never attached still supersedes its predecessor.
   */
  allocateAttachSeq(): number;
  attach(request: SelectionAttachRequest): Promise<SelectionAttachResult>;
  reportEvidence(
    incarnationId: string,
    report: SelectionEvidenceReport,
  ): Promise<void>;
  activate(incarnationId: string, hostId: string): Promise<ActivateResult>;
  onSelectionChanged(
    listener: (event: SelectionRevisioned<SelectionChange>) => void,
  ): SelectionSubscription;
  onLeasesChanged(
    listener: (
      event: SelectionRevisioned<readonly HostLeaseSnapshot[]>,
    ) => void,
  ): SelectionSubscription;
  onReattachRequired(
    listener: (event: SelectionReattachRequired) => void,
  ): SelectionSubscription;
}

type BufferedEvent =
  | {
      readonly revision: number;
      readonly kind: "selection";
      readonly event: SelectionRevisioned<SelectionChange>;
    }
  | {
      readonly revision: number;
      readonly kind: "leases";
      readonly event: SelectionRevisioned<readonly HostLeaseSnapshot[]>;
    }
  | {
      readonly revision: number;
      readonly kind: "reattach";
      readonly event: SelectionReattachRequired;
    };

type InstancePhase = "buffering" | "live" | "disposed";

/**
 * One client instance: attach-once, buffer-then-replay.
 *
 * Lifecycle (module header rules 2-7): construction allocates the seq and
 * starts BUFFERING every event the transport delivers. `attach` installs the
 * returned snapshot, discards buffered events at or below its revision,
 * replays the rest in revision order, and goes live. Every `ok: false` arm -
 * including an unparseable result the transport reports as a rejection -
 * disposes the instance's listeners and buffer, because each of them is
 * terminal for this generation.
 */
export class BufferedSelectionAuthorityClient implements SelectionAuthorityClient {
  private readonly transport: SelectionAuthorityClientTransport;
  private readonly log: AuthorityLog;
  private readonly attachSeq: number;

  private phase: InstancePhase = "buffering";
  private attachStarted = false;
  private incarnationId: string | null = null;
  /**
   * The client's single high-water mark. Because no two events ever share a
   * revision, this one number totally orders all THREE event kinds - which is
   * also what makes a post-transition client drop the transition's stale
   * `reattachRequired` through the ordinary filter rather than a special case.
   */
  private highWaterRevision = -1;
  private buffer: BufferedEvent[] = [];
  /** Evidence produced while the attach claim is in flight; see reportEvidence. */
  private pendingEvidence: SelectionEvidenceReport[] = [];

  private readonly subscriptions: SelectionSubscription[] = [];
  private readonly selectionListeners = new Set<
    (event: SelectionRevisioned<SelectionChange>) => void
  >();
  private readonly leaseListeners = new Set<
    (event: SelectionRevisioned<readonly HostLeaseSnapshot[]>) => void
  >();
  private readonly reattachListeners = new Set<
    (event: SelectionReattachRequired) => void
  >();

  constructor(transport: SelectionAuthorityClientTransport, log: AuthorityLog) {
    this.transport = transport;
    this.log = log;
    this.attachSeq = transport.allocateAttachSeq();
    this.subscriptions.push(
      transport.onSelectionChanged((event) => {
        this.receive({
          revision: event.revision,
          kind: "selection",
          event,
        });
      }),
      transport.onLeasesChanged((event) => {
        this.receive({ revision: event.revision, kind: "leases", event });
      }),
      transport.onReattachRequired((event) => {
        this.receive({ revision: event.revision, kind: "reattach", event });
      }),
    );
  }

  attach(
    callerContractVersion: number,
    liveSessions: readonly LiveSessionAnnouncement[],
  ): Promise<SelectionAttachResult> {
    if (this.attachSeq < 0) {
      // The binding could not obtain an issued generation (an unknown or
      // untrusted sender at the sync channel). Presenting a seq the engine
      // never issued could only ever be refused, so the refusal is answered
      // here rather than round-tripped.
      this.log.warn("[selection-client] attach without an issued seq", {});
      this.dispose();
      return Promise.resolve({ ok: false, kind: "superseded" });
    }
    if (this.attachStarted || this.phase === "disposed") {
      // Attach-once is a terminal state of the INSTANCE (module header rule
      // 2). A second attach on the same instance is exactly the situation
      // `superseded` describes - this seq can no longer be claimed - so the
      // answer is the same one the engine would give, without an IPC round
      // trip that could be mistaken for a fresh claim.
      return Promise.resolve({ ok: false, kind: "superseded" });
    }
    this.attachStarted = true;
    return this.transport
      .attach({
        attachSeq: this.attachSeq,
        callerContractVersion,
        liveSessions,
      })
      .then((result) => {
        if (this.phase === "disposed") {
          // Retired while the claim was in flight (the consumer tore down, or
          // a rotation replaced this generation). The completion belongs to a
          // generation nobody owns any more, so it is never installed and
          // never reported as a success - `superseded` is the truthful arm.
          this.log.debug("[selection-client] attach completed after retire", {
            ok: result.ok,
          });
          const retired: SelectionAttachResult = {
            ok: false,
            kind: "superseded",
          };
          return retired;
        }
        if (!result.ok) {
          this.log.debug("[selection-client] attach refused", {
            kind: result.kind,
          });
          this.dispose();
          return result;
        }
        this.install(result.incarnationId, result.snapshot.revision);
        return result;
      })
      .catch((error: unknown) => {
        this.log.warn("[selection-client] attach failed", {
          error: String(error),
        });
        this.dispose();
        // A rejected or unparseable completion leaves the ENGINE's state
        // unknown to this side: the claim may well have been consumed. So the
        // arm reported is `superseded`, which asserts only what the client can
        // actually know - this instance will never attach again - rather than
        // `malformed-request{claimed:false}`, which would assert that nothing
        // mutated.
        const failed: SelectionAttachResult = {
          ok: false,
          kind: "superseded",
        };
        return failed;
      });
  }

  /**
   * Reports evidence under the accepted incarnation, QUEUEING it while the
   * attach claim is still in flight.
   *
   * The queue is not a nicety. Attach carries a session inventory captured
   * when the request was built, and the kernel keeps observing its transports
   * while the claim travels. Dropping reports in that window loses both
   * directions: a session announced in the inventory but LOST before the claim
   * landed would stay live in the authority forever - phantom liveness that
   * suppresses the death counter for that host indefinitely - and a session
   * ESTABLISHED after capture would be absent from both the inventory and the
   * dropped report, so refusals would count against a socket that is up.
   * Queueing in order and flushing after the inventory is installed makes the
   * window a delay rather than a hole.
   */
  reportEvidence(report: SelectionEvidenceReport): Promise<void> {
    if (this.phase === "disposed") return Promise.resolve();
    const incarnationId = this.incarnationId;
    if (incarnationId === null) {
      if (this.attachStarted) this.pendingEvidence.push(report);
      return Promise.resolve();
    }
    return this.send(incarnationId, report);
  }

  private send(
    incarnationId: string,
    report: SelectionEvidenceReport,
  ): Promise<void> {
    // Rejections are contained here (decision 3): a report racing teardown
    // must never surface as an unhandled rejection in the renderer.
    return this.transport
      .reportEvidence(incarnationId, report)
      .catch((error: unknown) => {
        this.log.debug("[selection-client] report dropped", {
          error: String(error),
        });
      });
  }

  /**
   * Flushes the deferred reports in arrival order, under the incarnation the
   * engine just accepted. Order is preserved by the transport (one channel,
   * FIFO), which is what keeps an established/lost pair from inverting.
   */
  private flushPendingEvidence(incarnationId: string): void {
    const queued = this.pendingEvidence;
    this.pendingEvidence = [];
    for (const report of queued) {
      void this.send(incarnationId, report);
    }
  }

  activate(hostId: string): Promise<ActivateResult> {
    const incarnationId = this.incarnationId;
    if (incarnationId === null) {
      return Promise.resolve({ ok: false, reason: "not-attached" });
    }
    return this.transport
      .activate(incarnationId, hostId)
      .catch((error: unknown) => {
        this.log.warn("[selection-client] activate failed", {
          error: String(error),
        });
        const refused: ActivateResult = { ok: false, reason: "unrecognized" };
        return refused;
      });
  }

  onSelectionChanged(
    listener: (event: SelectionRevisioned<SelectionChange>) => void,
  ): SelectionSubscription {
    this.selectionListeners.add(listener);
    return {
      dispose: () => {
        this.selectionListeners.delete(listener);
      },
    };
  }

  onLeasesChanged(
    listener: (
      event: SelectionRevisioned<readonly HostLeaseSnapshot[]>,
    ) => void,
  ): SelectionSubscription {
    this.leaseListeners.add(listener);
    return {
      dispose: () => {
        this.leaseListeners.delete(listener);
      },
    };
  }

  onReattachRequired(
    listener: (event: SelectionReattachRequired) => void,
  ): SelectionSubscription {
    this.reattachListeners.add(listener);
    return {
      dispose: () => {
        this.reattachListeners.delete(listener);
      },
    };
  }

  /** Drops the transport subscriptions and the buffer. Idempotent. */
  dispose(): void {
    if (this.phase === "disposed") return;
    this.phase = "disposed";
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.subscriptions.length = 0;
    this.buffer = [];
    // Deferred reports die with the generation that produced them: they carry
    // no incarnation yet, and the next generation re-announces its own
    // inventory from the kernel's live state.
    this.pendingEvidence = [];
  }

  private receive(entry: BufferedEvent): void {
    if (this.phase === "disposed") return;
    if (this.phase === "buffering") {
      this.buffer.push(entry);
      return;
    }
    if (entry.revision <= this.highWaterRevision) return;
    this.highWaterRevision = entry.revision;
    this.deliver(entry);
  }

  /**
   * Installs the snapshot and drains the buffer in revision order.
   *
   * The phase stays `buffering` until the drain is complete, and the drain
   * loops until nothing new has arrived. That matters for the in-process
   * binding, where delivery is synchronous: a consumer that reacts to a
   * replayed event by driving the engine produces a NEW event re-entrantly,
   * and going live before the drain finished would deliver that newer event
   * ahead of older buffered ones - the exact ordering inversion the single
   * high-water mark exists to prevent.
   */
  private install(incarnationId: string, snapshotRevision: number): void {
    this.incarnationId = incarnationId;
    this.highWaterRevision = snapshotRevision;
    this.flushPendingEvidence(incarnationId);
    let pending = this.takePending();
    while (pending.length > 0) {
      for (const entry of pending) {
        if (entry.revision <= this.highWaterRevision) continue;
        this.highWaterRevision = entry.revision;
        this.deliver(entry);
      }
      pending = this.takePending();
    }
    // A replayed event can retire this instance from under us: the rotating
    // layer disposes it the moment a `reattachRequired` reaches the consumer.
    // Going live afterwards would resurrect a retired generation - listeners
    // re-armed on an instance nobody owns.
    if (this.phase === "disposed") return;
    this.phase = "live";
  }

  private takePending(): BufferedEvent[] {
    const pending = this.buffer
      .filter((entry) => entry.revision > this.highWaterRevision)
      .sort((left, right) => left.revision - right.revision);
    this.buffer = [];
    return pending;
  }

  private deliver(entry: BufferedEvent): void {
    if (entry.kind === "selection") {
      for (const listener of Array.from(this.selectionListeners)) {
        this.safely(() => listener(entry.event));
      }
      return;
    }
    if (entry.kind === "leases") {
      for (const listener of Array.from(this.leaseListeners)) {
        this.safely(() => listener(entry.event));
      }
      return;
    }
    for (const listener of Array.from(this.reattachListeners)) {
      this.safely(() => listener(entry.event));
    }
  }

  private safely(run: () => void): void {
    try {
      run();
    } catch (error: unknown) {
      this.log.warn("[selection-client] listener threw", {
        error: String(error),
      });
    }
  }
}

/**
 * The stable {@link SelectionAuthorityClient} a consumer holds for the life of
 * the renderer, rotating the underlying instance on every `reattachRequired`.
 *
 * Rotation order matters and is the whole reason this layer exists: the new
 * instance is constructed (allocating its seq, which advances the fence, and
 * starting to buffer) BEFORE the consumer is told to re-attach, so the
 * consumer's `attach()` cannot land on the retired generation and no event
 * emitted in between is lost.
 */
export class RotatingSelectionAuthorityClient implements SelectionAuthorityClient {
  private readonly createInstance: () => BufferedSelectionAuthorityClient;
  private readonly log: AuthorityLog;

  private instance: BufferedSelectionAuthorityClient;
  private instanceSubscriptions: SelectionSubscription[] = [];
  private disposed = false;

  private readonly selectionListeners = new Set<
    (event: SelectionRevisioned<SelectionChange>) => void
  >();
  private readonly leaseListeners = new Set<
    (event: SelectionRevisioned<readonly HostLeaseSnapshot[]>) => void
  >();
  private readonly reattachListeners = new Set<
    (event: SelectionReattachRequired) => void
  >();

  constructor(
    createInstance: () => BufferedSelectionAuthorityClient,
    log: AuthorityLog,
  ) {
    this.createInstance = createInstance;
    this.log = log;
    this.instance = createInstance();
    this.bindInstance();
  }

  /**
   * Delegates to the CURRENT instance and refuses a completion that arrives
   * for a generation this layer has since rotated away from. Without that
   * check, an identity transition landing mid-claim would resolve a
   * `ok: true` carrying the OUTGOING account's snapshot and incarnation -
   * observable state from before the wipe, handed to the consumer after it.
   */
  attach(
    callerContractVersion: number,
    liveSessions: readonly LiveSessionAnnouncement[],
  ): Promise<SelectionAttachResult> {
    const delegate = this.instance;
    return delegate
      .attach(callerContractVersion, liveSessions)
      .then((result) => {
        if (this.instance === delegate) return result;
        this.log.debug(
          "[selection-client] attach completed on a retired generation",
          {
            ok: result.ok,
          },
        );
        const superseded: SelectionAttachResult = {
          ok: false,
          kind: "superseded",
        };
        return superseded;
      });
  }

  reportEvidence(report: SelectionEvidenceReport): Promise<void> {
    return this.instance.reportEvidence(report);
  }

  activate(hostId: string): Promise<ActivateResult> {
    return this.instance.activate(hostId);
  }

  onSelectionChanged(
    listener: (event: SelectionRevisioned<SelectionChange>) => void,
  ): SelectionSubscription {
    this.selectionListeners.add(listener);
    return {
      dispose: () => {
        this.selectionListeners.delete(listener);
      },
    };
  }

  onLeasesChanged(
    listener: (
      event: SelectionRevisioned<readonly HostLeaseSnapshot[]>,
    ) => void,
  ): SelectionSubscription {
    this.leaseListeners.add(listener);
    return {
      dispose: () => {
        this.leaseListeners.delete(listener);
      },
    };
  }

  onReattachRequired(
    listener: (event: SelectionReattachRequired) => void,
  ): SelectionSubscription {
    this.reattachListeners.add(listener);
    return {
      dispose: () => {
        this.reattachListeners.delete(listener);
      },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unbindInstance();
    this.instance.dispose();
    this.selectionListeners.clear();
    this.leaseListeners.clear();
    this.reattachListeners.clear();
  }

  private bindInstance(): void {
    this.instanceSubscriptions = [
      this.instance.onSelectionChanged((event) => {
        for (const listener of Array.from(this.selectionListeners)) {
          this.safely(() => listener(event));
        }
      }),
      this.instance.onLeasesChanged((event) => {
        for (const listener of Array.from(this.leaseListeners)) {
          this.safely(() => listener(event));
        }
      }),
      this.instance.onReattachRequired((event) => {
        this.rotate();
        for (const listener of Array.from(this.reattachListeners)) {
          this.safely(() => listener(event));
        }
      }),
    ];
  }

  private unbindInstance(): void {
    for (const subscription of this.instanceSubscriptions) {
      subscription.dispose();
    }
    this.instanceSubscriptions = [];
  }

  private rotate(): void {
    if (this.disposed) return;
    const retired = this.instance;
    this.unbindInstance();
    retired.dispose();
    this.instance = this.createInstance();
    this.bindInstance();
  }

  private safely(run: () => void): void {
    try {
      run();
    } catch (error: unknown) {
      this.log.warn("[selection-client] listener threw", {
        error: String(error),
      });
    }
  }
}
