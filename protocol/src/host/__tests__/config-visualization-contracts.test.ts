import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  configVisualizationGetV10,
  configVisualizationSetV10,
} from "@traycer/protocol/host/config/contracts";

/**
 * `config.visualization.*` is the machine-user-global "agents may show pages"
 * switch. A host that predates it must report the method as missing, because
 * the Settings row hides itself on that answer.
 */
describe("config.visualization contracts", () => {
  it("registers get and set at v1.0 with the unsupported degrade", () => {
    for (const method of [
      "config.visualization.get",
      "config.visualization.set",
    ] as const) {
      const entry = hostRpcRegistry[method];
      expect(entry.degrade).toEqual({ kind: "unsupported" });
      expect(entry[1].latestMinor).toBe(0);
    }
    expect(
      hostRpcRegistry["config.visualization.get"][1].versions[0].contract,
    ).toBe(configVisualizationGetV10);
    expect(
      hostRpcRegistry["config.visualization.set"][1].versions[0].contract,
    ).toBe(configVisualizationSetV10);
  });

  it("carries an empty get request and a boolean-only payload both ways", () => {
    expect(configVisualizationGetV10.requestSchema.parse({})).toEqual({});
    expect(
      configVisualizationGetV10.responseSchema.parse({ agentPages: true }),
    ).toEqual({ agentPages: true });
    expect(
      configVisualizationSetV10.requestSchema.parse({ agentPages: false }),
    ).toEqual({ agentPages: false });
    expect(
      configVisualizationSetV10.responseSchema.parse({ agentPages: false }),
    ).toEqual({ agentPages: false });
    expect(() =>
      configVisualizationSetV10.requestSchema.parse({ agentPages: "yes" }),
    ).toThrow();
    // The host always states the value it resolved; a missing key is a
    // malformed peer, not "use the default".
    expect(() => configVisualizationSetV10.requestSchema.parse({})).toThrow();
    expect(() => configVisualizationGetV10.responseSchema.parse({})).toThrow();
  });
});
