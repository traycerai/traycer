import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  upgradeRequestToVersion,
  upgradeResponseToVersion,
} from "@traycer/protocol/framework/index";
import {
  configCatalogGetUpgradeV10ToV11,
  configCatalogGetV10,
  configCatalogGetV11,
  configCatalogSetUpgradeV10ToV11,
  configCatalogSetV10,
  configCatalogSetV11,
} from "@traycer/protocol/host/config/contracts";

/**
 * `config.catalog.*` is the model/command list timeout. 1.0 carried one shared
 * value; 1.1 adds each provider's own value (`overrides`) and a scoped set
 * (`scope: "all"` | `scope: "harness"`). The set request proves only a
 * positive whole number; the range is the host's to enforce and travels as
 * `bounds`.
 */
const V10 = { major: 1, minor: 0 } as const;
const V11 = { major: 1, minor: 1 } as const;
const BOUNDS = { minSeconds: 60, maxSeconds: 180 };

describe("config.catalog contracts", () => {
  it("registers get and set at v1.1 with the unsupported degrade", () => {
    for (const method of [
      "config.catalog.get",
      "config.catalog.set",
    ] as const) {
      const entry = hostRpcRegistry[method];
      expect(entry.degrade).toEqual({ kind: "unsupported" });
      expect(entry[1].latestMinor).toBe(1);
      expect(entry[1].versions[0].upgradeFromPreviousVersion).toBeNull();
      expect(entry[1].downgradePathsFromLatest).toEqual({});
    }
    const get = hostRpcRegistry["config.catalog.get"][1].versions;
    const set = hostRpcRegistry["config.catalog.set"][1].versions;
    expect(get[0].contract).toBe(configCatalogGetV10);
    expect(get[1].contract).toBe(configCatalogGetV11);
    expect(get[1].upgradeFromPreviousVersion).toBe(
      configCatalogGetUpgradeV10ToV11,
    );
    expect(set[0].contract).toBe(configCatalogSetV10);
    expect(set[1].contract).toBe(configCatalogSetV11);
    expect(set[1].upgradeFromPreviousVersion).toBe(
      configCatalogSetUpgradeV10ToV11,
    );
  });

  it("names the methods and versions on the contracts themselves", () => {
    expect(configCatalogGetV10.method).toBe("config.catalog.get");
    expect(configCatalogSetV10.method).toBe("config.catalog.set");
    expect(configCatalogGetV11.method).toBe("config.catalog.get");
    expect(configCatalogSetV11.method).toBe("config.catalog.set");
    expect(configCatalogGetV10.schemaVersion).toEqual(V10);
    expect(configCatalogSetV10.schemaVersion).toEqual(V10);
    expect(configCatalogGetV11.schemaVersion).toEqual(V11);
    expect(configCatalogSetV11.schemaVersion).toEqual(V11);
  });

  it("carries an empty get request on both lines", () => {
    expect(configCatalogGetV10.requestSchema.parse({})).toEqual({});
    expect(configCatalogGetV11.requestSchema.parse({})).toEqual({});
  });

  describe("v1.0 schemas stay frozen", () => {
    it("parses the 1.0 response with its bounds in both methods", () => {
      const response = { probeTimeoutSeconds: 120, bounds: BOUNDS };
      expect(configCatalogGetV10.responseSchema.parse(response)).toEqual(
        response,
      );
      expect(configCatalogSetV10.responseSchema.parse(response)).toEqual(
        response,
      );
    });

    it("strips overrides from a 1.0 response", () => {
      const parsed = configCatalogGetV10.responseSchema.parse({
        probeTimeoutSeconds: 120,
        overrides: { claude: 90 },
        bounds: BOUNDS,
      });
      expect(parsed).toEqual({ probeTimeoutSeconds: 120, bounds: BOUNDS });
    });

    it("requires bounds on the 1.0 response", () => {
      expect(() =>
        configCatalogGetV10.responseSchema.parse({ probeTimeoutSeconds: 120 }),
      ).toThrow();
      expect(() =>
        configCatalogSetV10.responseSchema.parse({ probeTimeoutSeconds: 120 }),
      ).toThrow();
      expect(() =>
        configCatalogGetV10.responseSchema.parse({ bounds: BOUNDS }),
      ).toThrow();
      expect(() =>
        configCatalogGetV10.responseSchema.parse({
          probeTimeoutSeconds: 120,
          bounds: { minSeconds: 60 },
        }),
      ).toThrow();
    });

    it("accepts any positive whole number in the bare 1.0 set request", () => {
      for (const probeTimeoutSeconds of [120, 59, 181]) {
        expect(
          configCatalogSetV10.requestSchema.parse({ probeTimeoutSeconds }),
        ).toEqual({ probeTimeoutSeconds });
      }
    });

    it("rejects a non-positive, fractional or non-numeric 1.0 set request", () => {
      for (const probeTimeoutSeconds of [0, -5, 90.5, "120", null]) {
        expect(() =>
          configCatalogSetV10.requestSchema.parse({ probeTimeoutSeconds }),
        ).toThrow();
      }
      expect(() => configCatalogSetV10.requestSchema.parse({})).toThrow();
    });
  });

  describe("v1.1 set request", () => {
    const parse = (value: unknown) =>
      configCatalogSetV11.requestSchema.parse(value);

    it("accepts the shared scope", () => {
      expect(parse({ scope: "all", probeTimeoutSeconds: 90 })).toEqual({
        scope: "all",
        probeTimeoutSeconds: 90,
      });
    });

    it("accepts the harness scope with a value or with null", () => {
      expect(
        parse({
          scope: "harness",
          harnessId: "claude",
          probeTimeoutSeconds: 120,
        }),
      ).toEqual({
        scope: "harness",
        harnessId: "claude",
        probeTimeoutSeconds: 120,
      });
      expect(
        parse({
          scope: "harness",
          harnessId: "claude",
          probeTimeoutSeconds: null,
        }),
      ).toEqual({
        scope: "harness",
        harnessId: "claude",
        probeTimeoutSeconds: null,
      });
    });

    it("accepts null only for the harness scope", () => {
      expect(() =>
        parse({ scope: "all", probeTimeoutSeconds: null }),
      ).toThrow();
    });

    it("requires a harnessId for the harness scope", () => {
      expect(() =>
        parse({ scope: "harness", probeTimeoutSeconds: 90 }),
      ).toThrow();
      expect(() =>
        parse({ scope: "harness", harnessId: "", probeTimeoutSeconds: 90 }),
      ).toThrow();
    });

    it("rejects an unknown scope and a missing scope", () => {
      expect(() =>
        parse({ scope: "provider", probeTimeoutSeconds: 90 }),
      ).toThrow();
      expect(() => parse({ probeTimeoutSeconds: 90 })).toThrow();
    });

    it("requires a positive whole number for both scopes; the range is the host's", () => {
      for (const probeTimeoutSeconds of [0, -1, 90.5, "90"]) {
        expect(() => parse({ scope: "all", probeTimeoutSeconds })).toThrow();
        expect(() =>
          parse({ scope: "harness", harnessId: "claude", probeTimeoutSeconds }),
        ).toThrow();
      }
      for (const probeTimeoutSeconds of [59, 181]) {
        expect(parse({ scope: "all", probeTimeoutSeconds })).toEqual({
          scope: "all",
          probeTimeoutSeconds,
        });
        expect(
          parse({ scope: "harness", harnessId: "claude", probeTimeoutSeconds }),
        ).toEqual({
          scope: "harness",
          harnessId: "claude",
          probeTimeoutSeconds,
        });
      }
    });
  });

  describe("v1.1 response", () => {
    it("parses overrides with the bounds in both methods", () => {
      const response = {
        probeTimeoutSeconds: 60,
        overrides: { claude: 90, opencode: 120 },
        bounds: BOUNDS,
      };
      expect(configCatalogGetV11.responseSchema.parse(response)).toEqual(
        response,
      );
      expect(configCatalogSetV11.responseSchema.parse(response)).toEqual(
        response,
      );
    });

    it("requires overrides", () => {
      const withoutOverrides = { probeTimeoutSeconds: 60, bounds: BOUNDS };
      expect(() =>
        configCatalogGetV11.responseSchema.parse(withoutOverrides),
      ).toThrow();
      expect(() =>
        configCatalogSetV11.responseSchema.parse(withoutOverrides),
      ).toThrow();
    });

    it("rejects a non-positive or fractional override value", () => {
      for (const value of [0, -1, 90.5]) {
        expect(() =>
          configCatalogGetV11.responseSchema.parse({
            probeTimeoutSeconds: 60,
            overrides: { claude: value },
            bounds: BOUNDS,
          }),
        ).toThrow();
      }
    });
  });

  describe("v1.0 to v1.1 upgrades", () => {
    it("upgrades a bare 1.0 set body to scope all", () => {
      const upgraded = upgradeRequestToVersion(
        hostRpcRegistry["config.catalog.set"],
        V10,
        V11,
        { probeTimeoutSeconds: 90 },
      );
      expect(upgraded).toEqual({ scope: "all", probeTimeoutSeconds: 90 });
      expect(configCatalogSetV11.requestSchema.parse(upgraded)).toEqual({
        scope: "all",
        probeTimeoutSeconds: 90,
      });
    });

    it("leaves the get request unchanged", () => {
      expect(
        upgradeRequestToVersion(
          hostRpcRegistry["config.catalog.get"],
          V10,
          V11,
          {},
        ),
      ).toEqual({});
    });

    it("adds empty overrides when upgrading the get and set responses", () => {
      const response = { probeTimeoutSeconds: 90, bounds: BOUNDS };
      const expected = {
        probeTimeoutSeconds: 90,
        overrides: {},
        bounds: BOUNDS,
      };
      expect(
        upgradeResponseToVersion(
          hostRpcRegistry["config.catalog.get"],
          V10,
          V11,
          response,
        ),
      ).toEqual(expected);
      expect(
        upgradeResponseToVersion(
          hostRpcRegistry["config.catalog.set"],
          V10,
          V11,
          response,
        ),
      ).toEqual(expected);
    });
  });
});
