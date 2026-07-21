import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineDowngradePath,
  defineRpcContract,
  defineUpgradePath,
  downgradeRequestAcrossMajors,
  downgradeResponseAcrossMajors,
  toJsonSchemas,
  upgradeRequestToVersion,
  upgradeResponseToVersion,
  validateVersionedRpcRegistry,
  type JsonSchemaFingerprint,
  type ObjectJsonSchema,
  type UncheckedVersionedRpcRegistry,
} from "@traycer/protocol/framework/index";

function expectObjectFingerprint(
  fingerprint: JsonSchemaFingerprint,
): ObjectJsonSchema {
  if (fingerprint.type !== "object") {
    throw new Error(
      `Expected object fingerprint, got ${fingerprint.type} - fix the test fixture.`,
    );
  }
  return fingerprint;
}

// ---- Shared echo contract fixtures ------------------------------------- //

const echoV10 = defineRpcContract({
  method: "echo",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({
    text: z.string(),
  }),
  responseSchema: z.object({
    upper: z.string(),
  }),
});

const echoV11 = defineRpcContract({
  method: "echo",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: z.object({
    text: z.string(),
    trim: z.boolean(),
  }),
  responseSchema: z.object({
    upper: z.string(),
    trimmed: z.boolean(),
  }),
});

const echoV21 = defineRpcContract({
  method: "echo",
  schemaVersion: { major: 2, minor: 1 } as const,
  requestSchema: z.object({
    // Tightened vs echoV11 so the 1 -> 2 bump is a real breaking change.
    text: z.string().min(1),
    trim: z.boolean(),
    locale: z.string().nullable(),
  }),
  responseSchema: z.object({
    upper: z.string(),
    trimmed: z.boolean(),
    localeApplied: z.boolean(),
  }),
});

const echoV23 = defineRpcContract({
  method: "echo",
  schemaVersion: { major: 2, minor: 3 } as const,
  requestSchema: z.object({
    text: z.string().min(1),
    trim: z.boolean(),
    locale: z.string().nullable(),
    emphasis: z.boolean(),
  }),
  responseSchema: z.object({
    upper: z.string(),
    trimmed: z.boolean(),
    localeApplied: z.boolean(),
    decorated: z.boolean(),
  }),
});

const echoV30 = defineRpcContract({
  method: "echo",
  schemaVersion: { major: 3, minor: 0 } as const,
  requestSchema: z.object({
    text: z.string(),
    trim: z.boolean(),
    locale: z.string(),
    emphasis: z.boolean(),
  }),
  responseSchema: z.object({
    upper: z.string(),
    trimmed: z.boolean(),
    localeApplied: z.boolean(),
    decorated: z.boolean(),
    format: z.union([z.literal("plain"), z.literal("rich")]),
  }),
});

const upgradeV10ToV11 = defineUpgradePath<typeof echoV10, typeof echoV11>({
  from: echoV10.schemaVersion,
  to: echoV11.schemaVersion,
  upgradeRequest: (request) => ({
    text: request.text,
    trim: false,
  }),
  upgradeResponse: (response) => ({
    upper: response.upper,
    trimmed: false,
  }),
});

const upgradeV11ToV21 = defineUpgradePath<typeof echoV11, typeof echoV21>({
  from: echoV11.schemaVersion,
  to: echoV21.schemaVersion,
  upgradeRequest: (request) => ({
    text: request.text,
    trim: request.trim,
    locale: null,
  }),
  upgradeResponse: (response) => ({
    upper: response.upper,
    trimmed: response.trimmed,
    localeApplied: false,
  }),
});

const upgradeV21ToV23 = defineUpgradePath<typeof echoV21, typeof echoV23>({
  from: echoV21.schemaVersion,
  to: echoV23.schemaVersion,
  upgradeRequest: (request) => ({
    text: request.text,
    trim: request.trim,
    locale: request.locale,
    emphasis: false,
  }),
  upgradeResponse: (response) => ({
    upper: response.upper,
    trimmed: response.trimmed,
    localeApplied: response.localeApplied,
    decorated: false,
  }),
});

const upgradeV23ToV30 = defineUpgradePath<typeof echoV23, typeof echoV30>({
  from: echoV23.schemaVersion,
  to: echoV30.schemaVersion,
  upgradeRequest: (request) => ({
    text: request.text,
    trim: request.trim,
    locale: request.locale ?? "en",
    emphasis: request.emphasis,
  }),
  upgradeResponse: (response) => ({
    upper: response.upper,
    trimmed: response.trimmed,
    localeApplied: response.localeApplied,
    decorated: response.decorated,
    format: "plain",
  }),
});

