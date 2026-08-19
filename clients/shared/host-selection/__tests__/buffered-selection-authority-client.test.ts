import { describe, expect, it } from "vitest";
import {
  SELECTION_AUTHORITY_CONTRACT_VERSION,
  type ActivateResult,
  type HostLeaseSnapshot,
  type SelectionAttachRequest,
  type SelectionAttachResult,
  type SelectionAuthoritySnapshot,
  type SelectionChange,
  type SelectionEvidenceReport,
  type SelectionReattachRequired,
  type SelectionRevisioned,
  type SelectionSubscription,
} from "../selection-authority-contract";
import { silentAuthorityLog } from "../selection-authority-engine";
import {
  BufferedSelectionAuthorityClient,
  RotatingSelectionAuthorityClient,
  type SelectionAuthorityClientTransport,
} from "../buffered-selection-authority-client";

// ------------------------------------------------------------------ builders

function snapshotAt(revision: number): SelectionAuthoritySnapshot {
  return {
    contractVersion: SELECTION_AUTHORITY_CONTRACT_VERSION,
    revision,
    preferredHostId: null,
    targetHostId: null,
    effectiveHostId: null,
    leases: [],
  };
}

function selectionChangeStub(): SelectionChange {
  return {
    preferredHostId: null,
    targetHostId: null,
    effectiveHostId: null,
    previousEffectiveHostId: null,
    cause: "failover",
  };
}

function dialReportStub(
  hostId: string,
  attemptId: string,
): SelectionEvidenceReport {
  return {
    kind: "dial",
    hostId,
    attemptId,
    outcome: "success",
    transportKind: "remote-relay",
    at: 0,
  };
}

