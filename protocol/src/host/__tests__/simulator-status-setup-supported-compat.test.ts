import { describe, expect, it } from "vitest";
import { upgradeResponseToVersion } from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  simulatorListV10,
  simulatorListV11,
  simulatorStatusV10,
  simulatorStatusV11,
} from "@traycer/protocol/host/simulator/contracts";
import {
  simulatorSessionsV10,
  simulatorSessionsV11,
} from "@traycer/protocol/host/simulator/stream-contracts";

/**
 * `setupSupported` entered the platform row after `simulator.status@1.0`,
 * `simulator.list@1.0/1.1` and `simulator.sessions@1.0/1.1` were released:
 * those lines are frozen on the three-key row and strip it, and only
 * `simulator.status@1.1` carries it. A released host or client therefore sees
 * exactly the shape it shipped with, and an upgrade from 1.0 manufactures no
 * `true`.
 */

const ENRICHED_ROW = {
  platform: "android" as const,
  available: false,
  reason: "No Android SDK.",
  setupSupported: true,
};
const RELEASED_ROW = {
  platform: "android" as const,
  available: false,
  reason: "No Android SDK.",
};
const PACK = { kind: "off" as const, reason: null, progress: null };
const HUB = { kind: "stopped" as const, lastError: null };

const STATE = {
  revision: 1,
  hostId: "host-1",
  platforms: [ENRICHED_ROW],
  packState: PACK,
  hubState: HUB,
  simulators: [],
  sessions: [],
  booting: [],
};

const STATUS = {
  platforms: [ENRICHED_ROW],
  packState: PACK,
  packVersion: null,
  installed: null,
};

describe("simulator.status", () => {
  it("1.0 answers the released three-key row and strips setupSupported", () => {
    const parsed = simulatorStatusV10.responseSchema.parse(STATUS);
    expect(parsed.platforms).toEqual([RELEASED_ROW]);
    expect(Object.keys(parsed.platforms[0] ?? {}).sort()).toEqual([
      "available",
      "platform",
      "reason",
    ]);
  });

  it("1.1 retains the flag, and a row without it stays valid", () => {
    expect(simulatorStatusV11.responseSchema.parse(STATUS).platforms).toEqual([
      ENRICHED_ROW,
    ]);
    expect(
      simulatorStatusV11.responseSchema.parse({
        ...STATUS,
        platforms: [RELEASED_ROW],
      }).platforms,
    ).toEqual([RELEASED_ROW]);
  });

  it("is registered as 1.0 then 1.1, and the 1.0 → 1.1 upgrade leaves a missing flag missing", () => {
    const entry = hostRpcRegistry["simulator.status"][1];
    expect(entry.latestMinor).toBe(1);
    const upgraded = upgradeResponseToVersion(
      hostRpcRegistry["simulator.status"],
      { major: 1, minor: 0 },
      { major: 1, minor: 1 },
      simulatorStatusV10.responseSchema.parse(STATUS),
    );
    expect(upgraded.platforms).toEqual([RELEASED_ROW]);
    expect(upgraded.platforms[0]?.setupSupported).toBeUndefined();
  });
});

describe("frozen released platform rows", () => {
  it("simulator.list 1.0 and 1.1 strip setupSupported", () => {
    for (const contract of [simulatorListV10, simulatorListV11]) {
      const parsed = contract.responseSchema.parse(STATE);
      expect(parsed.platforms).toEqual([RELEASED_ROW]);
    }
  });

  it("simulator.sessions 1.0 and 1.1 strip it from the snapshot state and the stateChanged patch", () => {
    for (const contract of [simulatorSessionsV10, simulatorSessionsV11]) {
      const snapshot = contract.serverFrameSchema.parse({
        kind: "snapshot",
        hasBinaryPayload: false,
        state: STATE,
      });
      if (snapshot.kind !== "snapshot") throw new Error("expected a snapshot");
      expect(snapshot.state.platforms).toEqual([RELEASED_ROW]);

      const changed = contract.serverFrameSchema.parse({
        kind: "stateChanged",
        hasBinaryPayload: false,
        revision: 2,
        patch: { platforms: [ENRICHED_ROW] },
      });
      if (changed.kind !== "stateChanged") {
        throw new Error("expected a stateChanged frame");
      }
      expect(changed.patch.platforms).toEqual([RELEASED_ROW]);
    }
  });
});
