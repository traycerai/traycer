/**
 * Shared test harness for the P1.1 selection-authority suite (engine +
 * in-process adapter). A fake {@link AuthorityClock} that only advances when
 * told to, plus small recorders so ordering/revision assertions read as plain
 * data instead of ad-hoc listener wiring in every test.
 */
import {
  type HostFleetEntry,
  type HostLeaseSnapshot,
  type LocalHostEnsurePort,
  type SelectionAuthorityEngine,
  type SelectionChange,
  type SelectionReattachRequired,
  type SelectionRevisioned,
  type SelectionSubscription,
} from "../selection-authority-contract";
import {
  createIncrementingIncarnationIds,
  silentAuthorityLog,
  SelectionAuthorityEngineImpl,
  type AuthorityClock,
  type PreferredHostStore,
} from "../selection-authority-engine";
import {
  InMemoryAuthorityIdentitySource,
  InMemoryHostFleetSource,
  InMemoryPreferredHostStore,
  inertLocalHostOutageSignal,
  unavailableLocalHostEnsurePort,
} from "../in-process-selection-authority";

/** A recorded timer, keyed by an id private to the fake clock. */
interface FakeTimer {
  readonly deadline: number;
  readonly run: () => void;
}

/** {@link AuthorityClock} plus test-only controls over its fake time. */
export interface FakeAuthorityClock extends AuthorityClock {
  advance(ms: number): void;
  pendingTimerCount(): number;
}

/**
 * `advance` moves `now` then fires every timer whose deadline has passed, in
 * deadline order, looping until a pass fires nothing - a fired callback may
 * itself re-arm a timer whose new deadline is already due (delay 0 relative
 * to the moved clock), and that must fire in the same `advance` call.
 */
export function createFakeAuthorityClock(startAt: number): FakeAuthorityClock {
  let current = startAt;
  let nextId = 0;
  const timers = new Map<number, FakeTimer>();

  function schedule(delayMs: number, run: () => void): () => void {
    const id = nextId;
    nextId += 1;
    timers.set(id, { deadline: current + delayMs, run });
    return () => {
      timers.delete(id);
    };
  }

  function fireDue(): void {
    let progressed = true;
    while (progressed) {
      progressed = false;
      const due = Array.from(timers.entries())
        .filter(([, timer]) => timer.deadline <= current)
        .sort((left, right) => left[1].deadline - right[1].deadline);
      for (const [id, timer] of due) {
        if (!timers.has(id)) continue;
        timers.delete(id);
        progressed = true;
        timer.run();
      }
    }
  }

  return {
    now: () => current,
    schedule,
    advance: (ms: number) => {
      current += ms;
      fireDue();
    },
    pendingTimerCount: () => timers.size,
  };
}

/** One emitted event, flattened for ordering/revision assertions. */
export type RecordedEngineEvent =
  | {
      readonly kind: "selection";
      readonly revision: number;
      readonly change: SelectionChange;
    }
  | {
      readonly kind: "leases";
      readonly revision: number;
      readonly leases: readonly HostLeaseSnapshot[];
    }
  | { readonly kind: "reattach"; readonly revision: number };

/** Subscribes to all three engine event kinds and records them in delivery order. */
export function recordEngineEvents(engine: SelectionAuthorityEngine): {
  readonly events: RecordedEngineEvent[];
  readonly subscriptions: readonly SelectionSubscription[];
} {
  const events: RecordedEngineEvent[] = [];
  const subscriptions: SelectionSubscription[] = [
    engine.onSelectionChanged((event: SelectionRevisioned<SelectionChange>) => {
      events.push({
        kind: "selection",
        revision: event.revision,
        change: event.change,
      });
    }),
    engine.onLeasesChanged(
      (event: SelectionRevisioned<readonly HostLeaseSnapshot[]>) => {
        events.push({
          kind: "leases",
          revision: event.revision,
          leases: event.change,
        });
      },
    ),
    engine.onReattachRequired((event: SelectionReattachRequired) => {
      events.push({ kind: "reattach", revision: event.revision });
    }),
  ];
  return { events, subscriptions };
}

/** Everything one engine test needs, wired to a fake clock and in-memory ports. */
export interface TestAuthority {
  readonly engine: SelectionAuthorityEngineImpl;
  readonly fleet: InMemoryHostFleetSource;
  readonly identity: InMemoryAuthorityIdentitySource;
  readonly preferredStore: PreferredHostStore;
  readonly clock: FakeAuthorityClock;
  readonly events: RecordedEngineEvent[];
  dispose(): void;
}

/**
 * Builds a fresh engine over in-memory ports and a fake clock, with an event
 * recorder already attached. `initialFleet`/`initialIdentityKey` seed the
 * ports the engine reads synchronously at construction (module header
 * "subscribe before read").
 */
export function createTestAuthority(input: {
  readonly initialFleet: {
    readonly identityGeneration: number;
    readonly localHostId: string | null;
    readonly hosts: readonly HostFleetEntry[];
  };
  readonly initialIdentityKey: string | null;
  readonly clock: FakeAuthorityClock;
  readonly localHostEnsure?: LocalHostEnsurePort;
  readonly preferredStore?: PreferredHostStore;
  readonly seedPreferred?: string | null;
}): TestAuthority {
  const fleet = new InMemoryHostFleetSource({
    revision: 0,
    identityGeneration: input.initialFleet.identityGeneration,
    localHostId: input.initialFleet.localHostId,
    hosts: input.initialFleet.hosts,
  });
  const identity = new InMemoryAuthorityIdentitySource(
    input.initialIdentityKey,
  );
  const preferredStore =
    input.preferredStore ?? new InMemoryPreferredHostStore();
  const seedPreferred = input.seedPreferred;
  if (seedPreferred !== undefined && seedPreferred !== null) {
    preferredStore.save(input.initialIdentityKey, seedPreferred);
  }
  const engine = new SelectionAuthorityEngineImpl({
    fleet,
    identity,
    localHostEnsure: input.localHostEnsure ?? unavailableLocalHostEnsurePort,
    localOutage: inertLocalHostOutageSignal,
    preferredStore,
    clock: input.clock,
    newIncarnationId: createIncrementingIncarnationIds(),
    log: silentAuthorityLog,
  });
  const { events, subscriptions } = recordEngineEvents(engine);
  return {
    engine,
    fleet,
    identity,
    preferredStore,
    clock: input.clock,
    events,
    dispose: () => {
      for (const subscription of subscriptions) subscription.dispose();
      engine.dispose();
    },
  };
}

/** A `HostFleetEntry` builder for readable test setup. */
export function fleetHost(
  hostId: string,
  kind: "local" | "remote",
): HostFleetEntry {
  return { hostId, kind };
}

/** Finds a host's lease in a leases array the way tests want to assert on it. */
export function findLease(
  leases: readonly HostLeaseSnapshot[],
  hostId: string,
): HostLeaseSnapshot | undefined {
  return leases.find((lease) => lease.hostId === hostId);
}
