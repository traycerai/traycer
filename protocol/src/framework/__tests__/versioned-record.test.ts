import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineRecordContract,
  defineRecordUpgradePath,
  defineVersionedRecordRegistry,
  getRecordSchema,
  loadRecord,
  parseRecord,
  toRecordJsonSchemas,
  validateVersionedRecordRegistry,
} from "@traycer/protocol/framework/index";

/**
 * Coverage for the generalized record framework: enum and union schemas
 * (in addition to the existing z.object support), plus the three
 * registry-driven helpers that codify the privacy-boundary entry points
 * (getRecordSchema with optional version, parseRecord, loadRecord).
 */

const objectV100 = defineRecordContract({
  name: "object-record",
  schemaVersion: { major: 1, minor: 0 } as const,
  schema: z.object({
    id: z.string(),
    label: z.string(),
  }),
});

const enumV100 = defineRecordContract({
  name: "role-record",
  schemaVersion: { major: 1, minor: 0 } as const,
  schema: z.enum(["owner", "editor", "viewer"]),
});

const unionV100 = defineRecordContract({
  name: "shape-record",
  schemaVersion: { major: 1, minor: 0 } as const,
  schema: z.union([
    z.object({ kind: z.literal("circle"), radius: z.number() }),
    z.object({ kind: z.literal("square"), side: z.number() }),
  ]),
});

describe("versioned-record framework - non-object schemas", () => {
  it("registers an enum record", () => {
    expect(() =>
      defineVersionedRecordRegistry({
        "role-record": {
          1: {
            latestMinor: 0,
            versions: {
              0: { contract: enumV100, upgradeFromPreviousVersion: null },
            },
            downgradePathsFromLatest: {},
          },
        },
      }),
    ).not.toThrow();
  });

  it("registers a union record", () => {
    expect(() =>
      defineVersionedRecordRegistry({
        "shape-record": {
          1: {
            latestMinor: 0,
            versions: {
              0: { contract: unionV100, upgradeFromPreviousVersion: null },
            },
            downgradePathsFromLatest: {},
          },
        },
      }),
    ).not.toThrow();
  });

  it("rejects an opaque schema (no object/enum/anyOf shape)", () => {
    const opaque = defineRecordContract({
      name: "opaque-record",
      schemaVersion: { major: 1, minor: 0 } as const,
      schema: z.unknown(),
    });

    expect(() =>
      defineVersionedRecordRegistry({
        "opaque-record": {
          1: {
            latestMinor: 0,
            versions: {
              0: { contract: opaque, upgradeFromPreviousVersion: null },
            },
            downgradePathsFromLatest: {},
          },
        },
      }),
    ).toThrow(/Unsupported schema/);
  });
});

