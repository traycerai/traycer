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
  selectConnectionManifestForPeer,
  SERVES_EVERY_INSTALLED_MAJOR,
  splitConnectionManifest,
  validateVersionedRpcRegistryDegrades,
  type ServedMajorsByMethod,
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

const MULTI_MAJOR_MANIFEST_REGISTRY = {
  echo: {
    1: { latestMinor: 1 },
    2: { latestMinor: 0 },
  },
} as const;

const UNSORTED_MAJOR_MANIFEST_REGISTRY = {
  echo: {
    3: { latestMinor: 2 },
    1: { latestMinor: 4 },
    2: { latestMinor: 1 },
  },
  single: {
    4: { latestMinor: 0 },
  },
} as const;

describe("capability manifest helpers", () => {
  it("keeps the host legacy manifest exactly the released floor set", () => {
    // Old peers negotiate against `manifest` alone with fail-closed name-set
    // semantics, so it must carry the frozen floor methods and nothing else.
    // Post-#272 additive methods (e.g. the notifications RPCs, or this PR's
    // `epic.updateChatRunSettings`) land in `optionalManifest` instead.
    const fullManifest = buildConnectionManifest(
      hostRpcRegistry,
      SERVES_EVERY_INSTALLED_MAJOR,
    );
    const split = splitConnectionManifest(
      hostRpcRegistry,
      releasedMethodNames,
      SERVES_EVERY_INSTALLED_MAJOR,
    );

    expect(Object.keys(split.manifest).sort()).toEqual(
      [...releasedMethodNames].sort(),
    );
    for (const [method, version] of Object.entries(split.manifest)) {
      expect(version).toEqual(fullManifest[method]);
    }
    for (const method of Object.keys(split.optionalManifest)) {
      expect(releasedMethodNames).not.toContain(method);
      expect(fullManifest[method]).toEqual(split.optionalManifest[method]);
    }
    expect({ ...split.manifest, ...split.optionalManifest }).toEqual(
      fullManifest,
    );
    expect(
      mergeConnectionManifests(split.manifest, split.optionalManifest),
    ).toEqual(fullManifest);
  });

  it("splits non-floor methods into the optional channel", () => {
    const split = splitConnectionManifest(
      REGISTRY_WITH_UNSUPPORTED_OPTIONAL,
      ["floor.method"],
      SERVES_EVERY_INSTALLED_MAJOR,
    );

    expect(split).toEqual({
      manifest: {
        "floor.method": { major: 1, minor: 0, supportedMajors: [1] },
      },
      optionalManifest: {
        "optional.method": { major: 1, minor: 0, supportedMajors: [1] },
      },
    });
  });

  it("emits every installed major in ascending order, including single-major methods", () => {
    expect(
      buildConnectionManifest(
        UNSORTED_MAJOR_MANIFEST_REGISTRY,
        SERVES_EVERY_INSTALLED_MAJOR,
      ),
    ).toEqual({
      echo: { major: 3, minor: 2, supportedMajors: [1, 2, 3] },
      single: { major: 4, minor: 0, supportedMajors: [4] },
    });

    expect(
      splitConnectionManifest(
        UNSORTED_MAJOR_MANIFEST_REGISTRY,
        ["echo"],
        SERVES_EVERY_INSTALLED_MAJOR,
      ),
    ).toEqual({
      manifest: {
        echo: { major: 3, minor: 2, supportedMajors: [1, 2, 3] },
      },
      optionalManifest: {
        single: { major: 4, minor: 0, supportedMajors: [4] },
      },
    });
  });

  it("keeps optional methods out of the fatal compatibility domain", () => {
    const split = splitConnectionManifest(
      REGISTRY_WITH_UNSUPPORTED_OPTIONAL,
      ["floor.method"],
      SERVES_EVERY_INSTALLED_MAJOR,
    );

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

  it("selects the latest installed minor on the peer's offered major", () => {
    const hostManifest = buildConnectionManifest(
      MULTI_MAJOR_MANIFEST_REGISTRY,
      SERVES_EVERY_INSTALLED_MAJOR,
    );

    expect(
      selectConnectionManifestForPeer(
        MULTI_MAJOR_MANIFEST_REGISTRY,
        hostManifest,
        {
          echo: { major: 1, minor: 0 },
        },
      ),
    ).toEqual({
      echo: { major: 1, minor: 1, supportedMajors: [1, 2] },
    });
  });

  it("selects the highest shared major for a new peer and a legacy peer", () => {
    const hostManifest = buildConnectionManifest(
      MULTI_MAJOR_MANIFEST_REGISTRY,
      SERVES_EVERY_INSTALLED_MAJOR,
    );

    expect(
      selectConnectionManifestForPeer(
        MULTI_MAJOR_MANIFEST_REGISTRY,
        hostManifest,
        {
          echo: {
            major: 2,
            minor: 0,
            supportedMajors: [1, 2],
          },
        },
      ),
    ).toEqual({
      echo: { major: 2, minor: 0, supportedMajors: [1, 2] },
    });

    expect(
      selectConnectionManifestForPeer(
        MULTI_MAJOR_MANIFEST_REGISTRY,
        hostManifest,
        { echo: { major: 1, minor: 0 } },
      ),
    ).toEqual({
      echo: { major: 1, minor: 1, supportedMajors: [1, 2] },
    });
  });

  it("retains the host canonical when a peer advertises an uninstalled major", () => {
    const hostRegistry = {
      echo: {
        1: { latestMinor: 1 },
      },
    } as const;
    const hostManifest = buildConnectionManifest(
      hostRegistry,
      SERVES_EVERY_INSTALLED_MAJOR,
    );

    expect(
      selectConnectionManifestForPeer(hostRegistry, hostManifest, {
        echo: { major: 3, minor: 0, supportedMajors: [3] },
      }),
    ).toEqual({
      echo: { major: 1, minor: 1, supportedMajors: [1] },
    });
  });

  it("retains the host canonical when the peer's major is not installed", () => {
    const hostManifest = buildConnectionManifest(
      MULTI_MAJOR_MANIFEST_REGISTRY,
      SERVES_EVERY_INSTALLED_MAJOR,
    );

    expect(
      selectConnectionManifestForPeer(
        MULTI_MAJOR_MANIFEST_REGISTRY,
        hostManifest,
        {
          echo: { major: 3, minor: 0 },
          "peer.only": { major: 1, minor: 0 },
        },
      ),
    ).toEqual({
      echo: { major: 2, minor: 0, supportedMajors: [1, 2] },
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

    expect(
      splitConnectionManifest(
        registry,
        ["floor.method"],
        SERVES_EVERY_INSTALLED_MAJOR,
      ),
    ).toEqual({
      manifest: {
        "floor.method": { major: 1, minor: 0, supportedMajors: [1] },
      },
      optionalManifest: {
        "optional.method": {
          major: 1,
          minor: 0,
          supportedMajors: [1],
        },
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

describe("served-majors restriction", () => {
  it("narrows supportedMajors to what this peer serves", () => {
    const served: ServedMajorsByMethod = { echo: [1] };

    expect(
      buildConnectionManifest(MULTI_MAJOR_MANIFEST_REGISTRY, served),
    ).toEqual({
      echo: { major: 1, minor: 1, supportedMajors: [1] },
    });
  });

  it("moves the canonical off the highest installed major when restricted", () => {
    // Unrestricted, the canonical for `echo` is 2.0 (highest installed major,
    // highest installed minor). A peer that can only SERVE major 1 must
    // advertise 1.1 as canonical - checking supportedMajors alone would miss
    // this: it would pass even if canonical still said 2.0, which is the
    // actual CRITICAL this restriction fixes.
    const unrestricted = buildConnectionManifest(
      MULTI_MAJOR_MANIFEST_REGISTRY,
      SERVES_EVERY_INSTALLED_MAJOR,
    );
    expect(unrestricted.echo).toEqual({
      major: 2,
      minor: 0,
      supportedMajors: [1, 2],
    });

    const restricted = buildConnectionManifest(MULTI_MAJOR_MANIFEST_REGISTRY, {
      echo: [1],
    });
    expect(restricted.echo).toEqual({
      major: 1,
      minor: 1,
      supportedMajors: [1],
    });
  });

  it("advertises every installed major for a method absent from the served map", () => {
    const registry = {
      ...MULTI_MAJOR_MANIFEST_REGISTRY,
      unrestricted: { 1: { latestMinor: 0 } },
    } as const;

    const manifest = buildConnectionManifest(registry, { echo: [1] });

    expect(manifest.unrestricted).toEqual({
      major: 1,
      minor: 0,
      supportedMajors: [1],
    });
  });

  it("SERVES_EVERY_INSTALLED_MAJOR reproduces the old unrestricted output", () => {
    expect(
      buildConnectionManifest(
        MULTI_MAJOR_MANIFEST_REGISTRY,
        SERVES_EVERY_INSTALLED_MAJOR,
      ),
    ).toEqual({
      echo: { major: 2, minor: 0, supportedMajors: [1, 2] },
    });
  });

  it("falls back to the full line, and keeps the method name, on empty intersection", () => {
    // Serving [7] for a method installed at 1 and 2 shares nothing with the
    // installed line. Dropping the method NAME here would be handshake-fatal
    // for the whole connection - the released-floor check fails on any name
    // present on one side only - so the safe response is to over-advertise
    // (fall back to the full installed line) rather than omit the method.
    const manifest = buildConnectionManifest(MULTI_MAJOR_MANIFEST_REGISTRY, {
      echo: [7],
    });

    expect(manifest.echo).toBeDefined();
    expect(manifest.echo).toEqual({
      major: 2,
      minor: 0,
      supportedMajors: [1, 2],
    });
  });

  it("selectConnectionManifestForPeer picks the restricted major end to end", () => {
    // The end-to-end shape of the CRITICAL: a host that serves everything
    // negotiating against a client restricted to major 1 must select major 1,
    // not the peer's canonical.
    const hostManifest = buildConnectionManifest(
      MULTI_MAJOR_MANIFEST_REGISTRY,
      SERVES_EVERY_INSTALLED_MAJOR,
    );
    const clientManifest = buildConnectionManifest(
      MULTI_MAJOR_MANIFEST_REGISTRY,
      { echo: [1] },
    );

    expect(
      selectConnectionManifestForPeer(
        MULTI_MAJOR_MANIFEST_REGISTRY,
        hostManifest,
        clientManifest,
      ),
    ).toEqual({
      echo: { major: 1, minor: 1, supportedMajors: [1, 2] },
    });
  });
});
