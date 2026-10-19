import { afterEach, describe, expect, it } from "vitest";
import type { SimulatorState } from "@traycer/protocol/host/simulator/schemas";
import {
  FakeStreamClient,
  type FakeStreamSession,
} from "@traycer-clients/shared/host-transport/__testing__/fake-stream-client";
import type { DurableStreamTransport } from "@/lib/host/durable-stream-transport";
import {
  acquireSimulatorSessionsCoordinator,
  applySimulatorStatePatch,
  hasSimulatorSessionsCoordinator,
  orderSimulators,
  resetSimulatorSessionsCoordinatorsForTests,
  SIMULATORS_UNSUPPORTED_MESSAGE,
  simulatorSessionsCoordinatorKey,
  simulatorSessionsCoordinatorState,
  subscribeToSimulatorSessionsCoordinator,
} from "../simulator-sessions-coordinator";

const HOST = "host-1";
const EPIC = "epic-1";
const KEY = simulatorSessionsCoordinatorKey({
  hostId: HOST,
  epicId: EPIC,
  identityKey: "owner-1",
});

const SNAPSHOT: SimulatorState = {
  revision: 3,
  hostId: HOST,
  platforms: [
    { platform: "ios", available: true, reason: null },
    { platform: "android", available: false, reason: "No Android SDK." },
  ],
  packState: { kind: "ready", reason: null, progress: null },
  hubState: { kind: "running", lastError: null },
  simulators: [
    {
      simulatorId: "udid-cold",
      platform: "ios",
      name: "iPhone 15",
      version: "17.5",
      booted: false,
      physical: false,
    },
    {
      simulatorId: "udid-hot",
      platform: "ios",
      name: "iPhone 16",
      version: "18.0",
      booted: true,
      physical: false,
    },
  ],
  sessions: [],
  booting: [],
};

function transportHarness(): {
  readonly openTransport: (hostId: string) => DurableStreamTransport;
  readonly clients: FakeStreamClient[];
  readonly closed: number[];
} {
  const clients: FakeStreamClient[] = [];
  const closed: number[] = [];
  return {
    clients,
    closed,
    openTransport: () => {
      const client = new FakeStreamClient(true);
      const index = clients.push(client) - 1;
      return {
        wsStreamClient: client,
        close: () => {
          closed.push(index);
          client.close();
        },
      };
    },
  };
}

function session(harness: {
  readonly clients: FakeStreamClient[];
}): FakeStreamSession {
  const stream = harness.clients.at(-1)?.sessions.at(-1);
  if (stream === undefined) throw new Error("no simulator.sessions stream");
  return stream;
}

afterEach(() => {
  resetSimulatorSessionsCoordinatorsForTests();
});

describe("applySimulatorStatePatch", () => {
  it("replaces only the fields the patch carries", () => {
    const next = applySimulatorStatePatch(SNAPSHOT, 4, {
      booting: ["udid-cold"],
    });
    expect(next.revision).toBe(4);
    expect(next.booting).toEqual(["udid-cold"]);
    expect(next.simulators).toBe(SNAPSHOT.simulators);
    expect(next.packState).toBe(SNAPSHOT.packState);
  });

  it("lists booted simulators first", () => {
    expect(
      orderSimulators(SNAPSHOT.simulators).map((s) => s.simulatorId),
    ).toEqual(["udid-hot", "udid-cold"]);
  });
});

describe("simulator sessions coordinator", () => {
  it("opens one stream per key, folds snapshot and patches, and shares it between consumers", () => {
    const harness = transportHarness();
    const releaseA = acquireSimulatorSessionsCoordinator({
      key: KEY,
      consumerId: Symbol("a"),
      hostId: HOST,
      epicId: EPIC,
      openTransport: harness.openTransport,
    });
    const releaseB = acquireSimulatorSessionsCoordinator({
      key: KEY,
      consumerId: Symbol("b"),
      hostId: HOST,
      epicId: EPIC,
      openTransport: harness.openTransport,
    });
    expect(harness.clients).toHaveLength(1);
    expect(harness.clients[0].subscribes).toEqual([
      { method: "simulator.sessions", params: { epicId: EPIC } },
    ]);
    expect(simulatorSessionsCoordinatorState(KEY)?.lifecycle).toBe("live");

    let notified = 0;
    const unsubscribe = subscribeToSimulatorSessionsCoordinator(KEY, () => {
      notified++;
    });
    session(harness).emit(
      { kind: "snapshot", hasBinaryPayload: false, state: SNAPSHOT },
      null,
    );
    expect(simulatorSessionsCoordinatorState(KEY)?.state).toEqual(SNAPSHOT);
    session(harness).emit(
      {
        kind: "stateChanged",
        hasBinaryPayload: false,
        revision: 4,
        patch: { booting: ["udid-cold"] },
      },
      null,
    );
    // An older revision that arrives late changes nothing.
    session(harness).emit(
      {
        kind: "stateChanged",
        hasBinaryPayload: false,
        revision: 2,
        patch: { booting: [] },
      },
      null,
    );
    const state = simulatorSessionsCoordinatorState(KEY)?.state;
    expect(state?.revision).toBe(4);
    expect(state?.booting).toEqual(["udid-cold"]);
    expect(state?.simulators).toEqual(SNAPSHOT.simulators);
    expect(notified).toBe(2);

    simulatorSessionsCoordinatorState(KEY)?.refresh();
    expect(session(harness).framesOfKind("refresh")).toHaveLength(1);

    unsubscribe();
    releaseA();
    expect(hasSimulatorSessionsCoordinator(KEY)).toBe(true);
    releaseB();
    expect(hasSimulatorSessionsCoordinator(KEY)).toBe(false);
    expect(harness.closed).toEqual([0]);
    expect(session(harness).closed).toBe(true);
  });

  it("reads an INCOMPATIBLE close for the method as a host that cannot show simulators", () => {
    const harness = transportHarness();
    const release = acquireSimulatorSessionsCoordinator({
      key: KEY,
      consumerId: Symbol("a"),
      hostId: HOST,
      epicId: EPIC,
      openTransport: harness.openTransport,
    });
    const stream = session(harness);
    stream.emitStatus("closed");
    // `emitStatus` carries no reason: a plain close reads as closed.
    expect(simulatorSessionsCoordinatorState(KEY)?.lifecycle).toBe("closed");

    simulatorSessionsCoordinatorState(KEY)?.retry();
    expect(harness.clients).toHaveLength(2);
    expect(harness.closed).toEqual([0]);
    expect(simulatorSessionsCoordinatorState(KEY)?.lifecycle).toBe("live");

    session(harness).emitFatal("bearer expired");
    expect(simulatorSessionsCoordinatorState(KEY)).toMatchObject({
      lifecycle: "failed",
      errorMessage: "bearer expired",
    });
    expect(SIMULATORS_UNSUPPORTED_MESSAGE).toMatch(/update/);
    release();
  });
});