const downgradeV23ToV11 = defineDowngradePath<typeof echoV23, typeof echoV11>({
  from: echoV23.schemaVersion,
  to: echoV11.schemaVersion,
  downgradeRequest: (request) => ({
    ok: true,
    value: {
      text: request.text,
      trim: request.trim,
    },
  }),
  downgradeResponse: (response) => ({
    ok: true,
    value: {
      upper: response.upper,
      trimmed: response.trimmed,
    },
  }),
});

const downgradeV30ToV23 = defineDowngradePath<typeof echoV30, typeof echoV23>({
  from: echoV30.schemaVersion,
  to: echoV23.schemaVersion,
  downgradeRequest: (request) => ({
    ok: true,
    value: {
      text: request.text,
      trim: request.trim,
      locale: request.locale,
      emphasis: request.emphasis,
    },
  }),
  downgradeResponse: (response) => ({
    ok: true,
    value: {
      upper: response.upper,
      trimmed: response.trimmed,
      localeApplied: response.localeApplied,
      decorated: response.decorated,
    },
  }),
});

function makeEchoRegistry() {
  const registry = {
    echo: {
      1: {
        latestMinor: 1,
        versions: {
          0: {
            contract: echoV10,
            upgradeFromPreviousVersion: null,
          },
          1: {
            contract: echoV11,
            upgradeFromPreviousVersion: upgradeV10ToV11,
          },
        },
        downgradePathsFromLatest: {},
      },
      2: {
        latestMinor: 3,
        versions: {
          1: {
            contract: echoV21,
            upgradeFromPreviousVersion: upgradeV11ToV21,
          },
          3: {
            contract: echoV23,
            upgradeFromPreviousVersion: upgradeV21ToV23,
          },
        },
        downgradePathsFromLatest: {
          1: downgradeV23ToV11,
        },
      },
      3: {
        latestMinor: 0,
        versions: {
          0: {
            contract: echoV30,
            upgradeFromPreviousVersion: upgradeV23ToV30,
          },
        },
        downgradePathsFromLatest: {
          2: downgradeV30ToV23,
        },
      },
    },
  } as const;

  validateVersionedRpcRegistry(registry);
  return registry;
}

// ---- toJsonSchemas ----------------------------------------------------- //

