import { describe, expect, it } from "vitest";
import {
  SELECTION_AUTHORITY_CONTRACT_VERSION,
  type HostLeaseSnapshot,
} from "../selection-authority-contract";
import {
  CONFIRMED_DEATH_REFUSAL_STREAK,
  RESTART_INTENT_EPISODE_MS,
  SelectionAuthorityEngineImpl,
  createIncrementingIncarnationIds,
  silentAuthorityLog,
} from "../selection-authority-engine";
import { SelectionEvidenceKernel } from "../selection-evidence-kernel";
import { TransportEvidenceRelay } from "../transport-evidence";
import type { RotatingSelectionAuthorityClient } from "../buffered-selection-authority-client";
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
  type FakeAuthorityClock,
} from "./selection-authority-harness";

/**
 * Composition class, and it has to be.
 * Every piece here is individually correct: the relay forwards, the kernel keeps an atomic attach inventory, the engine suppresses death while a session is live.
 */

const HOST_ID = "R";

interface Fixture {
  readonly engine: SelectionAuthorityEngineImpl;
  readonly relay: TransportEvidenceRelay;
  readonly clock: FakeAuthorityClock;
  readonly fleet: InMemoryHostFleetSource;
  readonly identity: InMemoryAuthorityIdentitySource;
  /** A fresh client + kernel, as a renderer load would build them. */
  newKernel(): {
    readonly kernel: SelectionEvidenceKernel;
    readonly client: RotatingSelectionAuthorityClient;
  };
  dispose(): void;
}

function buildFixture(): Fixture {
  const clock = createFakeAuthorityClock(0);
  const fleet = new InMemoryHostFleetSource({
    revision: 0,
    identityGeneration: 0,
    localHostId: null,
    hosts: [{ hostId: HOST_ID, kind: "remote" }],
  });
  const identity = new InMemoryAuthorityIdentitySource("acct-1");
  const engine = new SelectionAuthorityEngineImpl({
    // No local host in the fleet: this is about a remote pooled session, and a local host would drag D14's ensure machinery into a test that is not about provisioning.
    fleet,
    identity,
    localHostEnsure: unavailableLocalHostEnsurePort,
    localOutage: inertLocalHostOutageSignal,
    preferredStore: new InMemoryPreferredHostStore(),
    clock,
    newIncarnationId: createIncrementingIncarnationIds(),
    log: silentAuthorityLog,
  });
  const clients: RotatingSelectionAuthorityClient[] = [];
  const kernels: SelectionEvidenceKernel[] = [];
  return {
    engine,
    relay: new TransportEvidenceRelay(),
    clock,
    fleet,
    identity,
    newKernel: () => {
      const client = createInProcessSelectionAuthorityClient(
        engine,
        silentAuthorityLog,
      );
      const kernel = new SelectionEvidenceKernel({
        client,
        now: () => clock.now(),
        log: silentAuthorityLog,
      });
      clients.push(client);
      kernels.push(kernel);
      return { kernel, client };
    },
    dispose: () => {
      for (const kernel of kernels) kernel.dispose();
      for (const client of clients) client.dispose();
      engine.dispose();
    },
  };
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
}

function killHost(engine: SelectionAuthorityEngineImpl): void {
  const seq = engine.allocateAttachSeq("other-window");
  const attach = engine.attach("other-window", {
    attachSeq: seq,
    callerContractVersion: SELECTION_AUTHORITY_CONTRACT_VERSION,
    liveSessions: [],
  });
  if (!attach.ok) throw new Error("expected the synthetic window to attach");
  for (let i = 0; i < CONFIRMED_DEATH_REFUSAL_STREAK; i += 1) {
    engine.ingestEvidence("other-window", attach.incarnationId, {
      kind: "dial",
      hostId: HOST_ID,
      attemptId: `kill-${i}`,
      outcome: "confirmed-refusal",
      refusalDetail: null,
      transportKind: "remote-relay",
      at: i,
    });
  }
}

function leaseFor(engine: SelectionAuthorityEngineImpl): HostLeaseSnapshot {
  const lease = engine
    .snapshot()
    .leases.find((entry) => entry.hostId === HOST_ID);
  if (lease === undefined) throw new Error(`expected a lease for ${HOST_ID}`);
  return lease;
}