function sessionReportStub(
  hostId: string,
  sessionId: string,
  transition: "established" | "lost",
): SelectionEvidenceReport {
  return {
    kind: "session",
    hostId,
    sessionId,
    transition,
    transportKind: "remote-relay",
    at: 0,
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Records every call the client instance makes and gives the test full
 * control over when `attach` resolves and what it resolves with - the
 * plan explicitly wants a fake transport, not a real engine, for this file.
 */
class FakeTransport implements SelectionAuthorityClientTransport {
  private readonly seqs: readonly number[];
  private seqIndex = 0;

  readonly attachRequests: SelectionAttachRequest[] = [];
  readonly reportEvidenceCalls: Array<{
    readonly incarnationId: string;
    readonly report: SelectionEvidenceReport;
  }> = [];
  readonly activateCalls: Array<{
    readonly incarnationId: string;
    readonly hostId: string;
  }> = [];

  /**
   * Incremented by every subscription's `dispose()` - the three the
   * constructor takes out (selection/leases/reattach). This is what tells
   * "the instance disposed" apart from "the instance merely never went
   * live": a client stuck in `buffering` also delivers nothing and also
   * never calls `reportEvidence`, but it never disposes its subscriptions.
   */
  disposedSubscriptionCount = 0;

  reportEvidenceImpl: (
    incarnationId: string,
    report: SelectionEvidenceReport,
  ) => Promise<void> = () => Promise.resolve();
  activateImpl: (
    incarnationId: string,
    hostId: string,
  ) => Promise<ActivateResult> = () =>
    Promise.resolve({ ok: false, reason: "unrecognized" });

  private readonly attachDeferreds: Array<Deferred<SelectionAttachResult>> = [];
  private readonly selectionListeners = new Set<
    (event: SelectionRevisioned<SelectionChange>) => void
  >();
  private readonly leaseListeners = new Set<
    (event: SelectionRevisioned<readonly HostLeaseSnapshot[]>) => void
  >();
  private readonly reattachListeners = new Set<
    (event: SelectionReattachRequired) => void
  >();

  constructor(seqs: readonly number[]) {
    this.seqs = seqs;
  }

  allocateAttachSeq(): number {
    const seq = this.seqs[this.seqIndex] ?? -1;
    this.seqIndex += 1;
    return seq;
  }

  attach(request: SelectionAttachRequest): Promise<SelectionAttachResult> {
    this.attachRequests.push(request);
    const deferred = createDeferred<SelectionAttachResult>();
    this.attachDeferreds.push(deferred);
    return deferred.promise;
  }

  resolveLastAttach(result: SelectionAttachResult): void {
    const deferred = this.attachDeferreds[this.attachDeferreds.length - 1];
    if (deferred === undefined) throw new Error("no pending attach to resolve");
    deferred.resolve(result);
  }

  rejectLastAttach(error: unknown): void {
    const deferred = this.attachDeferreds[this.attachDeferreds.length - 1];
    if (deferred === undefined) throw new Error("no pending attach to reject");
    deferred.reject(error);
  }

  reportEvidence(
    incarnationId: string,
    report: SelectionEvidenceReport,
  ): Promise<void> {
    this.reportEvidenceCalls.push({ incarnationId, report });
    return this.reportEvidenceImpl(incarnationId, report);
  }

  activate(incarnationId: string, hostId: string): Promise<ActivateResult> {
    this.activateCalls.push({ incarnationId, hostId });
    return this.activateImpl(incarnationId, hostId);
  }

  onSelectionChanged(
    listener: (event: SelectionRevisioned<SelectionChange>) => void,
  ): SelectionSubscription {
    this.selectionListeners.add(listener);
    return {
      dispose: () => {
        this.selectionListeners.delete(listener);
        this.disposedSubscriptionCount += 1;
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
        this.disposedSubscriptionCount += 1;
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
        this.disposedSubscriptionCount += 1;
      },
    };
  }

  emitSelection(event: SelectionRevisioned<SelectionChange>): void {
    for (const listener of Array.from(this.selectionListeners)) listener(event);
  }

  emitLeases(event: SelectionRevisioned<readonly HostLeaseSnapshot[]>): void {
    for (const listener of Array.from(this.leaseListeners)) listener(event);
  }

  emitReattach(event: SelectionReattachRequired): void {
    for (const listener of Array.from(this.reattachListeners)) listener(event);
  }
}

// -------------------------------------------------------------------- tests

describe("BufferedSelectionAuthorityClient - buffer then replay", () => {
  it("buffers events delivered before attach resolves, drops those at/below the snapshot revision, and replays the rest interleaved in ascending revision order", async () => {
    const transport = new FakeTransport([5]);
    const client = new BufferedSelectionAuthorityClient(
      transport,
      silentAuthorityLog,
    );

    const attachPromise = client.attach(
      SELECTION_AUTHORITY_CONTRACT_VERSION,
      [],
    );

    const received: string[] = [];
    client.onSelectionChanged((event) =>
      received.push(`selection:${event.revision}`),
    );
    client.onLeasesChanged((event) =>
      received.push(`leases:${event.revision}`),
    );
    client.onReattachRequired((event) =>
      received.push(`reattach:${event.revision}`),
    );

    // Interleaved, out of order, all buffered because the instance has not
    // gone live yet.
    transport.emitLeases({ revision: 2, change: [] });
    transport.emitReattach({ revision: 4 });
    transport.emitSelection({ revision: 1, change: selectionChangeStub() });
    transport.emitSelection({ revision: 3, change: selectionChangeStub() });

    expect(received).toEqual([]);

    transport.resolveLastAttach({
      ok: true,
      incarnationId: "inc-1",
      snapshot: snapshotAt(2),
    });
    const result = await attachPromise;
    expect(result.ok).toBe(true);

    // revision <= 2 (leases:2, selection:1) dropped; the rest replayed ascending.
    expect(received).toEqual(["selection:3", "reattach:4"]);
  });

  it("after going live, an event at or below the high-water mark is dropped", async () => {
    const transport = new FakeTransport([1]);
    const client = new BufferedSelectionAuthorityClient(
      transport,
      silentAuthorityLog,
    );
    const attachPromise = client.attach(
      SELECTION_AUTHORITY_CONTRACT_VERSION,
      [],
    );
    transport.resolveLastAttach({
      ok: true,
      incarnationId: "inc-1",
      snapshot: snapshotAt(5),
    });
    await attachPromise;

    const received: number[] = [];
    client.onReattachRequired((event) => received.push(event.revision));

    transport.emitReattach({ revision: 5 });
    transport.emitReattach({ revision: 6 });

    expect(received).toEqual([6]);
  });
});

describe("BufferedSelectionAuthorityClient - failure arms dispose", () => {
  const failureCases: ReadonlyArray<{
    readonly name: string;
    readonly resolveWith: SelectionAttachResult | null;
  }> = [
    { name: "superseded", resolveWith: { ok: false, kind: "superseded" } },
    {
      name: "version-mismatch",
      resolveWith: {
        ok: false,
        kind: "version-mismatch",
        authorityVersion: SELECTION_AUTHORITY_CONTRACT_VERSION,
        callerVersion: 99,
      },
    },
    {
      name: "malformed-request",
      resolveWith: { ok: false, kind: "malformed-request", claimed: true },
    },
    { name: "transport rejection", resolveWith: null },
  ];

  for (const failureCase of failureCases) {
    it(`disposes on ${failureCase.name}: no further delivery, no reportEvidence transport call`, async () => {
      const transport = new FakeTransport([1]);
      const client = new BufferedSelectionAuthorityClient(
        transport,
        silentAuthorityLog,
      );
      const received: number[] = [];
      client.onSelectionChanged((event) => received.push(event.revision));

      const attachPromise = client.attach(
        SELECTION_AUTHORITY_CONTRACT_VERSION,
        [],
      );
      if (failureCase.resolveWith === null) {
        transport.rejectLastAttach(new Error("boom"));
      } else {
        transport.resolveLastAttach(failureCase.resolveWith);
      }
      const result = await attachPromise;
      expect(result.ok).toBe(false);
      expect(result).toEqual(
        failureCase.resolveWith ?? { ok: false, kind: "superseded" },
      );

      // The instance actually tore down its transport subscriptions (all
      // three: selection, leases, reattach) - not merely stuck buffering,
      // which would also produce zero delivery and zero reportEvidence
      // calls but leak the listeners.
      expect(transport.disposedSubscriptionCount).toBe(3);

      transport.emitSelection({ revision: 999, change: selectionChangeStub() });
      expect(received).toEqual([]);

      await client.reportEvidence(dialReportStub("H", "attempt-1"));
      expect(transport.reportEvidenceCalls.length).toBe(0);
    });
  }
});

describe("BufferedSelectionAuthorityClient - attach-once and seq guards", () => {
  it("a second attach() on the same instance answers superseded without a transport call", async () => {
    const transport = new FakeTransport([1]);
    const client = new BufferedSelectionAuthorityClient(
      transport,
      silentAuthorityLog,
    );
    const first = client.attach(SELECTION_AUTHORITY_CONTRACT_VERSION, []);
    transport.resolveLastAttach({
      ok: true,
      incarnationId: "inc-1",
      snapshot: snapshotAt(0),
    });
    await first;

    const attachCallsBefore = transport.attachRequests.length;
    const second = await client.attach(
      SELECTION_AUTHORITY_CONTRACT_VERSION,
      [],
    );
    expect(second).toEqual({ ok: false, kind: "superseded" });
    expect(transport.attachRequests.length).toBe(attachCallsBefore);
  });

  it("an instance whose allocateAttachSeq returned a negative seq answers superseded without calling the transport", async () => {
    const transport = new FakeTransport([-1]);
    const client = new BufferedSelectionAuthorityClient(
      transport,
      silentAuthorityLog,
    );
    const result = await client.attach(
      SELECTION_AUTHORITY_CONTRACT_VERSION,
      [],
    );
    expect(result).toEqual({ ok: false, kind: "superseded" });
    expect(transport.attachRequests.length).toBe(0);
  });
});

describe("BufferedSelectionAuthorityClient - incarnation stamping", () => {
  it("reportEvidence and activate stamp the incarnation from the attach result; a rejected reportEvidence resolves without throwing", async () => {
    const transport = new FakeTransport([1]);
    const client = new BufferedSelectionAuthorityClient(
      transport,
      silentAuthorityLog,
    );
    const attachPromise = client.attach(
      SELECTION_AUTHORITY_CONTRACT_VERSION,
      [],
    );
    transport.resolveLastAttach({
      ok: true,
      incarnationId: "inc-77",
      snapshot: snapshotAt(0),
    });
    await attachPromise;

    await client.reportEvidence(dialReportStub("H", "a1"));
    expect(transport.reportEvidenceCalls[0]?.incarnationId).toBe("inc-77");

    await client.activate("H");
    expect(transport.activateCalls[0]?.incarnationId).toBe("inc-77");

    transport.reportEvidenceImpl = () => Promise.reject(new Error("dropped"));
    await expect(
      client.reportEvidence(dialReportStub("H", "a2")),
    ).resolves.toBeUndefined();
  });
});

describe("RotatingSelectionAuthorityClient - rotation ordering", () => {
  it("builds the next instance (allocating its own seq) before notifying consumers, so the consumer's attach() lands on the new seq", async () => {
    const transports: FakeTransport[] = [];
    const seqQueues = [[1], [2]];
    let instanceIndex = 0;
    const createInstance = (): BufferedSelectionAuthorityClient => {
      const queue = seqQueues[instanceIndex];
      if (queue === undefined) throw new Error("ran out of seq queues");
      const transport = new FakeTransport(queue);
      transports.push(transport);
      instanceIndex += 1;
      return new BufferedSelectionAuthorityClient(
        transport,
        silentAuthorityLog,
      );
    };
    const rotating = new RotatingSelectionAuthorityClient(
      createInstance,
      silentAuthorityLog,
    );

    const firstTransport = transports[0];
    const firstAttach = rotating.attach(
      SELECTION_AUTHORITY_CONTRACT_VERSION,
      [],
    );
    firstTransport.resolveLastAttach({
      ok: true,
      incarnationId: "inc-1",
      snapshot: snapshotAt(0),
    });
    await firstAttach;

    let secondAttachPromise: Promise<SelectionAttachResult> | null = null;
    rotating.onReattachRequired(() => {
      secondAttachPromise = rotating.attach(
        SELECTION_AUTHORITY_CONTRACT_VERSION,
        [],
      );
    });

    firstTransport.emitReattach({ revision: 99 });

    expect(transports.length).toBe(2);
    const secondTransport = transports[1];
    expect(secondTransport.attachRequests.length).toBe(1);
    expect(secondTransport.attachRequests[0]?.attachSeq).toBe(2);

    secondTransport.resolveLastAttach({
      ok: true,
      incarnationId: "inc-2",
      snapshot: snapshotAt(0),
    });
    if (secondAttachPromise === null)
      throw new Error("expected the reattach handler to have fired");
    await secondAttachPromise;
  });

  it("listeners registered once on the rotating client keep receiving events after a rotation", async () => {
    const transports: FakeTransport[] = [];
    const seqQueues = [[1], [2]];
    let instanceIndex = 0;
    const createInstance = (): BufferedSelectionAuthorityClient => {
      const queue = seqQueues[instanceIndex];
      if (queue === undefined) throw new Error("ran out of seq queues");
      const transport = new FakeTransport(queue);
      transports.push(transport);
      instanceIndex += 1;
      return new BufferedSelectionAuthorityClient(
        transport,
        silentAuthorityLog,
      );
    };
    const rotating = new RotatingSelectionAuthorityClient(
      createInstance,
      silentAuthorityLog,
    );

    const firstTransport = transports[0];
    const firstAttach = rotating.attach(
      SELECTION_AUTHORITY_CONTRACT_VERSION,
      [],
    );
    firstTransport.resolveLastAttach({
      ok: true,
      incarnationId: "inc-1",
      snapshot: snapshotAt(0),
    });
    await firstAttach;

    const received: number[] = [];
    rotating.onLeasesChanged((event) => received.push(event.revision));

    let secondAttachPromise: Promise<SelectionAttachResult> | null = null;
    rotating.onReattachRequired(() => {
      secondAttachPromise = rotating.attach(
        SELECTION_AUTHORITY_CONTRACT_VERSION,
        [],
      );
    });

    firstTransport.emitReattach({ revision: 50 });
    const secondTransport = transports[1];
    secondTransport.resolveLastAttach({
      ok: true,
      incarnationId: "inc-2",
      snapshot: snapshotAt(0),
    });
    if (secondAttachPromise === null)
      throw new Error("expected the reattach handler to have fired");
    await secondAttachPromise;

    // Events from the FIRST (now-retired) instance must not reach the listener.
    firstTransport.emitLeases({ revision: 999, change: [] });
    expect(received).toEqual([]);

    secondTransport.emitLeases({ revision: 1, change: [] });
    expect(received).toEqual([1]);
  });
});

// --------------------------------------------------- P1.1 fixup round (cold
// review blockers B1-B6).

describe("BufferedSelectionAuthorityClient - B1: quiescent drain with a listener-injected event", () => {
  it("an event a listener injects mid-replay is delivered LAST, never interleaved ahead of the already-buffered batch", async () => {
    const transport = new FakeTransport([1]);
    const client = new BufferedSelectionAuthorityClient(
      transport,
      silentAuthorityLog,
    );
    const attachPromise = client.attach(
      SELECTION_AUTHORITY_CONTRACT_VERSION,
      [],
    );

    const received: string[] = [];
    let injected = false;
    client.onSelectionChanged((event) => {
      received.push(`selection:${event.revision}`);
      if (!injected) {
        injected = true;
        // Injected synchronously from inside delivery of the first buffered
        // event - a higher revision than everything else already queued.
        transport.emitLeases({ revision: 10, change: [] });
      }
    });
    client.onLeasesChanged((event) =>
      received.push(`leases:${event.revision}`),
    );

    transport.emitSelection({ revision: 1, change: selectionChangeStub() });
    transport.emitSelection({ revision: 2, change: selectionChangeStub() });

    transport.resolveLastAttach({
      ok: true,
      incarnationId: "inc-1",
      snapshot: snapshotAt(0),
    });
    await attachPromise;

    expect(received).toEqual(["selection:1", "selection:2", "leases:10"]);
  });
});

describe("BufferedSelectionAuthorityClient - B2/B3: deferred evidence while attach is in flight", () => {
  it("a session-established report queued mid-claim makes no transport call until attach resolves, then sends exactly once under the accepted incarnation", async () => {
    const transport = new FakeTransport([1]);
    const client = new BufferedSelectionAuthorityClient(
      transport,
      silentAuthorityLog,
    );
    const attachPromise = client.attach(
      SELECTION_AUTHORITY_CONTRACT_VERSION,
      [],
    );

    void client.reportEvidence(sessionReportStub("H", "s1", "established"));
    expect(transport.reportEvidenceCalls.length).toBe(0);

    transport.resolveLastAttach({
      ok: true,
      incarnationId: "inc-9",
      snapshot: snapshotAt(0),
    });
    await attachPromise;

    expect(transport.reportEvidenceCalls).toEqual([
      {
        incarnationId: "inc-9",
        report: sessionReportStub("H", "s1", "established"),
      },
    ]);
  });

  it("a session-lost report queued mid-claim (the phantom-liveness case) makes no transport call until attach resolves, then sends exactly once", async () => {
    const transport = new FakeTransport([1]);
    const client = new BufferedSelectionAuthorityClient(
      transport,
      silentAuthorityLog,
    );
    const attachPromise = client.attach(
      SELECTION_AUTHORITY_CONTRACT_VERSION,
      [],
    );

    void client.reportEvidence(sessionReportStub("H", "s1", "lost"));
    expect(transport.reportEvidenceCalls.length).toBe(0);

    transport.resolveLastAttach({
      ok: true,
      incarnationId: "inc-9",
      snapshot: snapshotAt(0),
    });
    await attachPromise;

    expect(transport.reportEvidenceCalls).toEqual([
      { incarnationId: "inc-9", report: sessionReportStub("H", "s1", "lost") },
    ]);
  });

  it("an established-then-lost pair queued mid-claim flushes in that order after attach resolves", async () => {
    const transport = new FakeTransport([1]);
    const client = new BufferedSelectionAuthorityClient(
      transport,
      silentAuthorityLog,
    );
    const attachPromise = client.attach(
      SELECTION_AUTHORITY_CONTRACT_VERSION,
      [],
    );

    void client.reportEvidence(sessionReportStub("H", "s1", "established"));
    void client.reportEvidence(sessionReportStub("H", "s1", "lost"));
    expect(transport.reportEvidenceCalls.length).toBe(0);

    transport.resolveLastAttach({
      ok: true,
      incarnationId: "inc-9",
      snapshot: snapshotAt(0),
    });
    await attachPromise;

    expect(transport.reportEvidenceCalls).toEqual([
      {
        incarnationId: "inc-9",
        report: sessionReportStub("H", "s1", "established"),
      },
      { incarnationId: "inc-9", report: sessionReportStub("H", "s1", "lost") },
    ]);
  });
});

describe("BufferedSelectionAuthorityClient - B4: the queue dies with its generation", () => {
  it("a report queued while attach is pending is never sent when the attach fails", async () => {
    const transport = new FakeTransport([1]);
    const client = new BufferedSelectionAuthorityClient(
      transport,
      silentAuthorityLog,
    );
    const attachPromise = client.attach(
      SELECTION_AUTHORITY_CONTRACT_VERSION,
      [],
    );
    void client.reportEvidence(sessionReportStub("H", "s1", "established"));

    transport.resolveLastAttach({ ok: false, kind: "superseded" });
    await attachPromise;

    expect(transport.reportEvidenceCalls.length).toBe(0);
  });

  it("a report queued while attach is pending is never sent when the instance is disposed before attach resolves", async () => {
    const transport = new FakeTransport([1]);
    const client = new BufferedSelectionAuthorityClient(
      transport,
      silentAuthorityLog,
    );
    const attachPromise = client.attach(
      SELECTION_AUTHORITY_CONTRACT_VERSION,
      [],
    );
    void client.reportEvidence(sessionReportStub("H", "s1", "established"));

    client.dispose();
    transport.resolveLastAttach({
      ok: true,
      incarnationId: "inc-9",
      snapshot: snapshotAt(0),
    });
    await attachPromise;

    expect(transport.reportEvidenceCalls.length).toBe(0);
  });
});

describe("RotatingSelectionAuthorityClient - B5/B6: a retired instance is never installed or propagated", () => {
  it("a reattachRequired replayed mid-install rotates before the consumer's attach promise settles: resolves superseded, instance #1 never goes live, instance #2 gets a fresh seq", async () => {
    const transports: FakeTransport[] = [];
    const seqQueues = [[1], [2]];
    let instanceIndex = 0;
    const instances: BufferedSelectionAuthorityClient[] = [];
    const createInstance = (): BufferedSelectionAuthorityClient => {
      const queue = seqQueues[instanceIndex];
      if (queue === undefined) throw new Error("ran out of seq queues");
      const transport = new FakeTransport(queue);
      transports.push(transport);
      instanceIndex += 1;
      const instance = new BufferedSelectionAuthorityClient(
        transport,
        silentAuthorityLog,
      );
      instances.push(instance);
      return instance;
    };
    const rotating = new RotatingSelectionAuthorityClient(
      createInstance,
      silentAuthorityLog,
    );
    const firstTransport = transports[0];
    const instanceOne = instances[0];
    if (instanceOne === undefined) throw new Error("expected instance #1");

    const consumerAttach = rotating.attach(
      SELECTION_AUTHORITY_CONTRACT_VERSION,
      [],
    );

    // A reattachRequired at R+1 is already buffered by the time attach resolves.
    firstTransport.emitReattach({ revision: 6 });

    const received: number[] = [];
    rotating.onLeasesChanged((event) => received.push(event.revision));

    let secondAttachPromise: Promise<SelectionAttachResult> | null = null;
    rotating.onReattachRequired(() => {
      secondAttachPromise = rotating.attach(
        SELECTION_AUTHORITY_CONTRACT_VERSION,
        [],
      );
    });

    // Resolving with snapshot revision 5 (< 6) makes install() replay the
    // buffered reattachRequired, which rotates and disposes instance #1
    // BEFORE the outer attach() call below ever settles.
    firstTransport.resolveLastAttach({
      ok: true,
      incarnationId: "inc-1",
      snapshot: snapshotAt(5),
    });
    const result = await consumerAttach;

    // The consumer's own attach() promise resolves superseded, never the
    // stale ok:true that landed on a generation this layer already rotated
    // away from.
    expect(result).toEqual({ ok: false, kind: "superseded" });

    expect(transports.length).toBe(2);
    if (secondAttachPromise === null)
      throw new Error("expected the reattach handler to have fired");
    const secondTransport = transports[1];
    expect(secondTransport.attachRequests[0]?.attachSeq).toBe(2);

    // Instance #1 never went live: a later event on its transport delivers
    // nothing through it.
    firstTransport.emitLeases({ revision: 999, change: [] });
    expect(received).toEqual([]);

    // ...and it is still DISPOSED, not merely unsubscribed. The distinction
    // is observable exactly here: a retired instance that had been flipped to
    // `live` would hold an installed incarnation and would still forward
    // evidence under it - the outgoing generation reporting as if it owned
    // the reporter. Dropped events alone cannot show that, because dispose
    // already tore down the transport subscriptions.
    await instanceOne.reportEvidence(dialReportStub("H", "after-retire"));
    expect(firstTransport.reportEvidenceCalls.length).toBe(0);

    secondTransport.resolveLastAttach({
      ok: true,
      incarnationId: "inc-2",
      snapshot: snapshotAt(0),
    });
    await secondAttachPromise;
  });
});
