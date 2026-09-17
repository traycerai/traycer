import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  configBrowserGetV10,
  configBrowserSetV10,
} from "@traycer/protocol/host/config/contracts";

/**
 * `config.browser.*` is the machine-user-global agent browser-access switch.
 * It is registered exactly like `config.logLevels.*` - one v1.0 line, no
 * upgrade paths, and `degrade: { kind: "unsupported" }` so a host that predates
 * the switch reports the method as missing rather than answering for it.
 */
describe("config.browser contracts", () => {
  it("registers get and set at v1.0 with the unsupported degrade", () => {
    for (const method of [
      "config.browser.get",
      "config.browser.set",
    ] as const) {
      const entry = hostRpcRegistry[method];
      expect(entry.degrade).toEqual({ kind: "unsupported" });
      expect(entry[1].latestMinor).toBe(0);
      expect(entry[1].versions[0].upgradeFromPreviousVersion).toBeNull();
      expect(entry[1].downgradePathsFromLatest).toEqual({});
    }
    expect(hostRpcRegistry["config.browser.get"][1].versions[0].contract).toBe(
      configBrowserGetV10,
    );
    expect(hostRpcRegistry["config.browser.set"][1].versions[0].contract).toBe(
      configBrowserSetV10,
    );
  });

  it("carries an empty get request and a boolean-only payload both ways", () => {
    expect(configBrowserGetV10.requestSchema.parse({})).toEqual({});
    expect(
      configBrowserGetV10.responseSchema.parse({ agentAccess: true }),
    ).toEqual({ agentAccess: true });
    expect(
      configBrowserSetV10.requestSchema.parse({ agentAccess: false }),
    ).toEqual({ agentAccess: false });
    expect(
      configBrowserSetV10.responseSchema.parse({ agentAccess: false }),
    ).toEqual({ agentAccess: false });
    expect(() =>
      configBrowserSetV10.requestSchema.parse({ agentAccess: "yes" }),
    ).toThrow();
    // No implicit default on the wire: the host always states the value it
    // resolved, so a missing key is a malformed peer, not "use the default".
    expect(() => configBrowserSetV10.requestSchema.parse({})).toThrow();
  });
});