describe("versioned-record framework - minor additivity", () => {
  it("allows adding an enum value across minors", () => {
    const enumV101 = defineRecordContract({
      name: "role-record",
      schemaVersion: { major: 1, minor: 1 } as const,
      schema: z.enum(["owner", "editor", "viewer", "guest"]),
    });

    const registry = {
      "role-record": {
        1: {
          latestMinor: 1,
          versions: {
            0: { contract: enumV100, upgradeFromPreviousVersion: null },
            1: {
              contract: enumV101,
              upgradeFromPreviousVersion: {
                from: enumV100.schemaVersion,
                to: enumV101.schemaVersion,
                upgradeRecord: (record: z.infer<typeof enumV100.schema>) =>
                  record,
              },
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    };

    expect(() => validateVersionedRecordRegistry(registry)).not.toThrow();
  });

  it("rejects removing an enum value across minors", () => {
    const enumV101 = defineRecordContract({
      name: "role-record",
      schemaVersion: { major: 1, minor: 1 } as const,
      schema: z.enum(["owner", "editor"]),
    });

    const registry = {
      "role-record": {
        1: {
          latestMinor: 1,
          versions: {
            0: { contract: enumV100, upgradeFromPreviousVersion: null },
            1: {
              contract: enumV101,
              upgradeFromPreviousVersion: {
                from: enumV100.schemaVersion,
                to: enumV101.schemaVersion,
                upgradeRecord: (record: z.infer<typeof enumV100.schema>) =>
                  record === "viewer" ? "editor" : record,
              },
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    };

    expect(() => validateVersionedRecordRegistry(registry)).toThrow(
      /drops enum value 'viewer'/,
    );
  });

  it("rejects removing a union variant across minors", () => {
    const unionV101 = defineRecordContract({
      name: "shape-record",
      schemaVersion: { major: 1, minor: 1 } as const,
      schema: z.union([
        z.object({ kind: z.literal("circle"), radius: z.number() }),
      ]),
    });

    const registry = {
      "shape-record": {
        1: {
          latestMinor: 1,
          versions: {
            0: { contract: unionV100, upgradeFromPreviousVersion: null },
            1: {
              contract: unionV101,
              upgradeFromPreviousVersion: {
                from: unionV100.schemaVersion,
                to: unionV101.schemaVersion,
                upgradeRecord: () => ({ kind: "circle" as const, radius: 0 }),
              },
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    };

    expect(() => validateVersionedRecordRegistry(registry)).toThrow(
      /drops union variant/,
    );
  });
});

describe("versioned-record framework - major bumps", () => {
  it("requires a breaking change on enum major bump", () => {
    const enumV200 = defineRecordContract({
      name: "role-record",
      schemaVersion: { major: 2, minor: 0 } as const,
      schema: z.enum(["owner", "editor", "viewer"]),
    });

    const registry = {
      "role-record": {
        1: {
          latestMinor: 0,
          versions: {
            0: { contract: enumV100, upgradeFromPreviousVersion: null },
          },
          downgradePathsFromLatest: {},
        },
        2: {
          latestMinor: 0,
          versions: {
            0: {
              contract: enumV200,
              upgradeFromPreviousVersion: {
                from: enumV100.schemaVersion,
                to: enumV200.schemaVersion,
                upgradeRecord: (record: z.infer<typeof enumV100.schema>) =>
                  record,
              },
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    };

    expect(() => validateVersionedRecordRegistry(registry)).toThrow(
      /is not a breaking change/,
    );
  });

  it("accepts a major bump that drops an enum value", () => {
    const enumV200 = defineRecordContract({
      name: "role-record",
      schemaVersion: { major: 2, minor: 0 } as const,
      schema: z.enum(["owner", "editor"]),
    });

    const registry = {
      "role-record": {
        1: {
          latestMinor: 0,
          versions: {
            0: { contract: enumV100, upgradeFromPreviousVersion: null },
          },
          downgradePathsFromLatest: {},
        },
        2: {
          latestMinor: 0,
          versions: {
            0: {
              contract: enumV200,
              upgradeFromPreviousVersion: {
                from: enumV100.schemaVersion,
                to: enumV200.schemaVersion,
                upgradeRecord: (record: z.infer<typeof enumV100.schema>) =>
                  record === "viewer" ? "editor" : record,
              },
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    };

    expect(() => validateVersionedRecordRegistry(registry)).not.toThrow();
  });
});

describe("versioned-record framework - registry helpers", () => {
  const registry = defineVersionedRecordRegistry({
    "object-record": {
      1: {
        latestMinor: 0,
        versions: {
          0: { contract: objectV100, upgradeFromPreviousVersion: null },
        },
        downgradePathsFromLatest: {},
      },
    },
    "role-record": {
      1: {
        latestMinor: 0,
        versions: {
          0: { contract: enumV100, upgradeFromPreviousVersion: null },
        },
        downgradePathsFromLatest: {},
      },
    },
  });

  it("getRecordSchema returns the latest installed schema", () => {
    const schema = getRecordSchema(registry, "object-record", "latest");
    expect(() => schema.parse({ id: "x", label: "y" })).not.toThrow();
  });

  it("getRecordSchema returns the schema for a specific version", () => {
    const schema = getRecordSchema(registry, "role-record", {
      major: 1,
      minor: 0,
    });
    expect(schema.parse("owner")).toBe("owner");
  });

  it("getRecordSchema throws for an undefined version", () => {
    expect(() =>
      getRecordSchema(registry, "role-record", { major: 9, minor: 0 }),
    ).toThrow(/Major 9 is not defined/);
  });

  it("parseRecord parses against the latest installed schema", () => {
    const parsed = parseRecord(registry, "object-record", {
      id: "x",
      label: "y",
    });
    expect(parsed).toEqual({ id: "x", label: "y" });
  });

  it("parseRecord throws on invalid data", () => {
    expect(() => parseRecord(registry, "role-record", "stranger")).toThrow();
  });
});

describe("versioned-record framework - loadRecord (parse + migrate)", () => {
  const objV100 = defineRecordContract({
    name: "obj",
    schemaVersion: { major: 1, minor: 0 } as const,
    schema: z.object({ id: z.string() }),
  });

  const objV101 = defineRecordContract({
    name: "obj",
    schemaVersion: { major: 1, minor: 1 } as const,
    schema: z.object({ id: z.string(), label: z.string() }),
  });

  const upgradeV100ToV101 = defineRecordUpgradePath<
    typeof objV100,
    typeof objV101
  >({
    from: objV100.schemaVersion,
    to: objV101.schemaVersion,
    upgradeRecord: (record) => ({ ...record, label: "" }),
  });

  const registry = defineVersionedRecordRegistry({
    obj: {
      1: {
        latestMinor: 1,
        versions: {
          0: { contract: objV100, upgradeFromPreviousVersion: null },
          1: {
            contract: objV101,
            upgradeFromPreviousVersion: upgradeV100ToV101,
          },
        },
        downgradePathsFromLatest: {},
      },
    },
  });

  it("loadRecord parses against the historical schema and migrates to latest", () => {
    const parsed = loadRecord(registry, "obj", { id: "x" }, {
      major: 1,
      minor: 0,
    });
    expect(parsed).toEqual({ id: "x", label: "" });
  });

  it("loadRecord throws when fromVersion is not installed", () => {
    expect(() =>
      loadRecord(registry, "obj", { id: "x" }, { major: 9, minor: 0 }),
    ).toThrow(/Major 9 is not defined/);
  });

  it("loadRecord throws on data that does not match the historical schema", () => {
    expect(() =>
      loadRecord(registry, "obj", { unrelated: true }, {
        major: 1,
        minor: 0,
      }),
    ).toThrow();
  });
});

describe("versioned-record framework - toRecordJsonSchemas fingerprints", () => {
  const registry = defineVersionedRecordRegistry({
    "object-record": {
      1: {
        latestMinor: 0,
        versions: {
          0: { contract: objectV100, upgradeFromPreviousVersion: null },
        },
        downgradePathsFromLatest: {},
      },
    },
    "role-record": {
      1: {
        latestMinor: 0,
        versions: {
          0: { contract: enumV100, upgradeFromPreviousVersion: null },
        },
        downgradePathsFromLatest: {},
      },
    },
    "shape-record": {
      1: {
        latestMinor: 0,
        versions: {
          0: { contract: unionV100, upgradeFromPreviousVersion: null },
        },
        downgradePathsFromLatest: {},
      },
    },
  });

  it("fingerprints object schemas with type 'object'", () => {
    const fingerprints = toRecordJsonSchemas(registry);
    expect(fingerprints["object-record"][1][0].type).toBe("object");
  });

  it("fingerprints enum schemas with type 'enum'", () => {
    const fingerprints = toRecordJsonSchemas(registry);
    const fingerprint = fingerprints["role-record"][1][0];
    expect(fingerprint.type).toBe("enum");
    if (fingerprint.type === "enum") {
      expect(fingerprint.values).toEqual(["owner", "editor", "viewer"]);
      expect(fingerprint.representation).toBe("string");
    }
  });

  it("fingerprints union schemas with type 'anyOf'", () => {
    const fingerprints = toRecordJsonSchemas(registry);
    const fingerprint = fingerprints["shape-record"][1][0];
    expect(fingerprint.type).toBe("anyOf");
    if (fingerprint.type === "anyOf") {
      expect(fingerprint.variants).toHaveLength(2);
    }
  });
});