describe("TransportEvidenceRelay - inventory replay across a kernel replacement", () => {
  it("carries a live session into the REPLACEMENT kernel's attach inventory, so refusals cannot kill a host that is answering", async () => {
    const fixture = buildFixture();
    const first = fixture.newKernel();
    fixture.relay.bind(first.kernel);
    await first.kernel.start();

    // A pooled session announces exactly once, here.
    fixture.relay.sessionEstablished(HOST_ID, "s1", "remote-relay");
    await settle();
    expect(leaseFor(fixture.engine).status).toBe("ready");

    // The renderer reloads: a new client, a new kernel.
    // The pooled socket is untouched and will never announce itself again, so everything the engine is about to believe comes from what the relay replays.
    const second = fixture.newKernel();
    fixture.relay.bind(second.kernel);
    await second.kernel.start();
    await settle();

    killHost(fixture.engine);
    await settle();

    // The property.
    expect(leaseFor(fixture.engine).status).toBe("ready");

    fixture.dispose();
  });

  it("NEGATIVE: a session lost while UNBOUND is never replayed as live - phantom liveness is worse than the absence this fixes", async () => {
    const fixture = buildFixture();
    const first = fixture.newKernel();
    const release = fixture.relay.bind(first.kernel);
    await first.kernel.start();

    fixture.relay.sessionEstablished(HOST_ID, "s1", "remote-relay");
    await settle();
    expect(leaseFor(fixture.engine).status).toBe("ready");

    // The window tears down, and the socket dies during the gap.
    release();
    fixture.relay.sessionLost(HOST_ID, "s1", "remote-relay");

    const second = fixture.newKernel();
    fixture.relay.bind(second.kernel);
    await second.kernel.start();
    await settle();

    killHost(fixture.engine);
    await settle();

    // A phantom session would suppress the death counter for this host forever - the engine would never be able to declare it dead again.
    // The fix must carry what is live, not what once was.
    expect(leaseFor(fixture.engine).status).toBe("dead");

    fixture.dispose();
  });

  it("carries a restart tombstone observed while UNBOUND - the window a remount opens is exactly when a restart is invisible", async () => {
    const fixture = buildFixture();

    // No kernel bound: a host-runtime remount or an account switch.
    // The host announces it is going down deliberately, and before this fix the report hit a `?.` and vanished.
    fixture.relay.reportRestartIntent(HOST_ID, "tomb-1", null);

    const kernel = fixture.newKernel();
    fixture.relay.bind(kernel.kernel);
    await kernel.kernel.start();
    await settle();

    expect(leaseFor(fixture.engine).status).toBe("restarting-expected");

    // The hold is what the tombstone is for: the refusals that follow a deliberate restart must not fail the window off a host that is coming back.
    killHost(fixture.engine);
    await settle();
    expect(leaseFor(fixture.engine).status).toBe("restarting-expected");

    fixture.dispose();
  });

  it("NEGATIVE: a host that came back before the bind is not held restarting - the retention is cleared by its own proof of life", async () => {
    const fixture = buildFixture();

    fixture.relay.reportRestartIntent(HOST_ID, "tomb-1", null);
    // ...and then, still unbound, the host comes back.
    // The condition the tombstone announced is over, and replaying it would hold a healthy host out of selection for a full episode.
    fixture.relay.sessionEstablished(HOST_ID, "s1", "remote-relay");

    const kernel = fixture.newKernel();
    fixture.relay.bind(kernel.kernel);
    await kernel.kernel.start();
    await settle();

    expect(leaseFor(fixture.engine).status).toBe("ready");

    fixture.dispose();
  });

  it("CONSUMED: the relay hands a retained tombstone over ONCE - a later bind does not re-open a settled episode", async () => {
    const fixture = buildFixture();
    fixture.relay.reportRestartIntent(HOST_ID, "tomb-1", null);

    const first = fixture.newKernel();
    const release = fixture.relay.bind(first.kernel);
    await first.kernel.start();
    await settle();
    expect(leaseFor(fixture.engine).status).toBe("restarting-expected");

    fixture.clock.advance(RESTART_INTENT_EPISODE_MS + 1);
    expect(leaseFor(fixture.engine).status).not.toBe("restarting-expected");

    // The engine's `(hostId, tombstoneId)` dedup is what normally makes a second delivery inert - but it is pruned when a host leaves the fleet, so it cannot be relied on to bound our own re-announcement.
    // That is why the relay consumes rather than trusting the consumer.
    release();
    fixture.fleet.publish(0, null, []);
    fixture.fleet.publish(0, null, [{ hostId: HOST_ID, kind: "remote" }]);

    const second = fixture.newKernel();
    fixture.relay.bind(second.kernel);
    await second.kernel.start();
    await settle();

    expect(leaseFor(fixture.engine).status).not.toBe("restarting-expected");

    fixture.dispose();
  });

  it("CONSUMED: the kernel flushes a retained tombstone ONCE - a re-attach does not resurrect it for the incoming identity", async () => {
    const fixture = buildFixture();
    const kernel = fixture.newKernel();
    fixture.relay.bind(kernel.kernel);
    fixture.relay.reportRestartIntent(HOST_ID, "tomb-1", null);

    await kernel.kernel.start();
    await settle();
    expect(leaseFor(fixture.engine).status).toBe("restarting-expected");

    fixture.clock.advance(RESTART_INTENT_EPISODE_MS + 1);
    expect(leaseFor(fixture.engine).status).not.toBe("restarting-expected");

    // An identity transition wipes the engine's seen-tombstone ids and rotates the client, so the kernel re-attaches.
    fixture.identity.set("acct-2");
    // The incoming identity needs its own fleet, or the engine adopts the empty one and there is no lease to read at all - a transition detail, not the property under test.
    fixture.fleet.publish(1, null, [{ hostId: HOST_ID, kind: "remote" }]);
    await settle();

    expect(leaseFor(fixture.engine).status).not.toBe("restarting-expected");

    fixture.dispose();
  });

  it("NEGATIVE: the KERNEL's retention is cleared by proof of life too - bound but not yet attached, a returning host flushes nothing", async () => {
    const fixture = buildFixture();
    const kernel = fixture.newKernel();
    // Bound, so the relay forwards immediately rather than retaining - and not yet started, which is the window the kernel's own retention exists for.
    // This is the arm the relay-side negative cannot reach: there, both reports land in the relay's map and the kernel is never involved.
    fixture.relay.bind(kernel.kernel);

    fixture.relay.reportRestartIntent(HOST_ID, "tomb-1", null);
    fixture.relay.sessionEstablished(HOST_ID, "s1", "remote-relay");

    await kernel.kernel.start();
    await settle();

    // Both holders apply the same rule, so neither can hold a host the other knows is back.
    // Without the kernel's half, the flush would fire straight after the attach and hold a healthy host out of selection for a full episode.
    expect(leaseFor(fixture.engine).status).toBe("ready");

    fixture.dispose();
  });

  it("NEGATIVE: replaying a tombstoneId the engine has already seen opens no second episode", async () => {
    const fixture = buildFixture();
    const first = fixture.newKernel();
    const release = fixture.relay.bind(first.kernel);
    await first.kernel.start();

    fixture.relay.reportRestartIntent(HOST_ID, "tomb-1", null);
    await settle();
    expect(leaseFor(fixture.engine).status).toBe("restarting-expected");

    // The same tombstone observed again during an unbound window - another
    // transport on the same connection, a reconnect replay.
    release();
    fixture.relay.reportRestartIntent(HOST_ID, "tomb-1", null);

    // The original episode lapses on the engine's own ceiling.
    fixture.clock.advance(RESTART_INTENT_EPISODE_MS + 1);
    expect(leaseFor(fixture.engine).status).not.toBe("restarting-expected");

    const second = fixture.newKernel();
    fixture.relay.bind(second.kernel);
    await second.kernel.start();
    await settle();

    // A duplicate can never re-open or extend an episode (mechanism 7).
    expect(leaseFor(fixture.engine).status).not.toBe("restarting-expected");

    fixture.dispose();
  });
});

