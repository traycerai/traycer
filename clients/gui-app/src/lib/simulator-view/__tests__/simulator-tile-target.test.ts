import { describe, expect, it } from "vitest";
import type { SimulatorSummary } from "@traycer/protocol/host/simulator/schemas";
import type {
  SimulatorHostInstance,
  SimulatorSession,
  SimulatorState,
} from "@traycer/protocol/host/simulator/schemas";
import {
  findSessionFor,
  findSimulatorForTile,
} from "@/lib/simulator-view/simulator-tile-target";

const COLD_AVD: SimulatorSummary = {
  simulatorId: "Pixel_8_API_35",
  platform: "android",
  name: "Pixel_8_API_35",
  version: "Android",
  booted: false,
  physical: false,
};
const BOOTED_EMULATOR: SimulatorSummary = {
  simulatorId: "emulator-5554",
  platform: "android",
  name: "Pixel_8_API_35",
  version: "Android 15.0",
  booted: true,
  physical: false,
};
const IPHONE: SimulatorSummary = {
  simulatorId: "udid-1",
  platform: "ios",
  name: "iPhone 16",
  version: "18.0",
  booted: false,
  physical: false,
};
/** A `@1.0` host, or a `@1.1` one with nothing open on this machine. */
const NO_SESSIONS: readonly SimulatorSession[] = [];
/** A host-wide read that has ANSWERED with nothing booted; `null` is one still owed. */
const NO_INSTANCES: readonly SimulatorHostInstance[] = [];

describe("findSimulatorForTile", () => {
  it("matches by id first, and an Android serial's tile by AVD name once the serial is gone", () => {
    const serialTile = {
      simulatorId: "emulator-5554",
      platform: "android",
      name: "Pixel_8_API_35",
    } as const;
    expect(
      findSimulatorForTile(
        [COLD_AVD, BOOTED_EMULATOR],
        serialTile,
        NO_SESSIONS,
        NO_INSTANCES,
      ),
    ).toBe(BOOTED_EMULATOR);
    // Powered off: the host lists the AVD cold under its name.
    expect(
      findSimulatorForTile(
        [IPHONE, COLD_AVD],
        serialTile,
        NO_SESSIONS,
        NO_INSTANCES,
      ),
    ).toBe(COLD_AVD);
    // Booted again elsewhere under a new serial: that row, to connect to.
    const rebooted = { ...BOOTED_EMULATOR, simulatorId: "emulator-5556" };
    expect(
      findSimulatorForTile([rebooted], serialTile, NO_SESSIONS, NO_INSTANCES),
    ).toBe(rebooted);
    expect(
      findSimulatorForTile([IPHONE], serialTile, NO_SESSIONS, NO_INSTANCES),
    ).toBeNull();
  });

  it("never matches an iOS tile by name: a udid is for life", () => {
    const tile = {
      simulatorId: "udid-gone",
      platform: "ios",
      name: "iPhone 16",
    } as const;
    expect(
      findSimulatorForTile([IPHONE], tile, NO_SESSIONS, NO_INSTANCES),
    ).toBeNull();
  });
});

describe("findSimulatorForTile on a @1.1 host", () => {
  const source: SimulatorSummary = {
    ...IPHONE,
    booted: true,
    instances: [
      {
        instanceKey: "udid-1",
        name: "iPhone 16",
        booted: true,
        cloneOf: null,
        drivenByAgent: false,
        keepRunning: false,
        idleUntil: null,
      },
      {
        instanceKey: "udid-clone",
        name: "iPhone 16 · 2",
        booted: true,
        cloneOf: "udid-1",
        drivenByAgent: true,
        keepRunning: false,
        idleUntil: null,
      },
    ],
  };
  const cloneTile = {
    simulatorId: "udid-clone",
    platform: "ios",
    name: "iPhone 16 · 2",
  } as const;

  it("finds a clone's tile under its source's instances, with the source's version", () => {
    // A clone is never listed as a device on @1.1, so only `instances` has it.
    expect(
      findSimulatorForTile([source], cloneTile, NO_SESSIONS, NO_INSTANCES),
    ).toEqual({
      simulatorId: "udid-clone",
      platform: "ios",
      name: "iPhone 16 · 2",
      version: "18.0",
      booted: true,
      physical: false,
    });
  });

  it("answers null for a clone the host no longer lists", () => {
    expect(
      findSimulatorForTile(
        [{ ...source, instances: [] }],
        cloneTile,
        NO_SESSIONS,
        NO_INSTANCES,
      ),
    ).toBeNull();
  });
});

