import { describe, expect, it } from "vitest";
import type { SimulatorSummary } from "@traycer/protocol/host/simulator/schemas";
import type {
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
      ),
    ).toBe(BOOTED_EMULATOR);
    // Powered off: the host lists the AVD cold under its name.
    expect(
      findSimulatorForTile([IPHONE, COLD_AVD], serialTile, NO_SESSIONS),
    ).toBe(COLD_AVD);
    // Booted again elsewhere under a new serial: that row, to connect to.
    const rebooted = { ...BOOTED_EMULATOR, simulatorId: "emulator-5556" };
    expect(findSimulatorForTile([rebooted], serialTile, NO_SESSIONS)).toBe(
      rebooted,
    );
    expect(findSimulatorForTile([IPHONE], serialTile, NO_SESSIONS)).toBeNull();
  });

  it("never matches an iOS tile by name: a udid is for life", () => {
    const tile = {
      simulatorId: "udid-gone",
      platform: "ios",
      name: "iPhone 16",
    } as const;
    expect(findSimulatorForTile([IPHONE], tile, NO_SESSIONS)).toBeNull();
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
    expect(findSimulatorForTile([source], cloneTile, NO_SESSIONS)).toEqual({
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
      findSimulatorForTile([source], cloneTile, [
        personOnSource,
        agentOnTheSibling,
        agentOnTheClone,
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

  it("answers null when no session names this tile's serial, or the host lists no instance", () => {
    expect(
      findSimulatorForTile([source], cloneTile, [
        personOnSource,
        agentOnTheSibling,
      ]),
    ).toBeNull();
    expect(
      findSimulatorForTile([{ ...source, instances: [] }], cloneTile, [
        agentOnTheClone,
      ]),
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
    expect(findSimulatorForTile([cold], serialTile, [personOnSource])).toBe(
      cold,
    );
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
