import { describe, expect, it } from "vitest";
import { upgradeRequestToVersion } from "@traycer/protocol/framework/versioned-rpc";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  configSimulatorGetUpgradeV10ToV11,
  configSimulatorGetV10,
  configSimulatorGetV11,
  configSimulatorSetUpgradeV10ToV11,
  configSimulatorSetV10,
  configSimulatorSetV11,
  simulatorCatalogReadV10,
  simulatorCloseUpgradeV10ToV11,
  simulatorCloseV10,
  simulatorCloseV11,
  simulatorInstancesV10,
  simulatorListUpgradeV10ToV11,
  simulatorListV10,
  simulatorListV11,
  simulatorOpenUpgradeV10ToV11,
  simulatorOpenV10,
  simulatorOpenV11,
  simulatorPowerOffV10,
  simulatorRemoveToolsV10,
  simulatorScreenshotV10,
  simulatorSetKeepRunningV10,
  simulatorShutdownV10,
  simulatorStatusV10,
} from "@traycer/protocol/host/simulator/contracts";
import {
  simulatorActionV10,
  simulatorDetailV10,
} from "@traycer/protocol/host/simulator/actions";

const V10 = { major: 1, minor: 0 } as const;
const V11 = { major: 1, minor: 1 } as const;

const UNCHANGED_METHODS = {
  "simulator.shutdown": simulatorShutdownV10,
  "simulator.screenshot": simulatorScreenshotV10,
  "simulator.status": simulatorStatusV10,
  "simulator.removeTools": simulatorRemoveToolsV10,
  "simulator.detail": simulatorDetailV10,
  "simulator.action": simulatorActionV10,
} as const;

const NEW_METHODS = {
  "simulator.instances": simulatorInstancesV10,
  "simulator.powerOff": simulatorPowerOffV10,
  "simulator.setKeepRunning": simulatorSetKeepRunningV10,
  "simulator.catalog.read": simulatorCatalogReadV10,
} as const;

const NEW_V11_ENTRIES = [
  {
    method: "simulator.list",
    entry: hostRpcRegistry["simulator.list"],
    v10: simulatorListV10,
    v11: simulatorListV11,
    upgrade: simulatorListUpgradeV10ToV11,
  },
  {
    method: "simulator.open",
    entry: hostRpcRegistry["simulator.open"],
    v10: simulatorOpenV10,
    v11: simulatorOpenV11,
    upgrade: simulatorOpenUpgradeV10ToV11,
  },
  {
    method: "simulator.close",
    entry: hostRpcRegistry["simulator.close"],
    v10: simulatorCloseV10,
    v11: simulatorCloseV11,
    upgrade: simulatorCloseUpgradeV10ToV11,
  },
  {
    method: "config.simulator.get",
    entry: hostRpcRegistry["config.simulator.get"],
    v10: configSimulatorGetV10,
    v11: configSimulatorGetV11,
    upgrade: configSimulatorGetUpgradeV10ToV11,
  },
  {
    method: "config.simulator.set",
    entry: hostRpcRegistry["config.simulator.set"],
    v10: configSimulatorSetV10,
    v11: configSimulatorSetV11,
    upgrade: configSimulatorSetUpgradeV10ToV11,
  },
] as const;

/**
 * The simulator verbs are optional capabilities: `degrade: { kind:
 * "unsupported" }` and never on the released floor, so a host that predates
 * the domain (or cannot run a simulator) reports the method as missing
 * rather than answering for it.
 */