describe("findSimulatorForTile for an Android clone on a @1.1 host", () => {
  const OWN_INSTANCE = {
    instanceKey: "Pixel_8_API_35",
    name: "Pixel_8_API_35",
    booted: true,
    cloneOf: null,
    drivenByAgent: false,
    keepRunning: false,
    idleUntil: null,
  } as const;
  /**
   * The host keys an Android instance by its AVD name and lists the device
   * under the serial its emulator runs on, so a clone's key and the serial
   * its own tile carries are different strings - and one source's clones all
   * differ from one another only by key.
   */
  const source: SimulatorSummary = {
    ...BOOTED_EMULATOR,
    instances: [
      OWN_INSTANCE,
      {
        ...OWN_INSTANCE,
        instanceKey: "Pixel_8_API_35_traycer_2",
        name: "Pixel_8_API_35 · 2",
        cloneOf: OWN_INSTANCE.instanceKey,
        drivenByAgent: true,
      },
      {
        ...OWN_INSTANCE,
        instanceKey: "Pixel_8_API_35_traycer_3",
        name: "Pixel_8_API_35 · 3",
        cloneOf: OWN_INSTANCE.instanceKey,
        drivenByAgent: true,
      },
    ],
  };
  const cloneTile = {
    simulatorId: "emulator-5558",
    platform: "android",
    name: "Pixel_8_API_35 · 3",
  } as const;
  const base = {
    epicId: "epic-1",
    ownerUserId: "user-1",
    hostId: "host-1",
    platform: "android",
    openedAt: "2026-10-18T00:00:00.000Z",
    agentId: "agent-1",
  } as const;
  const agentOnTheClone: SimulatorSession = {
    ...base,
    sessionId: "session-agent-3",
    simulatorId: cloneTile.simulatorId,
    instanceKey: "Pixel_8_API_35_traycer_3",
  };
  const agentOnTheSibling: SimulatorSession = {
    ...base,
    sessionId: "session-agent-2",
    simulatorId: "emulator-5556",
    instanceKey: "Pixel_8_API_35_traycer_2",
  };
  const personOnSource: SimulatorSession = {
    ...base,
    sessionId: "session-person",
    simulatorId: BOOTED_EMULATOR.simulatorId,
    instanceKey: OWN_INSTANCE.instanceKey,
    agentId: null,
  };

  it("takes the instance the tile's own serial is named with, through the sessions", () => {
    // Only a session ties the AVD-name key to the serial the tile holds, and
    // an agent's counts: it is the host's mapping, not a hold on the device.
    // The sibling clone's session names its own serial, never this one's.
    expect(
      findSimulatorForTile(
        [source],
        cloneTile,
        [personOnSource, agentOnTheSibling, agentOnTheClone],
        NO_INSTANCES,
      ),
    ).toEqual({
      simulatorId: cloneTile.simulatorId,
      platform: "android",
      name: "Pixel_8_API_35 · 3",
      version: "Android 15.0",
      booted: true,
      physical: false,
    });
  });

  it("answers null when no session names this tile's serial, or the host lists no instance", () => {
    expect(
      findSimulatorForTile(
        [source],
        cloneTile,
        [personOnSource, agentOnTheSibling],
        NO_INSTANCES,
      ),
    ).toBeNull();
    expect(
      findSimulatorForTile(
        [{ ...source, instances: [] }],
        cloneTile,
        [agentOnTheClone],
        NO_INSTANCES,
      ),
    ).toBeNull();
  });

  it("still boots a cold AVD by name for a root device's serial tile", () => {
    // A root device always has a row of its own - cold under its AVD name
    // once its emulator has exited - so its instance is never synthesised:
    // that would offer the dead serial to boot instead of the AVD.
    const cold: SimulatorSummary = {
      ...COLD_AVD,
      instances: [{ ...OWN_INSTANCE, booted: false }],
    };
    const serialTile = {
      simulatorId: BOOTED_EMULATOR.simulatorId,
      platform: "android",
      name: "Pixel_8_API_35",
    } as const;
    expect(
      findSimulatorForTile([cold], serialTile, [personOnSource], NO_INSTANCES),
    ).toBe(cold);
  });

  /**
   * The host's own host-wide read of what is booted. It carries no epic and no
   * session, and it names the id each instance is reached by NOW beside that
   * instance's AVD-name key - the pair a session used to be the only place to
   * find. `tasks` is empty here because the clone's last session has ended;
   * `keepRunning` is what keeps it booted with none.
   */
  const cloneRunningHostWide: SimulatorHostInstance = {
    ...OWN_INSTANCE,
    instanceKey: "Pixel_8_API_35_traycer_3",
    name: "Pixel_8_API_35 · 3",
    cloneOf: OWN_INSTANCE.instanceKey,
    keepRunning: true,
    simulatorId: cloneTile.simulatorId,
    platform: "android",
    version: "Android 15.0",
    cloneOfName: "Pixel_8_API_35",
    bootedByTraycer: true,
    tasks: [],
    otherTaskCount: 0,
  };

  it("resolves a still-booted clone host-wide once its last session has ended", () => {
    // The last session on the clone ended in another window, so nothing in
    // `sessions` ties its key to this tile's serial any more - and the clone
    // is still booted, kept running or waiting out its idle deadline. The
    // host-wide read names that serial, so the tile can still reconnect.
    expect(
      findSimulatorForTile([source], cloneTile, NO_SESSIONS, [
        cloneRunningHostWide,
      ]),
    ).toEqual({
      simulatorId: cloneTile.simulatorId,
      platform: "android",
      name: "Pixel_8_API_35 · 3",
      version: "Android 15.0",
      booted: true,
      physical: false,
    });
  });

  it("takes only the instance reached by this tile's own serial", () => {
    // A sibling clone of the same source runs on a serial of its own, so a
    // host-wide read that lists it says nothing about this tile.
    expect(
      findSimulatorForTile([source], cloneTile, NO_SESSIONS, [
        {
          ...cloneRunningHostWide,
          instanceKey: "Pixel_8_API_35_traycer_2",
          name: "Pixel_8_API_35 · 2",
          simulatorId: "emulator-5556",
        },
      ]),
    ).toBeNull();
  });

  it("decides nothing for a clone's tile named after its source while the host-wide read is owed", () => {
    // Boot another on the source device names the clone's tile after THAT
    // device, so the AVD name the fallback matches is the source's own row.
    // Until the host-wide read answers, no read in hand tells that tile from
    // the source device's own - and answering with the device would boot it
    // and attach the clone's tile to its session.
    const tileNamedAfterSource = {
      simulatorId: "emulator-5558",
      platform: "android",
      name: BOOTED_EMULATOR.name,
    } as const;
    expect(
      findSimulatorForTile([source], tileNamedAfterSource, NO_SESSIONS, null),
    ).toBeNull();
    // Answered, and nothing names this serial: the AVD name decides again,
    // which is what a root device's own stale-serial tile wants.
    expect(
      findSimulatorForTile(
        [source],
        tileNamedAfterSource,
        NO_SESSIONS,
        NO_INSTANCES,
      ),
    ).toBe(source);
  });

  it("never synthesises a root device from the host-wide read either", () => {
    // The two reads are two moments: a device booted since the cached
    // `simulator.list` is listed host-wide under its serial while that list
    // still has it cold. The cold row is the one to boot again, so the AVD
    // name still decides - the same rule the sessions path follows.
    const cold: SimulatorSummary = {
      ...COLD_AVD,
      instances: [{ ...OWN_INSTANCE, booted: false }],
    };
    const serialTile = {
      simulatorId: BOOTED_EMULATOR.simulatorId,
      platform: "android",
      name: "Pixel_8_API_35",
    } as const;
    expect(
      findSimulatorForTile([cold], serialTile, NO_SESSIONS, [
        {
          ...cloneRunningHostWide,
          instanceKey: OWN_INSTANCE.instanceKey,
          name: OWN_INSTANCE.name,
          cloneOf: null,
          cloneOfName: null,
          simulatorId: serialTile.simulatorId,
        },
      ]),
    ).toBe(cold);
  });
});