describe("toJsonSchemas", () => {
  it("converts every installed contract into an object JSON Schema view", () => {
    const schemas = toJsonSchemas(makeEchoRegistry());

    expect(Object.keys(schemas)).toEqual(["echo"]);
    expect(Object.keys(schemas.echo).map(Number).sort()).toEqual([1, 2, 3]);
    expect(Object.keys(schemas.echo[2]).map(Number).sort()).toEqual([1, 3]);

    for (const major of Object.keys(schemas.echo).map(Number)) {
      for (const minor of Object.keys(schemas.echo[major]).map(Number)) {
        const contract = schemas.echo[major][minor];
        const request = expectObjectFingerprint(contract.request);
        const response = expectObjectFingerprint(contract.response);
        expect(Object.keys(request.properties).length).toBeGreaterThan(0);
        expect(Object.keys(response.properties).length).toBeGreaterThan(0);
      }
    }
  });

  it("produces the expected field shape for the latest contract on the echo method", () => {
    const schemas = toJsonSchemas(makeEchoRegistry());
    const latest = schemas.echo[3][0];
    const request = expectObjectFingerprint(latest.request);
    const response = expectObjectFingerprint(latest.response);

    expect(Object.keys(request.properties).sort()).toEqual([
      "emphasis",
      "locale",
      "text",
      "trim",
    ]);
    expect([...request.required].sort()).toEqual([
      "emphasis",
      "locale",
      "text",
      "trim",
    ]);
    expect(Object.keys(response.properties).sort()).toEqual([
      "decorated",
      "format",
      "localeApplied",
      "trimmed",
      "upper",
    ]);
  });

  it("preserves Zod constraints (min/max, integer, enum, nullability) in the JSON Schema", () => {
    const searchV10 = defineRpcContract({
      method: "search",
      schemaVersion: { major: 1, minor: 0 } as const,
      requestSchema: z.object({
        query: z.string().min(2).max(50),
        limit: z.number().int().min(1).max(100),
        kind: z.enum(["code", "docs"]),
        tags: z.array(z.string()).max(10),
        locale: z.string().nullable(),
      }),
      responseSchema: z.object({
        results: z.array(z.string()),
        hasMore: z.boolean(),
      }),
    });

    const registry = {
      search: {
        1: {
          latestMinor: 0,
          versions: {
            0: {
              contract: searchV10,
              upgradeFromPreviousVersion: null,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    } as const;

    const schemas = toJsonSchemas(registry);
    const request = expectObjectFingerprint(schemas.search[1][0].request);

    expect(request.properties.query).toMatchObject({
      type: "string",
      minLength: 2,
      maxLength: 50,
    });
    expect(request.properties.limit).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 100,
    });
    expect(request.properties.kind).toMatchObject({
      type: "string",
      enum: ["code", "docs"],
    });
    expect(request.properties.tags).toMatchObject({
      type: "array",
      items: { type: "string" },
      maxItems: 10,
    });
    expect(request.properties.locale).toEqual({
      anyOf: [{ type: "string" }, { type: "null" }],
    });
  });

  it("rejects contracts whose schemas are not z.object()", () => {
    const registry: UncheckedVersionedRpcRegistry = {
      broken: {
        1: {
          latestMinor: 0,
          versions: {
            0: {
              contract: {
                method: "broken",
                schemaVersion: { major: 1, minor: 0 },
                requestSchema: z.string(),
                responseSchema: z.object({ ok: z.boolean() }),
              },
              upgradeFromPreviousVersion: null,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    };

    expect(() => toJsonSchemas(registry)).toThrow(
      /Unsupported schema.*broken 1\.0 request/,
    );
  });
});

// ---- validateVersionedRpcRegistry: Zod-level invariants ---------------- //
//
// The structural checks (method-key match, latestMinor, upgrade chain,
// downgrade bridges) are covered by versioned-rpc.test.ts. These cases pin
// the Zod-schema-level checks that sit in the second pass of the validator.

describe("validateVersionedRpcRegistry (Zod-level compatibility)", () => {
  it("accepts the echo fixture end-to-end", () => {
    expect(() =>
      validateVersionedRpcRegistry(makeEchoRegistry()),
    ).not.toThrow();
  });

  it("tolerates minors that widen a field's scope without dropping it", () => {
    const modeV10 = defineRpcContract({
      method: "mode",
      schemaVersion: { major: 1, minor: 0 } as const,
      requestSchema: z.object({ mode: z.enum(["fast", "slow"]) }),
      responseSchema: z.object({ accepted: z.boolean() }),
    });
    const modeV11 = defineRpcContract({
      method: "mode",
      schemaVersion: { major: 1, minor: 1 } as const,
      requestSchema: z.object({ mode: z.enum(["fast", "slow", "auto"]) }),
      responseSchema: z.object({ accepted: z.boolean() }),
    });
    const modeUpgrade = defineUpgradePath<typeof modeV10, typeof modeV11>({
      from: modeV10.schemaVersion,
      to: modeV11.schemaVersion,
      upgradeRequest: (request) => ({ mode: request.mode }),
      upgradeResponse: (response) => ({ accepted: response.accepted }),
    });

    const registry = {
      mode: {
        1: {
          latestMinor: 1,
          versions: {
            0: { contract: modeV10, upgradeFromPreviousVersion: null },
            1: { contract: modeV11, upgradeFromPreviousVersion: modeUpgrade },
          },
          downgradePathsFromLatest: {},
        },
      },
    } as const;

    expect(() => validateVersionedRpcRegistry(registry)).not.toThrow();
  });

  it("names the dropped field when a newer minor removes a request field from its predecessor", () => {
    const dropV10 = defineRpcContract({
      method: "drop",
      schemaVersion: { major: 1, minor: 0 } as const,
      requestSchema: z.object({ text: z.string(), trim: z.boolean() }),
      responseSchema: z.object({ upper: z.string() }),
    });
    const dropV11 = defineRpcContract({
      method: "drop",
      schemaVersion: { major: 1, minor: 1 } as const,
      requestSchema: z.object({ text: z.string() }),
      responseSchema: z.object({ upper: z.string() }),
    });
    const dropUpgrade = defineUpgradePath<typeof dropV10, typeof dropV11>({
      from: dropV10.schemaVersion,
      to: dropV11.schemaVersion,
      upgradeRequest: (request) => ({ text: request.text }),
      upgradeResponse: (response) => ({ upper: response.upper }),
    });

    const registry = {
      drop: {
        1: {
          latestMinor: 1,
          versions: {
            0: { contract: dropV10, upgradeFromPreviousVersion: null },
            1: { contract: dropV11, upgradeFromPreviousVersion: dropUpgrade },
          },
          downgradePathsFromLatest: {},
        },
      },
    } as const;

    expect(() => validateVersionedRpcRegistry(registry)).toThrow(
      "Minor 1.1 for method 'drop' request drops field 'trim' from 1.0",
    );
  });

  it("flags additive major bumps that could have shipped as a minor", () => {
    const additiveV10 = defineRpcContract({
      method: "additive",
      schemaVersion: { major: 1, minor: 0 } as const,
      requestSchema: z.object({ text: z.string() }),
      responseSchema: z.object({ ok: z.boolean() }),
    });
    const additiveV20 = defineRpcContract({
      method: "additive",
      schemaVersion: { major: 2, minor: 0 } as const,
      requestSchema: z.object({
        text: z.string(),
        extra: z.boolean().optional(),
      }),
      responseSchema: z.object({
        ok: z.boolean(),
        more: z.string().optional(),
      }),
    });
    const additiveUpgrade = defineUpgradePath<
      typeof additiveV10,
      typeof additiveV20
    >({
      from: additiveV10.schemaVersion,
      to: additiveV20.schemaVersion,
      upgradeRequest: (request) => ({ text: request.text, extra: false }),
      upgradeResponse: (response) => ({ ok: response.ok, more: "" }),
    });

    const registry = {
      additive: {
        1: {
          latestMinor: 0,
          versions: {
            0: { contract: additiveV10, upgradeFromPreviousVersion: null },
          },
          downgradePathsFromLatest: {},
        },
        2: {
          latestMinor: 0,
          versions: {
            0: {
              contract: additiveV20,
              upgradeFromPreviousVersion: additiveUpgrade,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    } as const;

    expect(() => validateVersionedRpcRegistry(registry)).toThrow(
      "Major bump 1 -> 2 for method 'additive' is not a breaking change (could have shipped as a minor)",
    );
  });

  it("accepts a major bump that adds a newly required field", () => {
    const requiredV10 = defineRpcContract({
      method: "required",
      schemaVersion: { major: 1, minor: 0 } as const,
      requestSchema: z.object({ text: z.string() }),
      responseSchema: z.object({ ok: z.boolean() }),
    });
    const requiredV20 = defineRpcContract({
      method: "required",
      schemaVersion: { major: 2, minor: 0 } as const,
      requestSchema: z.object({ text: z.string(), mode: z.string() }),
      responseSchema: z.object({ ok: z.boolean() }),
    });
    const requiredUpgrade = defineUpgradePath<
      typeof requiredV10,
      typeof requiredV20
    >({
      from: requiredV10.schemaVersion,
      to: requiredV20.schemaVersion,
      upgradeRequest: (request) => ({ ...request, mode: "legacy" }),
      upgradeResponse: (response) => response,
    });
    const registry = {
      required: {
        1: {
          latestMinor: 0,
          versions: {
            0: { contract: requiredV10, upgradeFromPreviousVersion: null },
          },
          downgradePathsFromLatest: {},
        },
        2: {
          latestMinor: 0,
          versions: {
            0: {
              contract: requiredV20,
              upgradeFromPreviousVersion: requiredUpgrade,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    } as const;

    expect(() => validateVersionedRpcRegistry(registry)).not.toThrow();
  });

  it("accepts major bumps that narrow a previously-nullable field", () => {
    const narrowV10 = defineRpcContract({
      method: "narrow",
      schemaVersion: { major: 1, minor: 0 } as const,
      requestSchema: z.object({ locale: z.string().nullable() }),
      responseSchema: z.object({ ok: z.boolean() }),
    });
    const narrowV20 = defineRpcContract({
      method: "narrow",
      schemaVersion: { major: 2, minor: 0 } as const,
      requestSchema: z.object({ locale: z.string() }),
      responseSchema: z.object({ ok: z.boolean() }),
    });
    const narrowUpgrade = defineUpgradePath<typeof narrowV10, typeof narrowV20>(
      {
        from: narrowV10.schemaVersion,
        to: narrowV20.schemaVersion,
        upgradeRequest: (request) => ({ locale: request.locale ?? "en" }),
        upgradeResponse: (response) => ({ ok: response.ok }),
      },
    );

    const registry = {
      narrow: {
        1: {
          latestMinor: 0,
          versions: {
            0: { contract: narrowV10, upgradeFromPreviousVersion: null },
          },
          downgradePathsFromLatest: {},
        },
        2: {
          latestMinor: 0,
          versions: {
            0: {
              contract: narrowV20,
              upgradeFromPreviousVersion: narrowUpgrade,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    } as const;

    expect(() => validateVersionedRpcRegistry(registry)).not.toThrow();
  });

  it("accepts major bumps that remove a field", () => {
    const removeV10 = defineRpcContract({
      method: "remove",
      schemaVersion: { major: 1, minor: 0 } as const,
      requestSchema: z.object({ text: z.string(), legacy: z.boolean() }),
      responseSchema: z.object({ ok: z.boolean() }),
    });
    const removeV20 = defineRpcContract({
      method: "remove",
      schemaVersion: { major: 2, minor: 0 } as const,
      requestSchema: z.object({ text: z.string() }),
      responseSchema: z.object({ ok: z.boolean() }),
    });
    const removeUpgrade = defineUpgradePath<typeof removeV10, typeof removeV20>(
      {
        from: removeV10.schemaVersion,
        to: removeV20.schemaVersion,
        upgradeRequest: (request) => ({ text: request.text }),
        upgradeResponse: (response) => ({ ok: response.ok }),
      },
    );

    const registry = {
      remove: {
        1: {
          latestMinor: 0,
          versions: {
            0: { contract: removeV10, upgradeFromPreviousVersion: null },
          },
          downgradePathsFromLatest: {},
        },
        2: {
          latestMinor: 0,
          versions: {
            0: {
              contract: removeV20,
              upgradeFromPreviousVersion: removeUpgrade,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    } as const;

    expect(() => validateVersionedRpcRegistry(registry)).not.toThrow();
  });
});

// ---- Traversal round-trips with Zod validation ------------------------- //

describe("Traversal produces values that parse against the target contract", () => {
  it("produces an upgraded request that validates against the target contract's Zod schema", () => {
    const registry = makeEchoRegistry();

    const upgraded = upgradeRequestToVersion(
      registry.echo,
      { major: 1, minor: 0 },
      { major: 3, minor: 0 },
      { text: "hello" },
    );

    expect(() => echoV30.requestSchema.parse(upgraded)).not.toThrow();
  });

  it("produces an upgraded response that validates against the target contract's Zod schema", () => {
    const registry = makeEchoRegistry();

    const upgraded = upgradeResponseToVersion(
      registry.echo,
      { major: 1, minor: 0 },
      { major: 2, minor: 3 },
      { upper: "HELLO" },
    );

    expect(() => echoV23.responseSchema.parse(upgraded)).not.toThrow();
  });

  it("produces a downgraded request that validates against the target major's latest Zod schema", () => {
    const registry = makeEchoRegistry();

    const downgraded = downgradeRequestAcrossMajors(registry.echo, 3, 2, {
      text: "hello",
      trim: true,
      locale: "en",
      emphasis: false,
    });

    expect(downgraded.ok).toBe(true);
    if (!downgraded.ok) {
      return;
    }

    expect(() => echoV23.requestSchema.parse(downgraded.value)).not.toThrow();
  });

  it("produces a downgraded response that validates against the target major's latest Zod schema", () => {
    const registry = makeEchoRegistry();

    const downgraded = downgradeResponseAcrossMajors(registry.echo, 2, 1, {
      upper: "HELLO",
      trimmed: true,
      localeApplied: true,
      decorated: true,
    });

    expect(downgraded.ok).toBe(true);
    if (!downgraded.ok) {
      return;
    }

    expect(() => echoV11.responseSchema.parse(downgraded.value)).not.toThrow();
  });

  it("reports DOWNGRADE_UNSUPPORTED when no direct path exists instead of chaining through intermediates", () => {
    const registry = makeEchoRegistry();

    const downgraded = downgradeRequestAcrossMajors(registry.echo, 3, 1, {
      text: "hello",
      trim: true,
      locale: "en",
      emphasis: false,
    });

    expect(downgraded).toEqual({
      ok: false,
      error: {
        code: "DOWNGRADE_UNSUPPORTED",
        message: "No direct downgrade path exists from major 3 to major 1",
      },
    });
  });
});
