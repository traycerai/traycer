import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SELECTION_AUTHORITY_CONTRACT_VERSION,
  type SelectionAuthorityClient,
  type SelectionChange,
  type SelectionRevisioned,
  type SelectionSubscription,
} from "@traycer-clients/shared/host-selection/selection-authority-contract";
import {
  CONFIRMED_DEATH_REFUSAL_STREAK,
  RETURN_TO_TARGET_STABILITY_MS,
  SelectionAuthorityEngineImpl,
  createIncrementingIncarnationIds,
  silentAuthorityLog,
} from "@traycer-clients/shared/host-selection/selection-authority-engine";
import { SelectionEvidenceKernel } from "@traycer-clients/shared/host-selection/selection-evidence-kernel";
import {
  InMemoryAuthorityIdentitySource,
  InMemoryHostFleetSource,
  InMemoryPreferredHostStore,
  createInProcessSelectionAuthorityClient,
  inertLocalHostOutageSignal,
} from "@traycer-clients/shared/host-selection/in-process-selection-authority";
import {
  createFakeAuthorityClock,
  type FakeAuthorityClock,
} from "@traycer-clients/shared/host-selection/__tests__/selection-authority-harness";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import {
  mountSelectionAuthorityBridge,
  type SelectionAuthorityBridge,
} from "@/lib/host/selection-authority-bridge";
import {
  subscribeFollowingSurfaceReset,
  type FollowingSurfaceResetListener,
} from "@/stores/host/surface-host-selection-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

/** Flushes the microtask queue enough times for the attach choreography to settle. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

/**
 * Records every `applyKernelSnapshot` push into the store (P4.2: the bridge's
 * only remaining write path, now that `directory.selectById` is gone), the
 * same way the deleted `RecordingDirectory` fixture recorded every
 * `selectById` call - one entry per `apply`, in order.
 */
function subscribeEffectiveHostIdPushes(): {
  readonly calls: Array<string | null>;
  readonly unsubscribe: () => void;
} {
  const calls: Array<string | null> = [];
  const unsubscribe = useSelectionAuthorityStore.subscribe((state) => {
    calls.push(state.effectiveHostId);
  });
  return { calls, unsubscribe };
}

const HOST_LABELS = {
  labelFor: (hostId: string): string => hostId,
};

interface TestAuthority {
  readonly engine: SelectionAuthorityEngineImpl;
  readonly fleet: InMemoryHostFleetSource;
  readonly identity: InMemoryAuthorityIdentitySource;
  readonly preferredStore: InMemoryPreferredHostStore;
  readonly client: SelectionAuthorityClient;
  readonly clock: FakeAuthorityClock;
  dispose(): void;
}

function buildAuthority(input: {
  readonly localHostId: string | null;
  readonly hosts: readonly { hostId: string; kind: "local" | "remote" }[];
  readonly identityKey: string;
  /** Pre-seed the preferred store BEFORE the engine reads it at construction. */
  readonly seedPreferred?: string | null;
}): TestAuthority {
  const preferredStore = new InMemoryPreferredHostStore();
  if (input.seedPreferred !== undefined) {
    preferredStore.save(input.identityKey, input.seedPreferred);
  }
  const fleet = new InMemoryHostFleetSource({
    revision: 0,
    identityGeneration: 0,
    localHostId: input.localHostId,
    hosts: input.hosts,
  });
  const identity = new InMemoryAuthorityIdentitySource(input.identityKey);
  const clock = createFakeAuthorityClock(0);
  const engine = new SelectionAuthorityEngineImpl({
    fleet,
    identity,
    // A PROVISIONABLE local host. The `unavailable` port models a machine
    // whose host cannot be started, and since P1.3's F3(b)/(c) rulings such a
    // host honestly reads `dead` as soon as the engine's own ensure comes back
    // unavailable (registry §5's ∅ definition made real). Every test below is
    // about what the BRIDGE does with a derivation, so leaving that port in
    // place would silently rewrite the derivation under each of them - the
    // window lands on ∅ or on the remote, and the bridge assertions end up
    // measuring the local host's provisionability instead of the seam.
    localHostEnsure: { ensureReady: () => Promise.resolve({ ok: true }) },
    localOutage: inertLocalHostOutageSignal,
    preferredStore,
    clock,
    newIncarnationId: createIncrementingIncarnationIds(),
    log: silentAuthorityLog,
  });
  const client = createInProcessSelectionAuthorityClient(
    engine,
    silentAuthorityLog,
  );
  return {
    engine,
    fleet,
    identity,
    preferredStore,
    client,
    clock,
    dispose: () => {
      client.dispose();
      engine.dispose();
    },
  };
}

