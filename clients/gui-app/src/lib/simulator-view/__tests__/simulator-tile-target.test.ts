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

describe("findSimulatorForTile", () => {
  it("matches by id first, and an Android serial's tile by AVD name once the serial is gone", () => {
    const serialTile = {
      simulatorId: "emulator-5554",
      platform: "android",
      name: "Pixel_8_API_35",
    } as const;
    expect(findSimulatorForTile([COLD_AVD, BOOTED_EMULATOR], serialTile)).toBe(
      BOOTED_EMULATOR,
    );
    // Powered off: the host lists the AVD cold under its name.
    expect(findSimulatorForTile([IPHONE, COLD_AVD], serialTile)).toBe(COLD_AVD);
    // Booted again elsewhere under a new serial: that row, to connect to.
    const rebooted = { ...BOOTED_EMULATOR, simulatorId: "emulator-5556" };
    expect(findSimulatorForTile([rebooted], serialTile)).toBe(rebooted);
    expect(findSimulatorForTile([IPHONE], serialTile)).toBeNull();
  });

  it("never matches an iOS tile by name: a udid is for life", () => {
    const tile = {
      simulatorId: "udid-gone",
      platform: "ios",
      name: "iPhone 16",
    } as const;
    expect(findSimulatorForTile([IPHONE], tile)).toBeNull();
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
    expect(findSimulatorForTile([source], cloneTile)).toEqual({
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
      findSimulatorForTile([{ ...source, instances: [] }], cloneTile),
    ).toBeNull();
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
