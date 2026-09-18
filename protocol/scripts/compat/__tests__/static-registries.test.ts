import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  STATIC_REGISTRIES,
  findStaticRegistryFailures,
  validateStaticRegistry,
  type StaticRegistry,
} from "../static-registries";
import {
  defineRecordContract,
  defineRecordUpgradePath,
  defineVersionedRecordRegistry,
  defineVersionedRpcRegistry,
  validateVersionedRecordRegistry,
  validateVersionedRpcRegistry,
  type UncheckedMethodVersionRegistry,
  type UncheckedVersionedRecordRegistry,
  type UncheckedVersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import {
  defineVersionedStreamRpcRegistry,
  validateVersionedStreamRpcRegistry,
  type UncheckedStreamMethodVersionRegistry,
  type UncheckedVersionedStreamRpcRegistry,
} from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  persistenceRecordRegistry,
  roomMetadataRecordV100,
} from "@traycer/protocol/persistence/registry";

const STATIC_REGISTRY_NAMES = [
  "hostRpcRegistry",
  "hostStreamRpcRegistry",
  "persistenceRecordRegistry",
  "authRecordRegistry",
  "commonRecordRegistry",
] as const;

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(label);
  }
  return value;
}

function replaceNamedRegistry(
  name: string,
  replacement: StaticRegistry,
): StaticRegistry[] {
  return STATIC_REGISTRIES.map((entry) =>
    entry.name === name ? replacement : entry,
  );
}

function plantedUnaryRegistry(): UncheckedVersionedRpcRegistry {
  const method = hostRpcRegistry["config.shell.listDetected"];
  const line = required(
    method[1],
    "config.shell.listDetected major 1 is missing",
  );
  const v0 = required(
    line.versions[0],
    "config.shell.listDetected 1.0 is missing",
  );
  const v1 = required(
    line.versions[1],
    "config.shell.listDetected 1.1 is missing",
  );
  const plantedMethod: UncheckedMethodVersionRegistry = {
    ...method,
    1: {
      ...line,
      versions: {
        ...line.versions,
        0: {
          ...v0,
          contract: {
            ...v0.contract,
            requestSchema: v1.contract.requestSchema,
            responseSchema: v1.contract.responseSchema,
          },
        },
        1: {
          ...v1,
          contract: {
            ...v1.contract,
            requestSchema: v0.contract.requestSchema,
            responseSchema: v0.contract.responseSchema,
          },
        },
      },
    },
  };
  return {
    ...hostRpcRegistry,
    "config.shell.listDetected": plantedMethod,
  };
}

function plantedStreamRegistry(): UncheckedVersionedStreamRpcRegistry {
  const method = hostStreamRpcRegistry["epic.subscribe"];
  const line = required(method[1], "epic.subscribe major 1 is missing");
  const v0 = required(line.versions[0], "epic.subscribe 1.0 is missing");
  const v1 = required(line.versions[1], "epic.subscribe 1.1 is missing");
  const plantedMethod: UncheckedStreamMethodVersionRegistry = {
    ...method,
    1: {
      ...line,
      versions: {
        ...line.versions,
        0: {
          contract: {
            ...v0.contract,
            openRequestSchema: v1.contract.openRequestSchema,
            serverFrameSchema: v1.contract.serverFrameSchema,
            clientFrameSchema: v1.contract.clientFrameSchema,
          },
        },
        1: {
          contract: {
            ...v1.contract,
            openRequestSchema: v0.contract.openRequestSchema,
            serverFrameSchema: v0.contract.serverFrameSchema,
            clientFrameSchema: v0.contract.clientFrameSchema,
          },
        },
      },
    },
  };
  return {
    ...hostStreamRpcRegistry,
    "epic.subscribe": plantedMethod,
  };
}

function plantedRecordRegistry(): UncheckedVersionedRecordRegistry {
  const dropped = defineRecordContract({
    name: "room-metadata",
    schemaVersion: { major: 1, minor: 1 } as const,
    schema: z.object({
      schemaVersion: z.string(),
    }),
  });
  const upgrade = defineRecordUpgradePath<
    typeof roomMetadataRecordV100,
    typeof dropped
  >({
    from: roomMetadataRecordV100.schemaVersion,
    to: dropped.schemaVersion,
    upgradeRecord: (record) => ({ schemaVersion: record.schemaVersion }),
  });
  return {
    ...persistenceRecordRegistry,
    "room-metadata": {
      1: {
        latestMinor: 1,
        versions: {
          0: {
            contract: roomMetadataRecordV100,
            upgradeFromPreviousVersion: null,
          },
          1: {
            contract: dropped,
            upgradeFromPreviousVersion: upgrade,
          },
        },
        downgradePathsFromLatest: {},
      },
    },
  };
}