describe("TransportEvidenceRelay - currentSessionIdFor (P5.2 T6-T8)", () => {
  it("T6/P5: sessionEstablished names the session for its host; an unknown host answers null", () => {
    const relay = new TransportEvidenceRelay();
    expect(relay.currentSessionIdFor(HOST_ID)).toBeNull();

    relay.sessionEstablished(HOST_ID, "s1", "remote-relay");
    expect(relay.currentSessionIdFor(HOST_ID)).toBe("s1");
    expect(relay.currentSessionIdFor("unknown-host")).toBeNull();
  });

  it("T7/P6a: sessionLost clears the name it matches", () => {
    const relay = new TransportEvidenceRelay();
    relay.sessionEstablished(HOST_ID, "s1", "remote-relay");
    expect(relay.currentSessionIdFor(HOST_ID)).toBe("s1");

    relay.sessionLost(HOST_ID, "s1", "remote-relay");
    expect(relay.currentSessionIdFor(HOST_ID)).toBeNull();
  });

  it("T8/P6b: a late sessionLost for a REPLACED session must not clear the newer one", () => {
    const relay = new TransportEvidenceRelay();
    relay.sessionEstablished(HOST_ID, "s1", "remote-relay");
    relay.sessionEstablished(HOST_ID, "s2", "remote-relay");
    expect(relay.currentSessionIdFor(HOST_ID)).toBe("s2");

    // s1's teardown arrives after s2 is already up - the ordinary shape of a
    // seamless reconnect. It must be cleared only by its own id.
    relay.sessionLost(HOST_ID, "s1", "remote-relay");
    expect(relay.currentSessionIdFor(HOST_ID)).toBe("s2");
  });

  it("T9: the NEWEST session leaving falls back to a surviving older one - the per-RPC unary episode must not blank the stream's name", () => {
    // The unary transport opens a fresh socket per RPC and announces one session per connectivity episode, so non-overlapping RPCs open and close an episode each.
    const relay = new TransportEvidenceRelay();
    relay.sessionEstablished(HOST_ID, "stream:s1", "local-ws");
    relay.sessionEstablished(HOST_ID, "rpc:s7", "local-ws");
    expect(relay.currentSessionIdFor(HOST_ID)).toBe("rpc:s7");

    relay.sessionLost(HOST_ID, "rpc:s7", "local-ws");
    // Not null: the stream session is still live and is now the name.
    expect(relay.currentSessionIdFor(HOST_ID)).toBe("stream:s1");

    // And when that goes too, the name is genuinely gone.
    relay.sessionLost(HOST_ID, "stream:s1", "local-ws");
    expect(relay.currentSessionIdFor(HOST_ID)).toBeNull();
  });
});
