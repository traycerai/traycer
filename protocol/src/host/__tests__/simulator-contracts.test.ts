import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  configSimulatorGetV10,
  configSimulatorSetV10,
  simulatorCloseV10,
  simulatorListV10,
  simulatorOpenV10,
  simulatorRemoveToolsV10,
  simulatorScreenshotV10,
  simulatorShutdownV10,
  simulatorStatusV10,
} from "@traycer/protocol/host/simulator/contracts";
import {
  simulatorActionV10,
  simulatorDetailV10,
} from "@traycer/protocol/host/simulator/actions";

const SIMULATOR_METHODS = {
  "simulator.list": simulatorListV10,
  "simulator.open": simulatorOpenV10,
  "simulator.close": simulatorCloseV10,
  "simulator.shutdown": simulatorShutdownV10,
  "simulator.screenshot": simulatorScreenshotV10,
  "simulator.status": simulatorStatusV10,
  "simulator.removeTools": simulatorRemoveToolsV10,
  "simulator.detail": simulatorDetailV10,
  "simulator.action": simulatorActionV10,
  "config.simulator.get": configSimulatorGetV10,
  "config.simulator.set": configSimulatorSetV10,
} as const;

/**
 * The simulator verbs are registered exactly like `config.browser.*`: one
 * v1.0 line, no upgrade paths, `degrade: { kind: "unsupported" }`, and never
 * on the released floor, so a host that predates the domain (or cannot run a
 * simulator) reports the method as missing rather than answering for it.
 */
describe("simulator contracts", () => {
  it("registers every verb at v1.0 as an optional capability", () => {
    for (const [method, contract] of Object.entries(SIMULATOR_METHODS)) {
      const entry = hostRpcRegistry[method as keyof typeof SIMULATOR_METHODS];
      expect(entry.degrade).toEqual({ kind: "unsupported" });
      expect(entry[1].latestMinor).toBe(0);
      expect(entry[1].versions[0].contract).toBe(contract);
      expect(entry[1].versions[0].upgradeFromPreviousVersion).toBeNull();
      expect(entry[1].downgradePathsFromLatest).toEqual({});
    }
  });

  it("keeps every simulator verb off the released floor", () => {
    for (const method of Object.keys(SIMULATOR_METHODS)) {
      expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(method);
    }
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
