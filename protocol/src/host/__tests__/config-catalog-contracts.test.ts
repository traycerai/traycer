import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  configCatalogGetV10,
  configCatalogSetV10,
} from "@traycer/protocol/host/config/contracts";

/**
 * `config.catalog.*` is the machine-wide model/command list timeout. Registered
 * like `config.worktrees.*`: one v1.0 line, no upgrade paths, and
 * `degrade: { kind: "unsupported" }`. The set request proves only a positive
 * whole number; the range is the host's to enforce and travels as `bounds`.
 */
describe("config.catalog contracts", () => {
  it("registers get and set at v1.0 with the unsupported degrade", () => {
    for (const method of [
      "config.catalog.get",
      "config.catalog.set",
    ] as const) {
      const entry = hostRpcRegistry[method];
      expect(entry.degrade).toEqual({ kind: "unsupported" });
      expect(entry[1].latestMinor).toBe(0);
      expect(entry[1].versions[0].upgradeFromPreviousVersion).toBeNull();
      expect(entry[1].downgradePathsFromLatest).toEqual({});
    }
    expect(hostRpcRegistry["config.catalog.get"][1].versions[0].contract).toBe(
      configCatalogGetV10,
    );
    expect(hostRpcRegistry["config.catalog.set"][1].versions[0].contract).toBe(
      configCatalogSetV10,
    );
  });

  it("names the methods and versions on the contracts themselves", () => {
    expect(configCatalogGetV10.method).toBe("config.catalog.get");
    expect(configCatalogSetV10.method).toBe("config.catalog.set");
    expect(configCatalogGetV10.schemaVersion).toEqual({ major: 1, minor: 0 });
    expect(configCatalogSetV10.schemaVersion).toEqual({ major: 1, minor: 0 });
  });

  it("carries an empty get request", () => {
    expect(configCatalogGetV10.requestSchema.parse({})).toEqual({});
  });

  it("parses the response with its bounds in both methods", () => {
    const response = {
      probeTimeoutSeconds: 120,
      bounds: { minSeconds: 60, maxSeconds: 180 },
    };
    expect(configCatalogGetV10.responseSchema.parse(response)).toEqual(
      response,
    );
    expect(configCatalogSetV10.responseSchema.parse(response)).toEqual(
      response,
    );
  });

  it("requires bounds on the response", () => {
    expect(() =>
      configCatalogGetV10.responseSchema.parse({ probeTimeoutSeconds: 120 }),
    ).toThrow();
    expect(() =>
      configCatalogSetV10.responseSchema.parse({ probeTimeoutSeconds: 120 }),
    ).toThrow();
    expect(() =>
      configCatalogGetV10.responseSchema.parse({
        bounds: { minSeconds: 60, maxSeconds: 180 },
      }),
    ).toThrow();
    expect(() =>
      configCatalogGetV10.responseSchema.parse({
        probeTimeoutSeconds: 120,
        bounds: { minSeconds: 60 },
      }),
    ).toThrow();
  });

  it("accepts any positive whole number in the set request, range included", () => {
    // No range in the schema: the host refuses 59 and 181, so the bounds can
    // move without a protocol change.
    for (const probeTimeoutSeconds of [120, 59, 181]) {
      expect(
        configCatalogSetV10.requestSchema.parse({ probeTimeoutSeconds }),
      ).toEqual({ probeTimeoutSeconds });
    }
  });

  it("rejects a non-positive, fractional or non-numeric set request", () => {
    for (const probeTimeoutSeconds of [0, -5, 90.5, "120", null]) {
      expect(() =>
        configCatalogSetV10.requestSchema.parse({ probeTimeoutSeconds }),
      ).toThrow();
    }
    expect(() => configCatalogSetV10.requestSchema.parse({})).toThrow();
  });
});