function plantedUnaryEntry(): StaticRegistry {
  return {
    kind: "unary-rpc",
    name: "hostRpcRegistry",
    sourceFile: "src/host/registry.ts",
    registry: plantedUnaryRegistry(),
    floorMethodNames: RELEASED_FLOOR_METHOD_NAMES,
  };
}

function plantedStreamEntry(): StaticRegistry {
  return {
    kind: "stream-rpc",
    name: "hostStreamRpcRegistry",
    sourceFile: "src/host/registry.ts",
    registry: plantedStreamRegistry(),
  };
}

function plantedRecordEntry(): StaticRegistry {
  return {
    kind: "record",
    name: "persistenceRecordRegistry",
    sourceFile: "src/persistence/registry.ts",
    registry: plantedRecordRegistry(),
  };
}

describe("STATIC_REGISTRIES CI check", () => {
  it("names exactly the five static registries and they all pass full validation", () => {
    expect(STATIC_REGISTRIES.map((entry) => entry.name)).toEqual([
      ...STATIC_REGISTRY_NAMES,
    ]);
    expect(STATIC_REGISTRIES.map((entry) => entry.kind)).toEqual([
      "unary-rpc",
      "stream-rpc",
      "record",
      "record",
      "record",
    ]);
    expect(findStaticRegistryFailures(STATIC_REGISTRIES)).toEqual([]);
  });

  it("validateStaticRegistry succeeds on the live host unary entry (positive control)", () => {
    const hostUnary = STATIC_REGISTRIES.find(
      (entry) => entry.name === "hostRpcRegistry",
    );
    expect(hostUnary).toBeDefined();
    expect(() =>
      validateStaticRegistry(required(hostUnary, "hostRpcRegistry missing")),
    ).not.toThrow();
  });
});

describe("planted non-additive change, one per kind", () => {
  it("unary: swapping config.shell.listDetected 1.0/1.1 schemas fails full validation and not construction", () => {
    const planted = plantedUnaryRegistry();
    expect(() =>
      // @ts-expect-error the type-level validator rejects this deliberately invalid/widened registry; this asserts the runtime structural pass
      defineVersionedRpcRegistry(planted),
    ).not.toThrow();
    expect(() => validateVersionedRpcRegistry(planted)).toThrow(/wslHealth/);

    const failures = findStaticRegistryFailures(
      replaceNamedRegistry("hostRpcRegistry", plantedUnaryEntry()),
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]?.name).toBe("hostRpcRegistry");
    expect(failures[0]?.sourceFile).toBe("src/host/registry.ts");
    expect(failures[0]?.message).toMatch(/wslHealth/);
  });

  it("stream: swapping epic.subscribe 1.0/1.1 sub-schemas fails full validation and not construction", () => {
    const planted = plantedStreamRegistry();
    expect(() => defineVersionedStreamRpcRegistry(planted)).not.toThrow();
    expect(() => validateVersionedStreamRpcRegistry(planted)).toThrow(
      /dirtySnapshot\.kind/,
    );

    const failures = findStaticRegistryFailures(
      replaceNamedRegistry("hostStreamRpcRegistry", plantedStreamEntry()),
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]?.name).toBe("hostStreamRpcRegistry");
    expect(failures[0]?.sourceFile).toBe("src/host/registry.ts");
    expect(failures[0]?.message).toMatch(/dirtySnapshot\.kind/);
  });

  it("record: a synthetic room-metadata 1.1 that drops a 1.0 field fails full validation and not construction", () => {
    const planted = plantedRecordRegistry();
    expect(() =>
      // @ts-expect-error the type-level validator rejects this deliberately invalid/widened registry; this asserts the runtime structural pass
      defineVersionedRecordRegistry(planted),
    ).not.toThrow();
    expect(() => validateVersionedRecordRegistry(planted)).toThrow(
      /drops field/,
    );

    const failures = findStaticRegistryFailures(
      replaceNamedRegistry("persistenceRecordRegistry", plantedRecordEntry()),
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]?.name).toBe("persistenceRecordRegistry");
    expect(failures[0]?.sourceFile).toBe("src/persistence/registry.ts");
    expect(failures[0]?.message).toMatch(/drops field/);
  });
});

describe("floor-aware degrade check via validateStaticRegistry", () => {
  it("fails when a non-floor method's degrade is removed", () => {
    const planted: UncheckedVersionedRpcRegistry = {
      ...hostRpcRegistry,
      "config.shell.listDetected": {
        1: hostRpcRegistry["config.shell.listDetected"][1],
      },
    };
    const entry: StaticRegistry = {
      kind: "unary-rpc",
      name: "hostRpcRegistry",
      sourceFile: "src/host/registry.ts",
      registry: planted,
      floorMethodNames: RELEASED_FLOOR_METHOD_NAMES,
    };
    expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(
      "config.shell.listDetected",
    );
    expect(() => validateStaticRegistry(entry)).toThrow(
      /Non-floor method 'config\.shell\.listDetected' must declare a degrade strategy/,
    );
  });
});