async function startKernel(
  client: SelectionAuthorityClient,
): Promise<SelectionEvidenceKernel> {
  const kernel = new SelectionEvidenceKernel({
    client,
    now: () => 0,
    log: silentAuthorityLog,
  });
  await kernel.start();
  return kernel;
}

function mountBridge(input: {
  readonly client: SelectionAuthorityClient;
  readonly kernel: SelectionEvidenceKernel;
}): SelectionAuthorityBridge {
  return mountSelectionAuthorityBridge({
    client: input.client,
    kernel: input.kernel,
    hostLabels: HOST_LABELS,
  });
}

/** Feeds `CONFIRMED_DEATH_REFUSAL_STREAK` refusals from a second, synthetic window. */
function killHost(engine: SelectionAuthorityEngineImpl, hostId: string): void {
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
      hostId,
      attemptId: `kill-${i}`,
      outcome: "confirmed-refusal",
      refusalDetail: null,
      transportKind: "remote-relay",
      at: i,
    });
  }
}

/** Proves a dead host alive again from the same synthetic second window. */
function reviveHost(
  engine: SelectionAuthorityEngineImpl,
  hostId: string,
): void {
  const seq = engine.allocateAttachSeq("other-window");
  const attach = engine.attach("other-window", {
    attachSeq: seq,
    callerContractVersion: SELECTION_AUTHORITY_CONTRACT_VERSION,
    liveSessions: [],
  });
  if (!attach.ok) throw new Error("expected the synthetic window to re-attach");
  engine.ingestEvidence("other-window", attach.incarnationId, {
    kind: "dial",
    hostId,
    attemptId: "revive",
    outcome: "success",
    transportKind: "remote-relay",
    at: 0,
  });
}

beforeEach(() => {
  useSelectionAuthorityStore.getState().reset();
});

afterEach(() => {
  vi.restoreAllMocks();
  useSelectionAuthorityStore.getState().reset();
});

