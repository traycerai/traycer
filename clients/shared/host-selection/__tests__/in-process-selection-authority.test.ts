import { describe, expect, it } from "vitest";
import {
  createIncrementingIncarnationIds,
  silentAuthorityLog,
  SelectionAuthorityEngineImpl,
} from "../selection-authority-engine";
import {
  InMemoryAuthorityIdentitySource,
  InMemoryHostFleetSource,
  InMemoryPreferredHostStore,
  createInProcessSelectionAuthorityClient,
  inertLocalHostOutageSignal,
  unavailableLocalHostEnsurePort,
} from "../in-process-selection-authority";
import {
  createFakeAuthorityClock,
  fleetHost,
  findLease,
} from "./selection-authority-harness";
import {
  type HostLeaseSnapshot,
  type SelectionAttachResult,
  type SelectionRevisioned,
} from "../selection-authority-contract";

describe("in-process selection authority - end to end over a real engine", () => {
  it("attach yields a snapshot; evidence reaches the client via a leases event; a second client from the same adapter supersedes the first", async () => {
    const clock = createFakeAuthorityClock(0);
    const fleet = new InMemoryHostFleetSource({
      revision: 0,
      identityGeneration: 0,
      localHostId: null,
      hosts: [fleetHost("H", "remote")],
    });
    const identity = new InMemoryAuthorityIdentitySource("acct-1");
    const engine = new SelectionAuthorityEngineImpl({
      fleet,
      identity,
      localHostEnsure: unavailableLocalHostEnsurePort,
      localOutage: inertLocalHostOutageSignal,
      preferredStore: new InMemoryPreferredHostStore(),
      clock,
      newIncarnationId: createIncrementingIncarnationIds(),
      log: silentAuthorityLog,
    });

    // The in-process adapter uses ONE constant reporter id: a second client
    // built over the same engine acts as a fresh load replacing the first.
    const clientA = createInProcessSelectionAuthorityClient(
      engine,
      silentAuthorityLog,
    );
    const attachA = await clientA.attach(1, []);
    expect(attachA.ok).toBe(true);

    const leaseEvents: Array<
      SelectionRevisioned<readonly HostLeaseSnapshot[]>
    > = [];
    clientA.onLeasesChanged((event) => leaseEvents.push(event));

    await clientA.reportEvidence({
      kind: "session",
      hostId: "H",
      sessionId: "s1",
      transition: "established",
      transportKind: "local-ws",
      at: 0,
    });
    expect(leaseEvents.length).toBeGreaterThan(0);
    expect(
      findLease(leaseEvents[leaseEvents.length - 1].change, "H")?.status,
    ).toBe("ready");

    // A second client instance, same constant reporter id: supersedes clientA.
    const clientB = createInProcessSelectionAuthorityClient(
      engine,
      silentAuthorityLog,
    );
    const attachB = await clientB.attach(1, []);
    expect(attachB.ok).toBe(true);

    const staleReport = clientA.reportEvidence({
      kind: "dial",
      hostId: "H",
      attemptId: "after-supersede",
      outcome: "success",
      transportKind: "local-ws",
      at: 0,
    });
    await expect(staleReport).resolves.toBeUndefined();

    engine.dispose();
  });

  it("an identity transition rotates the client and a re-attach yields a fresh incarnation", async () => {
    const clock = createFakeAuthorityClock(0);
    const fleet = new InMemoryHostFleetSource({
      revision: 0,
      identityGeneration: 0,
      localHostId: null,
      hosts: [],
    });
    const identity = new InMemoryAuthorityIdentitySource("acct-A");
    const engine = new SelectionAuthorityEngineImpl({
      fleet,
      identity,
      localHostEnsure: unavailableLocalHostEnsurePort,
      localOutage: inertLocalHostOutageSignal,
      preferredStore: new InMemoryPreferredHostStore(),
      clock,
      newIncarnationId: createIncrementingIncarnationIds(),
      log: silentAuthorityLog,
    });
    const client = createInProcessSelectionAuthorityClient(
      engine,
      silentAuthorityLog,
    );
    const firstAttach = await client.attach(1, []);
    if (!firstAttach.ok)
      throw new Error("expected the first attach to succeed");

    const pendingReattach: { promise: Promise<SelectionAttachResult> | null } =
      {
        promise: null,
      };
    client.onReattachRequired(() => {
      pendingReattach.promise = client.attach(1, []);
    });

    identity.set("acct-B");

    const reattachPromise = pendingReattach.promise;
    if (reattachPromise === null) {
      throw new Error(
        "expected reattachRequired to fire the client's re-attach",
      );
    }
    const secondAttach = await reattachPromise;
    if (!secondAttach.ok)
      throw new Error("expected the second attach to succeed");
    expect(secondAttach.incarnationId).not.toBe(firstAttach.incarnationId);

    engine.dispose();
  });
});

describe("InMemoryHostFleetSource / InMemoryAuthorityIdentitySource", () => {
  it("publish increments the revision monotonically and hands the new snapshot to listeners", () => {
    const source = new InMemoryHostFleetSource({
      revision: 0,
      identityGeneration: 0,
      localHostId: null,
      hosts: [],
    });
    const received: number[] = [];
    source.onChanged((snapshot) => received.push(snapshot.revision));

    source.publish(0, "L", [fleetHost("L", "local")]);
    source.publish(0, "L", [fleetHost("L", "local"), fleetHost("H", "remote")]);

    expect(received).toEqual([1, 2]);
    expect(source.snapshot().revision).toBe(2);
    expect(source.snapshot().hosts.map((entry) => entry.hostId)).toEqual([
      "L",
      "H",
    ]);
  });

  it("set increments the identity generation and hands the new identity to listeners", () => {
    const source = new InMemoryAuthorityIdentitySource("acct-1");
    expect(source.current()).toEqual({ identityKey: "acct-1", generation: 0 });

    const received: Array<{ identityKey: string | null; generation: number }> =
      [];
    source.onChanged((identity) => received.push(identity));

    source.set("acct-2");
    source.set(null);

    expect(received).toEqual([
      { identityKey: "acct-2", generation: 1 },
      { identityKey: null, generation: 2 },
    ]);
    expect(source.current()).toEqual({ identityKey: null, generation: 2 });
  });
});