describe("simulator contracts", () => {
  it("keeps the verbs that did not grow at v1.0", () => {
    for (const [method, contract] of Object.entries(UNCHANGED_METHODS)) {
      const entry = hostRpcRegistry[method as keyof typeof UNCHANGED_METHODS];
      expect(entry.degrade).toEqual({ kind: "unsupported" });
      expect(entry[1].latestMinor).toBe(0);
      expect(entry[1].versions[0].contract).toBe(contract);
      expect(entry[1].versions[0].upgradeFromPreviousVersion).toBeNull();
      expect(entry[1].downgradePathsFromLatest).toEqual({});
    }
  });

  it("opens a 1.1 minor on the five verbs that grew, with the 1.0 contract kept", () => {
    for (const { method, entry, v10, v11, upgrade } of NEW_V11_ENTRIES) {
      expect(entry.degrade, method).toEqual({ kind: "unsupported" });
      expect(entry[1].latestMinor, method).toBe(1);
      expect(entry[1].versions[0].contract, method).toBe(v10);
      expect(entry[1].versions[0].upgradeFromPreviousVersion, method).toBeNull();
      expect(entry[1].versions[1].contract, method).toBe(v11);
      expect(entry[1].versions[1].upgradeFromPreviousVersion, method).toBe(
        upgrade,
      );
      expect(entry[1].downgradePathsFromLatest, method).toEqual({});
    }
  });

  it("registers the four new verbs at v1.0 as optional capabilities", () => {
    for (const [method, contract] of Object.entries(NEW_METHODS)) {
      const entry = hostRpcRegistry[method as keyof typeof NEW_METHODS];
      expect(entry.degrade).toEqual({ kind: "unsupported" });
      expect(entry[1].latestMinor).toBe(0);
      expect(entry[1].versions[0].contract).toBe(contract);
      expect(entry[1].versions[0].upgradeFromPreviousVersion).toBeNull();
      expect(entry[1].downgradePathsFromLatest).toEqual({});
    }
  });

  it("keeps every simulator verb off the released floor", () => {
    const methods = [
      ...Object.keys(UNCHANGED_METHODS),
      ...Object.keys(NEW_METHODS),
      ...NEW_V11_ENTRIES.map(({ method }) => method),
    ];
    for (const method of methods) {
      expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(method);
    }
  });

  it("upgrades a 1.0 open request to 1.1 with instance and requestId absent", () => {
    const request = {
      epicId: "epic-1",
      simulatorId: "ABCDEF-0000",
      platform: "ios",
      boot: true,
    } as const;
    const upgraded = upgradeRequestToVersion(
      hostRpcRegistry["simulator.open"],
      V10,
      V11,
      request,
    );
    expect(simulatorOpenV11.requestSchema.parse(upgraded)).toStrictEqual(
      request,
    );
  });

  it("upgrades a 1.0 close request to 1.1 with sessionId absent", () => {
    const request = {
      epicId: "epic-1",
      simulatorId: "ABCDEF-0000",
      shutdown: false,
    } as const;
    const upgraded = upgradeRequestToVersion(
      hostRpcRegistry["simulator.close"],
      V10,
      V11,
      request,
    );
    expect(simulatorCloseV11.requestSchema.parse(upgraded)).toStrictEqual(
      request,
    );
  });

  it("upgrades a 1.0 list request to 1.1 unchanged", () => {
    const request = { epicId: "epic-1" } as const;
    const upgraded = upgradeRequestToVersion(
      hostRpcRegistry["simulator.list"],
      V10,
      V11,
      request,
    );
    expect(simulatorListV11.requestSchema.parse(upgraded)).toStrictEqual(
      request,
    );
  });

  it("upgrades a 1.0 config.simulator.get request to 1.1 unchanged", () => {
    const upgraded = upgradeRequestToVersion(
      hostRpcRegistry["config.simulator.get"],
      V10,
      V11,
      {},
    );
    expect(configSimulatorGetV11.requestSchema.parse(upgraded)).toStrictEqual(
      {},
    );
  });

  it("upgrades a 1.0 config.simulator.set request to 1.1 with idleMinutes absent", () => {
    const upgraded = upgradeRequestToVersion(
      hostRpcRegistry["config.simulator.set"],
      V10,
      V11,
      { enabled: true },
    );
    expect(configSimulatorSetV11.requestSchema.parse(upgraded)).toStrictEqual({
      enabled: true,
    });
  });

  it("strips the 1.1 open keys from a 1.0 response and keeps them on 1.1", () => {
    const session = {
      epicId: "epic-1",
      ownerUserId: "user-1",
      hostId: "host-1",
      simulatorId: "ABCDEF-0000",
      platform: "ios",
      openedAt: "2026-10-18T00:00:00.000Z",
    };
    const response = {
      session: { ...session, sessionId: "session-1" },
      simulator: {
        simulatorId: "ABCDEF-0000",
        platform: "ios",
        name: "iPhone 17",
        version: "iOS 26.0",
        booted: true,
        physical: false,
      },
    };
    expect(simulatorOpenV10.responseSchema.parse(response).session).toEqual(
      session,
    );
    expect(
      simulatorOpenV11.responseSchema.parse(response).session.sessionId,
    ).toBe("session-1");
  });

  it("strips opening and a summary's instances from a 1.0 list response", () => {
    const instance = {
      instanceKey: "ABCDEF-0000",
      name: "iPhone 17",
      booted: true,
      cloneOf: null,
      drivenByAgent: false,
      keepRunning: false,
      idleUntil: null,
    };
    const state = {
      revision: 1,
      hostId: "host-1",
      platforms: [],
      packState: { kind: "off", reason: null, progress: null },
      hubState: { kind: "running", lastError: null },
      simulators: [
        {
          simulatorId: "ABCDEF-0000",
          platform: "ios",
          name: "iPhone 17",
          version: "iOS 26.0",
          booted: true,
          physical: false,
          instances: [instance],
        },
      ],
      sessions: [],
      booting: [],
      opening: [{ requestId: "r1" }],
    };
    const v10 = simulatorListV10.responseSchema.parse(state);
    expect(v10).not.toHaveProperty("opening");
    expect(v10.simulators[0]).not.toHaveProperty("instances");
    const v11 = simulatorListV11.responseSchema.parse(state);
    expect(v11.opening).toEqual([{ requestId: "r1" }]);
    expect(v11.simulators[0].instances).toEqual([instance]);
  });

  it("strips idleMinutes from a 1.0 config response and keeps it on 1.1", () => {
    const response = { enabled: true, idleMinutes: 15 };
    expect(configSimulatorGetV10.responseSchema.parse(response)).toEqual({
      enabled: true,
    });
    expect(configSimulatorGetV11.responseSchema.parse(response)).toEqual(
      response,
    );
  });

  it("writes the idle window with a null switch on config.simulator.set@1.1", () => {
    const schema = configSimulatorSetV11.requestSchema;
    expect(schema.parse({ enabled: null, idleMinutes: 5 })).toEqual({
      enabled: null,
      idleMinutes: 5,
    });
    // `enabled` stays a required key, so a 1.1 write is always projectable.
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ idleMinutes: 5 }).success).toBe(false);
    for (const idleMinutes of [0, 1441, 1.5]) {
      expect(schema.safeParse({ enabled: true, idleMinutes }).success).toBe(
        false,
      );
    }
    // The frozen 1.0 line has no idle window to write, so a null is refused.
    expect(
      configSimulatorSetV10.requestSchema.safeParse({ enabled: null }).success,
    ).toBe(false);
  });

  it("picks the instance on open@1.1 by policy or by key", () => {
    const base = {
      epicId: "epic-1",
      simulatorId: "ABCDEF-0000",
      platform: "ios",
      boot: true,
    };
    const accepts = (instance: string) =>
      simulatorOpenV11.requestSchema.safeParse({ ...base, instance }).success;
    expect(accepts("auto")).toBe(true);
    expect(accepts("new")).toBe(true);
    expect(accepts("ABCDEF-0000")).toBe(true);
    expect(accepts("")).toBe(false);
  });

  it("carries the one switch, stated on every config write", () => {
    expect(configSimulatorGetV10.requestSchema.parse({})).toEqual({});
    expect(
      configSimulatorSetV10.requestSchema.parse({ enabled: true }),
    ).toEqual({ enabled: true });
    expect(
      configSimulatorGetV10.responseSchema.parse({ enabled: false }),
    ).toEqual({ enabled: false });
    // One switch: the old agent-access key is not on the wire, and a missing
    // switch is a malformed peer, not "leave it alone".
    expect(
      configSimulatorSetV10.requestSchema.parse({
        enabled: true,
        agentAccess: true,
      }),
    ).toEqual({ enabled: true });
    expect(() => configSimulatorSetV10.requestSchema.parse({})).toThrow();
  });

  it("names the simulator by simulatorId, never deviceId", () => {
    const session = {
      epicId: "epic-1",
      ownerUserId: "user-1",
      hostId: "host-1",
      simulatorId: "ABCDEF-0000",
      platform: "ios",
      openedAt: "2026-10-18T00:00:00.000Z",
    };
    expect(
      simulatorOpenV10.responseSchema.parse({
        session,
        simulator: {
          simulatorId: "ABCDEF-0000",
          platform: "ios",
          name: "iPhone 17",
          version: "iOS 26.0",
          booted: true,
          physical: false,
        },
      }).session,
    ).toEqual(session);
    expect(() =>
      simulatorOpenV10.requestSchema.parse({
        epicId: "epic-1",
        deviceId: "ABCDEF-0000",
        platform: "ios",
        boot: true,
      }),
    ).toThrow();
    expect(() =>
      simulatorOpenV10.requestSchema.parse({
        epicId: "epic-1",
        simulatorId: "ABCDEF-0000",
        platform: "watchos",
        boot: true,
      }),
    ).toThrow();
  });

  it("carries the screenshot as base64 PNG with nullable dimensions", () => {
    expect(
      simulatorScreenshotV10.responseSchema.parse({
        simulatorId: "emulator-5554",
        platform: "android",
        pngBase64: "iVBORw0KGgo=",
        width: null,
        height: null,
      }).width,
    ).toBeNull();
    expect(() =>
      simulatorScreenshotV10.responseSchema.parse({
        simulatorId: "emulator-5554",
        platform: "android",
        pngBase64: "iVBORw0KGgo=",
        width: 0,
        height: 10,
      }),
    ).toThrow();
  });

  it("reports what the store holds beside the switch's pack state, and removal by version", () => {
    const status = {
      platforms: [],
      packState: { kind: "off", reason: null, progress: null },
      packVersion: null,
    };
    expect(
      simulatorStatusV10.responseSchema.parse({
        ...status,
        installed: { version: "0.15.3-0.21.25.22.23.3", sizeBytes: 216 },
      }).installed,
    ).toEqual({ version: "0.15.3-0.21.25.22.23.3", sizeBytes: 216 });
    expect(
      simulatorStatusV10.responseSchema.parse({ ...status, installed: null })
        .installed,
    ).toBeNull();
    // Bytes on disk are a whole count; a missing field is a malformed peer.
    expect(() =>
      simulatorStatusV10.responseSchema.parse({
        ...status,
        installed: { version: "1", sizeBytes: 1.5 },
      }),
    ).toThrow();
    expect(() => simulatorStatusV10.responseSchema.parse(status)).toThrow();
    expect(simulatorRemoveToolsV10.requestSchema.parse({})).toEqual({});
    expect(
      simulatorRemoveToolsV10.responseSchema.parse({
        removed: ["0.15.3-0.21.25.22.23.3"],
      }),
    ).toEqual({ removed: ["0.15.3-0.21.25.22.23.3"] });
    expect(
      simulatorRemoveToolsV10.responseSchema.parse({ removed: [] }).removed,
    ).toEqual([]);
  });

  it("reports a shutdown as the simulator no longer booted", () => {
    expect(
      simulatorShutdownV10.responseSchema.parse({
        simulatorId: "ABCDEF-0000",
        booted: false,
      }),
    ).toEqual({ simulatorId: "ABCDEF-0000", booted: false });
    expect(() =>
      simulatorShutdownV10.responseSchema.parse({
        simulatorId: "ABCDEF-0000",
        booted: true,
      }),
    ).toThrow();
  });

  it("admits only values that cannot read as a command-line flag", () => {
    const request = (action: Record<string, unknown>) => ({
      epicId: "epic-1",
      simulatorId: "ABCDEF-0000",
      action,
    });
    const parse = (action: Record<string, unknown>) =>
      simulatorActionV10.requestSchema.safeParse(request(action)).success;
    expect(parse({ type: "launchApp", appId: "com.example.app" })).toBe(true);
    expect(parse({ type: "launchApp", appId: "-n" })).toBe(false);
    expect(parse({ type: "launchApp", appId: "com.example app" })).toBe(false);
    expect(
      parse({ type: "openUrl", url: "https://example.com/?a=1&b=2" }),
    ).toBe(true);
    expect(parse({ type: "openUrl", url: "--es" })).toBe(false);
    expect(parse({ type: "openUrl", url: "https://a b" })).toBe(false);
    expect(parse({ type: "setLocation", latitude: 91, longitude: 0 })).toBe(
      false,
    );
  });
});
