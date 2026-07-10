import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildConnectionManifest,
  checkCompatibility,
  defineFallbackMethodDegrade,
  defineFloorAwareVersionedRpcRegistry,
  defineRpcContract,
  defineVersionedRpcRegistry,
  mergeConnectionManifests,
  splitConnectionManifest,
  validateVersionedRpcRegistryDegrades,
} from "@traycer/protocol/framework/index";
import { releasedMethodNames } from "@traycer/protocol/host/__tests__/__fixtures__/released-method-names";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";

const FLOOR_METHOD_V10 = defineRpcContract({
  method: "floor.method",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({ id: z.string() }),
  responseSchema: z.object({ name: z.string() }),
});

const OPTIONAL_METHOD_V10 = defineRpcContract({
  method: "optional.method",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({ id: z.string(), includeDetails: z.boolean() }),
  responseSchema: z.object({ name: z.string(), details: z.string() }),
});

const REGISTRY_WITH_UNSUPPORTED_OPTIONAL = defineFloorAwareVersionedRpcRegistry(
  ["floor.method"] as const,
  {
    "floor.method": {
      1: {
        latestMinor: 0,
        versions: {
          0: {
            contract: FLOOR_METHOD_V10,
            upgradeFromPreviousVersion: null,
          },
        },
        downgradePathsFromLatest: {},
      },
    },
    "optional.method": {
      degrade: { kind: "unsupported" },
      1: {
        latestMinor: 0,
        versions: {
          0: {
            contract: OPTIONAL_METHOD_V10,
            upgradeFromPreviousVersion: null,
          },
        },
        downgradePathsFromLatest: {},
      },
    },
  },
);

describe("capability manifest helpers", () => {
  it("keeps today's host legacy manifest byte-identical to the full manifest", () => {
    const fullManifest = buildConnectionManifest(hostRpcRegistry);
    const split = splitConnectionManifest(hostRpcRegistry, releasedMethodNames);

    expect(split.manifest).toEqual(fullManifest);
    expect(split.optionalManifest).toEqual({});
    expect(JSON.stringify(split.manifest)).toBe(JSON.stringify(fullManifest));
  });

  it("splits non-floor methods into the optional channel", () => {
    const split = splitConnectionManifest(REGISTRY_WITH_UNSUPPORTED_OPTIONAL, [
      "floor.method",
    ]);

    expect(split).toEqual({
      manifest: {
        "floor.method": { major: 1, minor: 0 },
      },
      optionalManifest: {
        "optional.method": { major: 1, minor: 0 },
      },
    });
  });

  it("keeps optional methods out of the fatal compatibility domain", () => {
    const split = splitConnectionManifest(REGISTRY_WITH_UNSUPPORTED_OPTIONAL, [
      "floor.method",
    ]);

    expect(
      checkCompatibility(
        REGISTRY_WITH_UNSUPPORTED_OPTIONAL,
        split.manifest,
        { "floor.method": { major: 1, minor: 0 } },
        "host",
      ),
    ).toEqual({ ok: true });
  });

  it("merges absent optional manifests as an empty set", () => {
    const manifest = {
      "floor.method": { major: 1, minor: 0 },
    };

    expect(mergeConnectionManifests(manifest, undefined)).toEqual(manifest);
    expect(
      mergeConnectionManifests(manifest, {
        "optional.method": { major: 1, minor: 0 },
      }),
    ).toEqual({
      "floor.method": { major: 1, minor: 0 },
      "optional.method": { major: 1, minor: 0 },
    });
  });
});

describe("floor-aware RPC registry validation", () => {
  it("accepts a fallback degrade targeting a floor method version", () => {
    const fallback = defineFallbackMethodDegrade<
      typeof OPTIONAL_METHOD_V10,
      typeof FLOOR_METHOD_V10,
      "floor.method"
    >({
      kind: "fallback",
      to: { method: "floor.method", major: 1, minor: 0 },
      adaptRequest: (request) => ({ id: request.id }),
      adaptResponse: (response) => ({
        name: response.name,
        details: "",
      }),
    });

    const registry = defineFloorAwareVersionedRpcRegistry(
      ["floor.method"] as const,
      {
        "floor.method": {
          1: {
            latestMinor: 0,
            versions: {
              0: {
                contract: FLOOR_METHOD_V10,
                upgradeFromPreviousVersion: null,
              },
            },
            downgradePathsFromLatest: {},
          },
        },
        "optional.method": {
          degrade: fallback,
          1: {
            latestMinor: 0,
            versions: {
              0: {
                contract: OPTIONAL_METHOD_V10,
                upgradeFromPreviousVersion: null,
              },
            },
            downgradePathsFromLatest: {},
          },
        },
      },
    );

    expect(splitConnectionManifest(registry, ["floor.method"])).toEqual({
      manifest: {
        "floor.method": { major: 1, minor: 0 },
      },
      optionalManifest: {
        "optional.method": { major: 1, minor: 0 },
      },
    });
  });

  it("rejects non-floor methods without a degrade declaration", () => {
    const registry = defineVersionedRpcRegistry({
      "floor.method": {
        1: {
          latestMinor: 0,
          versions: {
            0: {
              contract: FLOOR_METHOD_V10,
              upgradeFromPreviousVersion: null,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
      "optional.method": {
        1: {
          latestMinor: 0,
          versions: {
            0: {
              contract: OPTIONAL_METHOD_V10,
              upgradeFromPreviousVersion: null,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    });

    expect(() =>
      validateVersionedRpcRegistryDegrades(registry, ["floor.method"]),
    ).toThrow(
      "Non-floor method 'optional.method' must declare a degrade strategy",
    );
  });

  it("rejects fallback degrades that target optional methods", () => {
    const registry = defineVersionedRpcRegistry({
      "floor.method": {
        1: {
          latestMinor: 0,
          versions: {
            0: {
              contract: FLOOR_METHOD_V10,
              upgradeFromPreviousVersion: null,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
      "optional.method": {
        degrade: defineFallbackMethodDegrade<
          typeof OPTIONAL_METHOD_V10,
          typeof FLOOR_METHOD_V10,
          "optional.method"
        >({
          kind: "fallback",
          to: { method: "optional.method", major: 1, minor: 0 },
          adaptRequest: (request) => ({ id: request.id }),
          adaptResponse: (response) => ({
            name: response.name,
            details: "",
          }),
        }),
        1: {
          latestMinor: 0,
          versions: {
            0: {
              contract: OPTIONAL_METHOD_V10,
              upgradeFromPreviousVersion: null,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    });

    expect(() =>
      validateVersionedRpcRegistryDegrades(registry, ["floor.method"]),
    ).toThrow(
      "Fallback degrade for method 'optional.method' must target a floor method, got 'optional.method'",
    );
  });
});