describe("mountSelectionAuthorityBridge", () => {
  it("(a) pushes a kernel snapshot's effectiveHostId into the store", async () => {
    const authority = buildAuthority({
      localHostId: "L",
      hosts: [{ hostId: "L", kind: "local" }],
      identityKey: "acct-1",
    });
    const kernel = await startKernel(authority.client);
    expect(kernel.snapshot().effectiveHostId).toBe("L");
    const pushes = subscribeEffectiveHostIdPushes();
    const bridge = mountBridge({
      client: authority.client,
      kernel,
    });

    // C2: kernel already started; the opening bind is subscribe-time
    // apply(kernel.snapshot()), not a later change event.
    expect(pushes.calls.length).toBe(1);
    expect(pushes.calls.at(-1)).toBe("L");
    expect(useSelectionAuthorityStore.getState().effectiveHostId).toBe("L");
    expect(useSelectionAuthorityStore.getState().attached).toBe(true);
    await flushMicrotasks();
    expect(pushes.calls.length).toBe(1);

    pushes.unsubscribe();
    bridge.dispose();
    kernel.dispose();
    authority.dispose();
  });

  it("(b) the attach's OWN snapshot carries an already-settled preference - no subsequent change event is needed", async () => {
    // The preference is seeded into the store BEFORE the engine is
    // constructed, the way a restart finds it already on disk (G1). Nothing
    // in this test ever calls `activate` or otherwise emits a NEW
    // selectionChanged event - the only thing that can move the store is
    // the bridge's own initial `apply(kernel.snapshot())` /
    // `kernel.start()` installing the attach's snapshot.
    const authority = buildAuthority({
      localHostId: "L",
      hosts: [
        { hostId: "L", kind: "local" },
        { hostId: "P", kind: "remote" },
      ],
      identityKey: "acct-1",
      seedPreferred: "P",
    });
    expect(authority.engine.snapshot().preferredHostId).toBe("P");
    const kernel = await startKernel(authority.client);
    expect(kernel.snapshot().effectiveHostId).toBe("P");
    const pushes = subscribeEffectiveHostIdPushes();
    const bridge = mountBridge({
      client: authority.client,
      kernel,
    });

    expect(pushes.calls.length).toBe(1);
    expect(pushes.calls.at(-1)).toBe("P");
    expect(useSelectionAuthorityStore.getState().effectiveHostId).toBe("P");
    await flushMicrotasks();
    expect(pushes.calls.length).toBe(1);

    pushes.unsubscribe();
    bridge.dispose();
    kernel.dispose();
    authority.dispose();
  });

  it("(c) fires HostFailover on a failover cause, HostRecovered on a recovery cause, and neither on activate/fleet-shift - the G4 hook fires on every effective change", async () => {
    const authority = buildAuthority({
      localHostId: "L",
      hosts: [
        { hostId: "L", kind: "local" },
        { hostId: "P", kind: "remote" },
      ],
      identityKey: "acct-1",
    });
    const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
    const g4Events: Array<{
      previousEffectiveHostId: string | null;
      nextEffectiveHostId: string | null;
    }> = [];
    const g4Listener: FollowingSurfaceResetListener = (event) => {
      g4Events.push(event);
    };
    const unsubscribeG4 = subscribeFollowingSurfaceReset(g4Listener);
    const kernel = await startKernel(authority.client);
    const bridge = mountBridge({
      client: authority.client,
      kernel,
    });
    await flushMicrotasks();
    // Settled on L (M5, no preference yet).
    expect(useSelectionAuthorityStore.getState().effectiveHostId).toBe("L");

    // cause: activate - moves effective from L to P. Neither analytics event
    // fires for it, but the G4 hook does (it fires on ANY effective change).
    const seqA = authority.engine.allocateAttachSeq("this-window-probe");
    // Use the bridge's OWN attached window to activate rather than a second
    // one, matching how Settings ▸ Activate really calls it: through the
    // SAME client this bridge wraps.
    void seqA; // not used directly; activate goes through the client below.
    expect(await authority.client.activate("P")).toEqual({ ok: true });
    await flushMicrotasks();
    expect(useSelectionAuthorityStore.getState().effectiveHostId).toBe("P");
    expect(g4Events.at(-1)).toEqual({
      previousEffectiveHostId: "L",
      nextEffectiveHostId: "P",
    });
    expect(trackSpy).not.toHaveBeenCalledWith(
      AnalyticsEvent.HostFailover,
      null,
    );
    expect(trackSpy).not.toHaveBeenCalledWith(
      AnalyticsEvent.HostRecovered,
      null,
    );

    // cause: failover - P (preferred, target) dies; effective moves off it
    // to L, which is NOT the target, so the engine's own resolveCause names
    // this "failover".
    killHost(authority.engine, "P");
    await flushMicrotasks();
    expect(useSelectionAuthorityStore.getState().effectiveHostId).toBe("L");
    expect(g4Events.at(-1)).toEqual({
      previousEffectiveHostId: "P",
      nextEffectiveHostId: "L",
    });
    expect(trackSpy).toHaveBeenCalledWith(AnalyticsEvent.HostFailover, null);
    expect(trackSpy).not.toHaveBeenCalledWith(
      AnalyticsEvent.HostRecovered,
      null,
    );

    // cause: recovery - P (still the target/preferred) proves alive again;
    // effective lands back ON the target, which the engine names "recovery".
    trackSpy.mockClear();
    reviveHost(authority.engine, "P");
    authority.clock.advance(RETURN_TO_TARGET_STABILITY_MS);
    await flushMicrotasks();
    expect(useSelectionAuthorityStore.getState().effectiveHostId).toBe("P");
    expect(g4Events.at(-1)).toEqual({
      previousEffectiveHostId: "L",
      nextEffectiveHostId: "P",
    });
    expect(trackSpy).toHaveBeenCalledWith(AnalyticsEvent.HostRecovered, null);
    expect(trackSpy).not.toHaveBeenCalledWith(
      AnalyticsEvent.HostFailover,
      null,
    );

    // cause: fleet-shift - a new, unrelated host joins the fleet. Effective
    // stays P throughout, so NEITHER analytics event fires and the G4 hook
    // gets no new entry.
    trackSpy.mockClear();
    const g4CountBeforeFleetShift = g4Events.length;
    authority.fleet.publish(0, "L", [
      { hostId: "L", kind: "local" },
      { hostId: "P", kind: "remote" },
      { hostId: "Q", kind: "remote" },
    ]);
    await flushMicrotasks();
    expect(useSelectionAuthorityStore.getState().effectiveHostId).toBe("P");
    expect(g4Events.length).toBe(g4CountBeforeFleetShift);
    expect(trackSpy).not.toHaveBeenCalled();

    unsubscribeG4();
    bridge.dispose();
    kernel.dispose();
    authority.dispose();
  });

  it("(d1) Suite D - F7: a G4 subscriber reading the store during its notification observes the NEW revision, and narration actually fires", async () => {
    // The mutation this pins: `applySelection` publishing a STALE
    // `selectionRevision` (the kernel's OWN pre-fixed value rather than the
    // incoming `revision`) makes `pending.revision > applied` permanently
    // true - narration would never flush AT ALL, silently, forever. A test
    // that only asserts "if narration fired, the state it saw was fresh"
    // passes vacuously against that mutation, because narration never fires
    // and the conditional body never runs. So this test asserts BOTH halves:
    // narration FIRED, and what it observed was already fresh.
    //
    // This used to also read `directory.calls.at(-1)` from inside the
    // notification, proving the store and the directory agreed. P4.2 deleted
    // the directory's write path - the store is now the only seam, so there
    // is nothing left to cross-check it against; the surviving claim is
    // narrower (store freshness alone).
    const authority = buildAuthority({
      localHostId: "L",
      hosts: [
        { hostId: "L", kind: "local" },
        { hostId: "P", kind: "remote" },
      ],
      identityKey: "acct-1",
    });
    const kernel = await startKernel(authority.client);
    const bridge = mountBridge({
      client: authority.client,
      kernel,
    });
    await flushMicrotasks();
    expect(useSelectionAuthorityStore.getState().effectiveHostId).toBe("L");

    // Land on P first (M5: no preference yet means target=local), the same
    // way test (c) does, so P is actually the target/preferred and killing
    // it is a real failover rather than a no-op on an unselected host.
    expect(await authority.client.activate("P")).toEqual({ ok: true });
    await flushMicrotasks();
    expect(useSelectionAuthorityStore.getState().effectiveHostId).toBe("P");

    let g4FireCount = 0;
    const observedAtNotification: Array<{
      storeEffectiveHostId: string | null;
    }> = [];
    const unsubscribeG4 = subscribeFollowingSurfaceReset(() => {
      g4FireCount += 1;
      // Read the seam from INSIDE the notification, the way a real G4
      // subscriber (following-surface reset) would - it must see the new
      // host, not a store that is still one tick behind.
      observedAtNotification.push({
        storeEffectiveHostId:
          useSelectionAuthorityStore.getState().effectiveHostId,
      });
    });

    // cause: failover - P (preferred, target) dies; effective moves back to L.
    killHost(authority.engine, "P");
    await flushMicrotasks();

    // The positive assertion the vacuity probe defeats if narration never
    // flushes: it must have fired, not merely be consistent IF it fired.
    expect(g4FireCount).toBeGreaterThanOrEqual(1);
    expect(useSelectionAuthorityStore.getState().effectiveHostId).toBe("L");
    for (const observed of observedAtNotification) {
      expect(observed.storeEffectiveHostId).toBe("L");
    }

    unsubscribeG4();
    bridge.dispose();
    kernel.dispose();
    authority.dispose();
  });

  it("(d) an event whose effectiveHostId equals its previousEffectiveHostId narrates nothing, even when its cause is failover/recovery", async () => {
    // A REAL engine cannot currently produce this shape: on every path that
    // tags a commit "failover" (ingestEvidence/attach/detach/local-outage/
    // the deadline timer), `effectiveHostId` is the only field of the
    // selection tuple those paths can move, so `selectionEquals` guarantees
    // any event they emit has ALREADY changed it - `stage()` never queues an
    // event otherwise. The CONTRACT still allows the shape (`SelectionChange`
    // has no invariant tying `cause` to whether `effectiveHostId` moved), and
    // this guard is what makes that legal-but-inert shape a no-op rather than
    // a misfired `HostFailover`/`HostRecovered`. Isolated at the same fake
    // `SelectionAuthorityClient` boundary as (e), for the same reason.
    const selectionListeners: Array<
      (event: SelectionRevisioned<SelectionChange>) => void
    > = [];
    const NO_SUB: SelectionSubscription = { dispose: () => undefined };
    const fakeClient: SelectionAuthorityClient = {
      attach: () =>
        Promise.resolve({
          ok: true,
          incarnationId: "inc-1",
          snapshot: {
            contractVersion: SELECTION_AUTHORITY_CONTRACT_VERSION,
            revision: 0,
            preferredHostId: null,
            targetHostId: null,
            effectiveHostId: null,
            leases: [],
          },
        }),
      reportEvidence: () => Promise.resolve(),
      activate: () => Promise.resolve({ ok: false, reason: "not-attached" }),
      onSelectionChanged: (listener) => {
        selectionListeners.push(listener);
        return NO_SUB;
      },
      onLeasesChanged: () => NO_SUB,
      onReattachRequired: () => NO_SUB,
    };
    const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
    const g4Events: unknown[] = [];
    const unsubscribeG4 = subscribeFollowingSurfaceReset((event) => {
      g4Events.push(event);
    });
    const kernel = await startKernel(fakeClient);
    const bridge = mountBridge({
      client: fakeClient,
      kernel,
    });
    expect(selectionListeners.length).toBeGreaterThanOrEqual(2);
    const emit = (event: SelectionRevisioned<SelectionChange>): void => {
      for (const listener of selectionListeners) listener(event);
    };

    // cause: failover, effective unchanged at null->null (targetHostId moved
    // to a preferred host that is itself unusable - ∅ throughout).
    emit({
      revision: 5,
      change: {
        preferredHostId: "H",
        targetHostId: "H",
        effectiveHostId: null,
        previousEffectiveHostId: null,
        cause: "failover",
      },
    });
    expect(g4Events.length).toBe(0);
    expect(trackSpy).not.toHaveBeenCalled();

    // cause: recovery, effective unchanged (already sitting on the target).
    emit({
      revision: 6,
      change: {
        preferredHostId: "H",
        targetHostId: "H",
        effectiveHostId: "H",
        previousEffectiveHostId: "H",
        cause: "recovery",
      },
    });
    expect(g4Events.length).toBe(0);
    expect(trackSpy).not.toHaveBeenCalled();

    unsubscribeG4();
    bridge.dispose();
    kernel.dispose();
  });

  it("(e) a replayed/stale revision narrates at most once", async () => {
    // Isolated at the SelectionAuthorityClient contract boundary: a real
    // engine never redelivers a revision, so the guard this pins
    // (`subscribeNarration`'s own monotonic high-water mark) can only be
    // exercised with a controllable fake transport. The bridge registers
    // TWO independent `onSelectionChanged` subscribers (the kernel itself,
    // and `subscribeNarration`), so every listener must be tracked and
    // invoked - narration's is not necessarily the last one registered.
    const selectionListeners: Array<
      (event: SelectionRevisioned<SelectionChange>) => void
    > = [];
    const NO_SUB: SelectionSubscription = { dispose: () => undefined };
    const fakeClient: SelectionAuthorityClient = {
      attach: () =>
        Promise.resolve({
          ok: true,
          incarnationId: "inc-1",
          snapshot: {
            contractVersion: SELECTION_AUTHORITY_CONTRACT_VERSION,
            revision: 0,
            preferredHostId: null,
            targetHostId: null,
            effectiveHostId: null,
            leases: [],
          },
        }),
      reportEvidence: () => Promise.resolve(),
      activate: () => Promise.resolve({ ok: false, reason: "not-attached" }),
      onSelectionChanged: (listener) => {
        selectionListeners.push(listener);
        return NO_SUB;
      },
      onLeasesChanged: () => NO_SUB,
      onReattachRequired: () => NO_SUB,
    };
    const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
    const g4Events: unknown[] = [];
    const unsubscribeG4 = subscribeFollowingSurfaceReset((event) => {
      g4Events.push(event);
    });
    const kernel = await startKernel(fakeClient);
    const bridge = mountBridge({
      client: fakeClient,
      kernel,
    });
    expect(selectionListeners.length).toBe(2);
    const change: SelectionChange = {
      preferredHostId: "H",
      targetHostId: "H",
      effectiveHostId: "H",
      previousEffectiveHostId: null,
      cause: "activate",
    };
    const emit = (event: SelectionRevisioned<SelectionChange>): void => {
      for (const listener of selectionListeners) listener(event);
    };
    emit({ revision: 5, change });
    expect(g4Events.length).toBe(1);
    // The SAME revision, replayed: must not narrate again.
    emit({ revision: 5, change });
    expect(g4Events.length).toBe(1);
    // A LOWER (stale/reordered) revision: must not narrate either.
    emit({ revision: 3, change });
    expect(g4Events.length).toBe(1);
    void trackSpy;

    unsubscribeG4();
    bridge.dispose();
    kernel.dispose();
  });

  it("(f) dispose unsubscribes and resets the store", async () => {
    const authority = buildAuthority({
      localHostId: "L",
      hosts: [{ hostId: "L", kind: "local" }],
      identityKey: "acct-1",
    });
    const pushes = subscribeEffectiveHostIdPushes();
    const kernel = await startKernel(authority.client);
    const bridge = mountBridge({
      client: authority.client,
      kernel,
    });
    await flushMicrotasks();
    expect(useSelectionAuthorityStore.getState().attached).toBe(true);

    bridge.dispose();
    expect(useSelectionAuthorityStore.getState().attached).toBe(false);
    expect(useSelectionAuthorityStore.getState().effectiveHostId).toBeNull();

    // Unsubscribed: further activity on the underlying authority must not
    // move the store again.
    const pushesAtDispose = pushes.calls.length;
    authority.fleet.publish(0, "L", [
      { hostId: "L", kind: "local" },
      { hostId: "M", kind: "remote" },
    ]);
    await flushMicrotasks();
    expect(pushes.calls.length).toBe(pushesAtDispose);
    expect(useSelectionAuthorityStore.getState().attached).toBe(false);

    pushes.unsubscribe();
    kernel.dispose();
    authority.dispose();
  });
});