describe("findSessionFor", () => {
  const base: SimulatorSession = {
    epicId: "epic-1",
    ownerUserId: "user-1",
    hostId: "host-1",
    simulatorId: "udid-1",
    platform: "ios",
    openedAt: "2026-10-18T00:00:00.000Z",
  };
  const person: SimulatorSession = {
    ...base,
    sessionId: "session-person",
    agentId: null,
  };
  const agent: SimulatorSession = {
    ...base,
    sessionId: "session-agent",
    agentId: "agent-1",
  };
  const teammate: SimulatorSession = {
    ...person,
    sessionId: "session-teammate",
    ownerUserId: "user-2",
  };
  const clonePerson: SimulatorSession = {
    ...person,
    sessionId: "session-clone",
    simulatorId: "udid-clone",
  };

  function stateWith(sessions: readonly SimulatorSession[]): SimulatorState {
    return {
      revision: 1,
      hostId: "host-1",
      platforms: [],
      packState: { kind: "ready", reason: null, progress: null },
      hubState: { kind: "running", lastError: null },
      simulators: [],
      sessions: [...sessions],
      booting: [],
    };
  }

  it("takes only the viewer's own person session on a @1.1 host", () => {
    const state = stateWith([agent, teammate, person]);
    expect(findSessionFor(state, "udid-1", true, "user-1")).toBe(person);
    expect(
      findSessionFor(stateWith([agent, teammate]), "udid-1", true, "user-1"),
    ).toBeNull();
  });

  it("keeps a teammate's own clone session after the agent's session left the stream", () => {
    // The agent held the device; the teammate's open got a clone of their own.
    const before = stateWith([agent, clonePerson]);
    const after = stateWith([clonePerson]);
    expect(findSessionFor(before, "udid-clone", true, "user-1")).toBe(
      clonePerson,
    );
    expect(findSessionFor(after, "udid-clone", true, "user-1")).toBe(
      clonePerson,
    );
    // The agent's close took nothing from the viewer's own session.
    expect(findSessionFor(after, "udid-1", true, "user-1")).toBeNull();
  });

  it("takes any session the task holds on a @1.0 host", () => {
    expect(findSessionFor(stateWith([agent]), "udid-1", false, null)).toBe(
      agent,
    );
  });
});
