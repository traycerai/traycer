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

  it("allows a schema-compatible major when the registry declares a semantic break", () => {
    const localV10 = defineRpcContract({
      method: "semanticAuthority",
      schemaVersion: { major: 1, minor: 0 } as const,
      requestSchema: z.object({ terminalId: z.string() }),
      responseSchema: z.object({ ok: z.boolean() }),
    });
    const fleetV20 = defineRpcContract({
      method: "semanticAuthority",
      schemaVersion: { major: 2, minor: 0 } as const,
      requestSchema: z.object({ terminalId: z.string() }),
      responseSchema: z.object({ ok: z.boolean() }),
    });
    const upgrade = defineUpgradePath<typeof localV10, typeof fleetV20>({
      from: localV10.schemaVersion,
      to: fleetV20.schemaVersion,
      upgradeRequest: (request) => request,
      upgradeResponse: (response) => response,
    });

    const registry = {
      semanticAuthority: {
        1: {
          latestMinor: 0,
          versions: {
            0: { contract: localV10, upgradeFromPreviousVersion: null },
          },
          downgradePathsFromLatest: {},
        },
        2: {
          latestMinor: 0,
          versions: {
            0: {
              contract: fleetV20,
              upgradeFromPreviousVersion: upgrade,
              semanticMajorBreakFromPreviousMajor: true,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    } as const;

    expect(() => validateVersionedRpcRegistry(registry)).not.toThrow();
  });

  it("reads a semantic-major annotation from the first installed minor", () => {
    const localV10 = defineRpcContract({
      method: "evolvingSemanticAuthority",
      schemaVersion: { major: 1, minor: 0 } as const,
      requestSchema: z.object({ terminalId: z.string() }),
      responseSchema: z.object({ ok: z.boolean() }),
    });
    const fleetV20 = defineRpcContract({
      method: "evolvingSemanticAuthority",
      schemaVersion: { major: 2, minor: 0 } as const,
      requestSchema: z.object({ terminalId: z.string() }),
      responseSchema: z.object({ ok: z.boolean() }),
    });
    const fleetV21 = defineRpcContract({
      method: "evolvingSemanticAuthority",
      schemaVersion: { major: 2, minor: 1 } as const,
      requestSchema: z.object({
        terminalId: z.string(),
        includeRuntime: z.boolean().optional(),
      }),
      responseSchema: z.object({
        ok: z.boolean(),
        runtimeKnown: z.boolean().optional(),
      }),
    });
    const upgradeToV20 = defineUpgradePath<typeof localV10, typeof fleetV20>({
      from: localV10.schemaVersion,
      to: fleetV20.schemaVersion,
      upgradeRequest: (request) => request,
      upgradeResponse: (response) => response,
    });
    const upgradeToV21 = defineUpgradePath<typeof fleetV20, typeof fleetV21>({
      from: fleetV20.schemaVersion,
      to: fleetV21.schemaVersion,
      upgradeRequest: (request) => request,
      upgradeResponse: (response) => response,
    });

    const registry = {
      evolvingSemanticAuthority: {
        1: {
          latestMinor: 0,
          versions: {
            0: { contract: localV10, upgradeFromPreviousVersion: null },
          },
          downgradePathsFromLatest: {},
        },
        2: {
          latestMinor: 1,
          versions: {
            0: {
              contract: fleetV20,
              upgradeFromPreviousVersion: upgradeToV20,
              semanticMajorBreakFromPreviousMajor: true,
            },
            1: {
              contract: fleetV21,
              upgradeFromPreviousVersion: upgradeToV21,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    } as const;

    expect(() => validateVersionedRpcRegistry(registry)).not.toThrow();
  });

  it("rejects a semantic-major annotation on a later minor", () => {
    const localV10 = defineRpcContract({
      method: "misplacedSemanticAuthority",
      schemaVersion: { major: 1, minor: 0 } as const,
      requestSchema: z.object({ terminalId: z.string() }),
      responseSchema: z.object({ ok: z.boolean() }),
    });
    const fleetV20 = defineRpcContract({
      method: "misplacedSemanticAuthority",
      schemaVersion: { major: 2, minor: 0 } as const,
      requestSchema: z.object({ terminalId: z.string() }),
      responseSchema: z.object({ ok: z.boolean() }),
    });
    const fleetV21 = defineRpcContract({
      method: "misplacedSemanticAuthority",
      schemaVersion: { major: 2, minor: 1 } as const,
      requestSchema: z.object({
        terminalId: z.string(),
        includeRuntime: z.boolean().optional(),
      }),
      responseSchema: z.object({
        ok: z.boolean(),
        runtimeKnown: z.boolean().optional(),
      }),
    });

    const registry = {
      misplacedSemanticAuthority: {
        1: {
          latestMinor: 0,
          versions: {
            0: { contract: localV10, upgradeFromPreviousVersion: null },
          },
          downgradePathsFromLatest: {},
        },
        2: {
          latestMinor: 1,
          versions: {
            0: {
              contract: fleetV20,
              upgradeFromPreviousVersion: defineUpgradePath<
                typeof localV10,
                typeof fleetV20
              >({
                from: localV10.schemaVersion,
                to: fleetV20.schemaVersion,
                upgradeRequest: (request) => request,
                upgradeResponse: (response) => response,
              }),
            },
            1: {
              contract: fleetV21,
              upgradeFromPreviousVersion: defineUpgradePath<
                typeof fleetV20,
                typeof fleetV21
              >({
                from: fleetV20.schemaVersion,
                to: fleetV21.schemaVersion,
                upgradeRequest: (request) => request,
                upgradeResponse: (response) => response,
              }),
              semanticMajorBreakFromPreviousMajor: true,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    } as const;

    expect(() => validateVersionedRpcRegistry(registry)).toThrow(
      "the annotation must be on the first installed minor 2.0",
    );
  });

  it("rejects a semantic-major annotation on the first installed major", () => {
    const registry = {
      semanticAuthority: {
        1: {
          latestMinor: 0,
          versions: {
            0: {
              contract: defineRpcContract({
                method: "semanticAuthority",
                schemaVersion: { major: 1, minor: 0 } as const,
                requestSchema: z.object({ terminalId: z.string() }),
                responseSchema: z.object({ ok: z.boolean() }),
              }),
              upgradeFromPreviousVersion: null,
              semanticMajorBreakFromPreviousMajor: true,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    } as const;

    expect(() => validateVersionedRpcRegistry(registry)).toThrow(
      "there is no previous installed major",
    );
  });

  it("rejects a semantic-major annotation when the schemas already break structurally", () => {
    const localV10 = defineRpcContract({
      method: "structuralAuthority",
      schemaVersion: { major: 1, minor: 0 } as const,
      requestSchema: z.object({ terminalId: z.string() }),
      responseSchema: z.object({ ok: z.boolean() }),
    });
    const fleetV20 = defineRpcContract({
      method: "structuralAuthority",
      schemaVersion: { major: 2, minor: 0 } as const,
      requestSchema: z.object({ terminalId: z.string(), hostId: z.string() }),
      responseSchema: z.object({ ok: z.boolean(), revision: z.number() }),
    });
    const registry = {
      structuralAuthority: {
        1: {
          latestMinor: 0,
          versions: {
            0: { contract: localV10, upgradeFromPreviousVersion: null },
          },
          downgradePathsFromLatest: {},
        },
        2: {
          latestMinor: 0,
          versions: {
            0: {
              contract: fleetV20,
              upgradeFromPreviousVersion: defineUpgradePath<
                typeof localV10,
                typeof fleetV20
              >({
                from: localV10.schemaVersion,
                to: fleetV20.schemaVersion,
                upgradeRequest: (request) => ({
                  ...request,
                  hostId: "host-1",
                }),
                upgradeResponse: (response) => ({ ...response, revision: 0 }),
              }),
              semanticMajorBreakFromPreviousMajor: true,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    } as const;

    expect(() => validateVersionedRpcRegistry(registry)).toThrow(
      "already has a structural breaking change",
    );
  });

  it("does not let the discriminator STAMP alone justify a major bump", () => {
    // `x-traycer-discriminator` is metadata this framework writes onto the
    // emitted schema so arm identity can be resolved; it constrains no value.
    // A union that merely moves its declaration between two equally valid tag
    // columns accepts and emits byte-identical JSON - so it is NOT a breaking
    // change, and the major must still be rejected as "could have shipped as a
    // minor". Compared raw, the stamp differs and would have justified a major
    // on our own bookkeeping.
    const stampV10 = defineRpcContract({
      method: "stampOnly",
      schemaVersion: { major: 1, minor: 0 } as const,
      requestSchema: z.object({ id: z.string() }),
      responseSchema: z.object({
        row: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("a"), outcome: z.literal("x") }),
          z.object({ kind: z.literal("b"), outcome: z.literal("y") }),
        ]),
      }),
    });
    const stampV20 = defineRpcContract({
      method: "stampOnly",
      schemaVersion: { major: 2, minor: 0 } as const,
      requestSchema: z.object({ id: z.string() }),
      responseSchema: z.object({
        // Identical arms; only the DECLARED column moved. `outcome` is just as
        // valid a tag here - each arm pins it to its own literal.
        row: z.discriminatedUnion("outcome", [
          z.object({ kind: z.literal("a"), outcome: z.literal("x") }),
          z.object({ kind: z.literal("b"), outcome: z.literal("y") }),
        ]),
      }),
    });
    const stampUpgrade = defineUpgradePath<typeof stampV10, typeof stampV20>({
      from: stampV10.schemaVersion,
      to: stampV20.schemaVersion,
      upgradeRequest: (request) => ({ id: request.id }),
      upgradeResponse: (response) => ({ row: response.row }),
    });
    const registry = {
      stampOnly: {
        1: {
          latestMinor: 0,
          versions: {
            0: { contract: stampV10, upgradeFromPreviousVersion: null },
          },
          downgradePathsFromLatest: {},
        },
        2: {
          latestMinor: 0,
          versions: {
            0: {
              contract: stampV20,
              upgradeFromPreviousVersion: stampUpgrade,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    } as const;

    expect(() => validateVersionedRpcRegistry(registry)).toThrow(
      "Major bump 1 -> 2 for method 'stampOnly' is not a breaking change (could have shipped as a minor)",
    );
  });

  it("still justifies a major from a keyword that is annotation-only for a LEAF", () => {
    // The mirror of the arm above, and the reason the stamp is stripped by
    // itself rather than through `constrainingShape`. That helper drops all of
    // `NON_CONSTRAINING_SCHEMA_KEYS`, which answers a different question - what
    // constrains a LEAF's accepted values in the additivity walk - and `default`
    // sits in it. `.catch([])` renders as `default`, so dropping the catch turns
    // a payload that used to parse into one that fails outright. Strip it here
    // and this real major reads as "could have shipped as a minor".
    const catchV10 = defineRpcContract({
      method: "catchTolerance",
      schemaVersion: { major: 1, minor: 0 } as const,
      requestSchema: z.object({ id: z.string() }),
      responseSchema: z.object({
        tags: z.array(z.string()).catch([]),
      }),
    });
    const catchV20 = defineRpcContract({
      method: "catchTolerance",
      schemaVersion: { major: 2, minor: 0 } as const,
      requestSchema: z.object({ id: z.string() }),
      responseSchema: z.object({
        // The ONLY change: the tolerance is gone.
        tags: z.array(z.string()),
      }),
    });
    const catchUpgrade = defineUpgradePath<typeof catchV10, typeof catchV20>({
      from: catchV10.schemaVersion,
      to: catchV20.schemaVersion,
      upgradeRequest: (request) => ({ id: request.id }),
      upgradeResponse: (response) => ({ tags: response.tags }),
    });
    const registry = {
      catchTolerance: {
        1: {
          latestMinor: 0,
          versions: {
            0: { contract: catchV10, upgradeFromPreviousVersion: null },
          },
          downgradePathsFromLatest: {},
        },
        2: {
          latestMinor: 0,
          versions: {
            0: {
              contract: catchV20,
              upgradeFromPreviousVersion: catchUpgrade,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    } as const;

    expect(() => validateVersionedRpcRegistry(registry)).not.toThrow();
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

describe("response-lane value-growth strictness", () => {
  const growV10 = defineRpcContract({
    method: "grow",
    schemaVersion: { major: 1, minor: 0 } as const,
    requestSchema: z.object({ id: z.string() }),
    responseSchema: z.object({ status: z.enum(["queued"]) }),
  });
  const growV11 = defineRpcContract({
    method: "grow",
    schemaVersion: { major: 1, minor: 1 } as const,
    requestSchema: z.object({ id: z.string() }),
    responseSchema: z.object({ status: z.enum(["queued", "running"]) }),
  });
  const growUpgrade = defineUpgradePath<typeof growV10, typeof growV11>({
    from: growV10.schemaVersion,
    to: growV11.schemaVersion,
    upgradeRequest: (request) => ({ id: request.id }),
    upgradeResponse: (response) => ({ status: response.status }),
  });
  const replaceV10 = defineRpcContract({
    method: "replace",
    schemaVersion: { major: 1, minor: 0 } as const,
    requestSchema: z.object({ id: z.string() }),
    responseSchema: z.object({
      row: z.union([z.object({ legacy: z.string() }), z.null()]),
    }),
  });
  const replaceV11 = defineRpcContract({
    method: "replace",
    schemaVersion: { major: 1, minor: 1 } as const,
    requestSchema: z.object({ id: z.string() }),
    responseSchema: z.object({
      row: z.discriminatedUnion("status", [
        z.object({ status: z.literal("found"), value: z.string() }),
        z.object({ status: z.literal("absent") }),
      ]),
    }),
  });
  const replaceUpgrade = defineUpgradePath<
    typeof replaceV10,
    typeof replaceV11
  >({
    from: replaceV10.schemaVersion,
    to: replaceV11.schemaVersion,
    upgradeRequest: (request) => ({ id: request.id }),
    upgradeResponse: (response) => ({
      row:
        response.row === null
          ? { status: "absent" as const }
          : { status: "found" as const, value: response.row.legacy },
    }),
  });

  it("rejects response enum growth on an unannotated minor, naming the escape hatch", () => {
    const registry = {
      grow: {
        1: {
          latestMinor: 1,
          versions: {
            0: { contract: growV10, upgradeFromPreviousVersion: null },
            1: { contract: growV11, upgradeFromPreviousVersion: growUpgrade },
          },
          downgradePathsFromLatest: {},
        },
      },
    } as const;

    expect(() => validateVersionedRpcRegistry(registry)).toThrow(
      "Minor 1.1 for method 'grow' response adds enum value 'running' from 1.0 (if this growth is genuinely emission-gated on the negotiated version, declare `responseGrowthProjectionGated: true` on the minor's registry entry)",
    );
  });

  it("accepts the same growth when the minor declares it projection-gated", () => {
    const registry = {
      grow: {
        1: {
          latestMinor: 1,
          versions: {
            0: { contract: growV10, upgradeFromPreviousVersion: null },
            1: {
              contract: growV11,
              upgradeFromPreviousVersion: growUpgrade,
              responseGrowthProjectionGated: true,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    } as const;

    expect(() => validateVersionedRpcRegistry(registry)).not.toThrow();
  });

  it("accepts a projection-gated response union replacement", () => {
    const registry = {
      replace: {
        1: {
          latestMinor: 1,
          versions: {
            0: { contract: replaceV10, upgradeFromPreviousVersion: null },
            1: {
              contract: replaceV11,
              upgradeFromPreviousVersion: replaceUpgrade,
              responseGrowthProjectionGated: true,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    } as const;

    expect(() => validateVersionedRpcRegistry(registry)).not.toThrow();
  });

  it("rejects a response union replacement without the projection gate", () => {
    const registry = {
      replace: {
        1: {
          latestMinor: 1,
          versions: {
            0: { contract: replaceV10, upgradeFromPreviousVersion: null },
            1: {
              contract: replaceV11,
              upgradeFromPreviousVersion: replaceUpgrade,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    } as const;

    expect(() => validateVersionedRpcRegistry(registry)).toThrow(
      "Minor 1.1 for method 'replace' response drops union variant",
    );
  });

  it("rejects a projection-gated minor that REDUCES a surviving union arm", () => {
    // The hole this closes: the survival loop can only answer "is any next
    // variant compatible", and every NO used to be classified as an arm
    // REPLACEMENT - exempt under `responseGrowthProjectionGated`. So a
    // reduction made INSIDE an arm was found by the recursive comparison and
    // then swallowed, and the gate accepted a breaking response change as
    // long as it happened within a union.
    //
    // `found` here keeps its discriminant across the minor and loses a
    // required field. Nothing about it was replaced: an old peer projecting a
    // `{status:"found"}` payload still expects `value`, and does not get it.
    const reduceArmV10 = defineRpcContract({
      method: "reduceArm",
      schemaVersion: { major: 1, minor: 0 } as const,
      requestSchema: z.object({ id: z.string() }),
      responseSchema: z.object({
        row: z.discriminatedUnion("status", [
          z.object({ status: z.literal("found"), value: z.string() }),
          z.object({ status: z.literal("absent") }),
        ]),
      }),
    });
    const reduceArmV11 = defineRpcContract({
      method: "reduceArm",
      schemaVersion: { major: 1, minor: 1 } as const,
      requestSchema: z.object({ id: z.string() }),
      responseSchema: z.object({
        row: z.discriminatedUnion("status", [
          // Same arm, same tag, `value` gone - and one genuinely NEW arm
          // beside it, so the minor's `responseGrowthProjectionGated`
          // declaration is load-bearing (the framework rejects an annotation
          // that is not) and the exemption really is live for this response.
          z.object({ status: z.literal("found") }),
          z.object({ status: z.literal("absent") }),
          z.object({ status: z.literal("pending") }),
        ]),
      }),
    });
    const reduceArmUpgrade = defineUpgradePath<
      typeof reduceArmV10,
      typeof reduceArmV11
    >({
      from: reduceArmV10.schemaVersion,
      to: reduceArmV11.schemaVersion,
      upgradeRequest: (request) => ({ id: request.id }),
      upgradeResponse: (response) => ({
        row:
          response.row.status === "found"
            ? { status: "found" as const }
            : { status: "absent" as const },
      }),
    });
    const registry = {
      reduceArm: {
        1: {
          latestMinor: 1,
          versions: {
            0: { contract: reduceArmV10, upgradeFromPreviousVersion: null },
            1: {
              contract: reduceArmV11,
              upgradeFromPreviousVersion: reduceArmUpgrade,
              responseGrowthProjectionGated: true,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    } as const;

    // Named precisely, not just "throws": the point is that the ARM'S OWN
    // reduction is what surfaces. A build that reported the blanket "drops
    // union variant" instead would be describing a replacement that did not
    // happen, and would go on hiding which field left.
    expect(() => validateVersionedRpcRegistry(registry)).toThrow(
      "Minor 1.1 for method 'reduceArm' response drops field 'row.value' from 1.0",
    );
  });

  it("accepts a projection-gated minor that REPLACES an arm sharing an incidental literal with its successor", () => {
    // The hole this closes on the other side of `findDiscriminatedSuccessor`.
    // An earlier version took EVERY one-value literal on the previous arm as
    // a tag and matched a successor on ANY of them. Here `outcome:"done"` is
    // shared incidentally between the OLD "success" arm and the NEW "failure"
    // arm that replaces it, so that earlier matching read "failure" as
    // "success" EDITED - its changed `kind` and dropped `value` were then
    // reported by the recursive comparison, rejecting a replacement the
    // `responseGrowthProjectionGated` exemption is meant to permit.
    //
    // The discriminator is now inferred from the WHOLE union: a field every
    // arm pins to a single literal, with no value shared between arms. Here
    // BOTH `kind` and `outcome` qualify, so identity is the tuple - and
    // `("success","done")` matches neither `("failure","done")` nor
    // `("pending","none")`. The success arm genuinely has no successor, so it
    // is a replacement, not a reduction.
    const replaceIncidentalV10 = defineRpcContract({
      method: "replaceIncidental",
      schemaVersion: { major: 1, minor: 0 } as const,
      requestSchema: z.object({ id: z.string() }),
      responseSchema: z.object({
        row: z.discriminatedUnion("kind", [
          z.object({
            kind: z.literal("success"),
            outcome: z.literal("done"),
            value: z.string(),
          }),
          z.object({ kind: z.literal("pending"), outcome: z.literal("none") }),
        ]),
      }),
    });
    const replaceIncidentalV11 = defineRpcContract({
      method: "replaceIncidental",
      schemaVersion: { major: 1, minor: 1 } as const,
      requestSchema: z.object({ id: z.string() }),
      responseSchema: z.object({
        row: z.discriminatedUnion("kind", [
          // REPLACES the "success" arm; shares `outcome:"done"` with it
          // incidentally - the trap `findDiscriminatedSuccessor` used to fall
          // into.
          z.object({ kind: z.literal("failure"), outcome: z.literal("done") }),
          z.object({ kind: z.literal("pending"), outcome: z.literal("none") }),
        ]),
      }),
    });
    const replaceIncidentalUpgrade = defineUpgradePath<
      typeof replaceIncidentalV10,
      typeof replaceIncidentalV11
    >({
      from: replaceIncidentalV10.schemaVersion,
      to: replaceIncidentalV11.schemaVersion,
      upgradeRequest: (request) => ({ id: request.id }),
      // v1.0 -> v1.1: the old `success` arm has no v1.1 counterpart, so it
      // projects onto `pending`; `pending` carries over unchanged.
      upgradeResponse: (response) => ({
        row:
          response.row.kind === "success"
            ? { kind: "pending" as const, outcome: "none" as const }
            : response.row,
      }),
    });
    const registry = {
      replaceIncidental: {
        1: {
          latestMinor: 1,
          versions: {
            0: {
              contract: replaceIncidentalV10,
              upgradeFromPreviousVersion: null,
            },
            1: {
              contract: replaceIncidentalV11,
              upgradeFromPreviousVersion: replaceIncidentalUpgrade,
              responseGrowthProjectionGated: true,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    } as const;

    expect(() => validateVersionedRpcRegistry(registry)).not.toThrow();
  });

  it("accepts the same incidental-literal replacement in a MIXED union (one object arm beside a non-object arm)", () => {
    // Raised against the fix above: with a primitive arm in the union, only
    // ONE object arm feeds `discriminatorFields`, so every one-value literal
    // on it qualifies trivially - and the worry was that the shared, incidental
    // `outcome:"done"` would then match "failure" as "success" EDITED. It does
    // not, and this arm is the proof: identity is the WHOLE tuple of fields
    // that discriminate on BOTH sides, `kind` is pinned on both, and
    // ("success","done") is not ("failure","done"). The mixed union changes
    // how many arms vote; it does not drop `kind` from the tuple.
    const mixedV10 = defineRpcContract({
      method: "replaceIncidentalMixed",
      schemaVersion: { major: 1, minor: 0 } as const,
      requestSchema: z.object({ id: z.string() }),
      responseSchema: z.object({
        row: z.union([
          z.object({
            kind: z.literal("success"),
            outcome: z.literal("done"),
            value: z.string(),
          }),
          z.string(),
        ]),
      }),
    });
    const mixedV11 = defineRpcContract({
      method: "replaceIncidentalMixed",
      schemaVersion: { major: 1, minor: 1 } as const,
      requestSchema: z.object({ id: z.string() }),
      responseSchema: z.object({
        row: z.union([
          z.object({ kind: z.literal("failure"), outcome: z.literal("done") }),
          z.string(),
        ]),
      }),
    });
    const mixedUpgrade = defineUpgradePath<typeof mixedV10, typeof mixedV11>({
      from: mixedV10.schemaVersion,
      to: mixedV11.schemaVersion,
      upgradeRequest: (request) => ({ id: request.id }),
      upgradeResponse: (response) => ({
        row:
          typeof response.row === "string" ? response.row : response.row.value,
      }),
    });
    const registry = {
      replaceIncidentalMixed: {
        1: {
          latestMinor: 1,
          versions: {
            0: { contract: mixedV10, upgradeFromPreviousVersion: null },
            1: {
              contract: mixedV11,
              upgradeFromPreviousVersion: mixedUpgrade,
              responseGrowthProjectionGated: true,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    } as const;

    expect(() => validateVersionedRpcRegistry(registry)).not.toThrow();
  });

  it("still rejects a REDUCTION of the lone object arm of a mixed union under the exemption", () => {
    // The other half of the mixed-union question, and the reason the answer
    // is not "return no discriminator when any arm is non-object": with no
    // discriminator the lone object arm would have no successor, its edit
    // would read as a permitted replacement, and dropping `value` from it
    // would sail through a projection-gated minor. `kind` is pinned to the
    // same literal on both sides, so the arm has a successor and the dropped
    // field is reported.
    const mixedV10 = defineRpcContract({
      method: "reduceLoneArmMixed",
      schemaVersion: { major: 1, minor: 0 } as const,
      requestSchema: z.object({ id: z.string() }),
      responseSchema: z.object({
        row: z.union([
          z.object({ kind: z.literal("success"), value: z.string() }),
          z.string(),
        ]),
      }),
    });
    const mixedV11 = defineRpcContract({
      method: "reduceLoneArmMixed",
      schemaVersion: { major: 1, minor: 1 } as const,
      requestSchema: z.object({ id: z.string() }),
      responseSchema: z.object({
        row: z.union([z.object({ kind: z.literal("success") }), z.string()]),
      }),
    });
    const mixedUpgrade = defineUpgradePath<typeof mixedV10, typeof mixedV11>({
      from: mixedV10.schemaVersion,
      to: mixedV11.schemaVersion,
      upgradeRequest: (request) => ({ id: request.id }),
      upgradeResponse: (response) => ({
        row:
          typeof response.row === "string"
            ? response.row
            : { kind: "success" as const },
      }),
    });
    const registry = {
      reduceLoneArmMixed: {
        1: {
          latestMinor: 1,
          versions: {
            0: { contract: mixedV10, upgradeFromPreviousVersion: null },
            1: {
              contract: mixedV11,
              upgradeFromPreviousVersion: mixedUpgrade,
              responseGrowthProjectionGated: true,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    } as const;

    expect(() => validateVersionedRpcRegistry(registry)).toThrow(
      "Minor 1.1 for method 'reduceLoneArmMixed' response drops field 'row.value' from 1.0",
    );
  });

  it("rejects a gated minor that drops a field from an arm whose DECLARED discriminator is unchanged, even though a secondary literal moved", () => {
    // The other side of the incidental-literal coin, and the one the inferred
    // tuple got wrong. `kind` and `outcome` BOTH qualify as tags on both
    // sides, so the tuple identity of the old "a" arm was ("a","x") - which
    // matches nothing once `outcome` moves to "z". The arm then read as
    // REPLACED, and the exemption swallowed the dropped `value` silently.
    //
    // Structurally this is indistinguishable from the permitted replacement
    // two tests up: one qualifying field agrees and one differs in BOTH. Only
    // the DECLARATION separates them - `z.discriminatedUnion("kind", ...)`
    // says `kind` is identity, so here the arm survived and was edited, and
    // there it did not.
    const declaredV10 = defineRpcContract({
      method: "declaredTagEdit",
      schemaVersion: { major: 1, minor: 0 } as const,
      requestSchema: z.object({ id: z.string() }),
      responseSchema: z.object({
        row: z.discriminatedUnion("kind", [
          z.object({
            kind: z.literal("a"),
            outcome: z.literal("x"),
            value: z.string(),
          }),
          z.object({ kind: z.literal("b"), outcome: z.literal("y") }),
        ]),
      }),
    });
    const declaredV11 = defineRpcContract({
      method: "declaredTagEdit",
      schemaVersion: { major: 1, minor: 1 } as const,
      requestSchema: z.object({ id: z.string() }),
      responseSchema: z.object({
        row: z.discriminatedUnion("kind", [
          // Same arm - `kind` is still "a" - with a moved secondary literal
          // and `value` dropped.
          z.object({ kind: z.literal("a"), outcome: z.literal("z") }),
          z.object({ kind: z.literal("b"), outcome: z.literal("y") }),
        ]),
      }),
    });
    const declaredUpgrade = defineUpgradePath<
      typeof declaredV10,
      typeof declaredV11
    >({
      from: declaredV10.schemaVersion,
      to: declaredV11.schemaVersion,
      upgradeRequest: (request) => ({ id: request.id }),
      upgradeResponse: (response) => ({
        row:
          response.row.kind === "a"
            ? { kind: "a" as const, outcome: "z" as const }
            : response.row,
      }),
    });
    const registry = {
      declaredTagEdit: {
        1: {
          latestMinor: 1,
          versions: {
            0: { contract: declaredV10, upgradeFromPreviousVersion: null },
            1: {
              contract: declaredV11,
              upgradeFromPreviousVersion: declaredUpgrade,
              responseGrowthProjectionGated: true,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    } as const;

    // The FIRST reduction the property walk meets on the now-matched arm is
    // the moved literal itself (`outcome` is walked before `value`), and it is
    // a real one: an old peer expecting "x" cannot project "z". What matters
    // is that the arm was matched as an EDIT at all - under the tuple it was
    // unmatchable, so NOTHING on it was reported. The arm below pins the
    // dropped FIELD by declaring it ahead of the moved tag.
    expect(() => validateVersionedRpcRegistry(registry)).toThrow(
      "Minor 1.1 for method 'declaredTagEdit' response drops enum value 'x' from 1.0",
    );
  });

  it("honours a declared discriminator whose arm groups SEVERAL tag values", () => {
    // A declared tag may legitimately group values in one arm - this repo does
    // it with `kind: z.enum(["subagent", "monitor"])` in `agent/gui/subscribe`.
    // INFERENCE has to reject such a column (nothing distinguishes a deliberate
    // grouping from an ordinary enum field), so requiring the declared field to
    // survive inference dropped every multi-value union back onto the
    // incidental-tuple fallback - i.e. straight back into the defect the two
    // arms above pin. Here `kind` is unchanged, a secondary literal moves, and
    // a field is dropped: an EDIT, and its reduction must be reported rather
    // than exempted as an arm replacement.
    const groupedV10 = defineRpcContract({
      method: "declaredTagGrouped",
      schemaVersion: { major: 1, minor: 0 } as const,
      requestSchema: z.object({ id: z.string() }),
      responseSchema: z.object({
        row: z.discriminatedUnion("kind", [
          z.object({
            kind: z.enum(["subagent", "monitor"]),
            outcome: z.literal("x"),
            value: z.string(),
          }),
          z.object({ kind: z.literal("command"), outcome: z.literal("y") }),
        ]),
      }),
    });
    const groupedV11 = defineRpcContract({
      method: "declaredTagGrouped",
      schemaVersion: { major: 1, minor: 1 } as const,
      requestSchema: z.object({ id: z.string() }),
      responseSchema: z.object({
        row: z.discriminatedUnion("kind", [
          // Same arm - the `kind` VALUE SET is untouched - with the secondary
          // literal moved and `value` dropped.
          z.object({
            kind: z.enum(["subagent", "monitor"]),
            outcome: z.literal("z"),
          }),
          z.object({ kind: z.literal("command"), outcome: z.literal("y") }),
        ]),
      }),
    });
    const groupedUpgrade = defineUpgradePath<
      typeof groupedV10,
      typeof groupedV11
    >({
      from: groupedV10.schemaVersion,
      to: groupedV11.schemaVersion,
      upgradeRequest: (request) => ({ id: request.id }),
      upgradeResponse: (response) => ({
        row:
          response.row.kind === "command"
            ? response.row
            : { kind: response.row.kind, outcome: "z" as const },
      }),
    });
    const registry = {
      declaredTagGrouped: {
        1: {
          latestMinor: 1,
          versions: {
            0: { contract: groupedV10, upgradeFromPreviousVersion: null },
            1: {
              contract: groupedV11,
              upgradeFromPreviousVersion: groupedUpgrade,
              responseGrowthProjectionGated: true,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    } as const;

    expect(() => validateVersionedRpcRegistry(registry)).toThrow(
      "Minor 1.1 for method 'declaredTagGrouped' response drops enum value 'x' from 1.0",
    );
  });

  it("keeps the arm's identity when its grouped tag set GROWS", () => {
    // Matching a grouped tag by set EQUALITY made a growing arm unmatchable,
    // and unmatchable is the PERMISSIVE outcome: no successor means "replaced",
    // and under `responseGrowthProjectionGated` a replacement is exempt. So the
    // dropped field below - which still breaks every response pinned to the
    // values the arm KEPT - sailed through. Identity is a SHARED value.
    const grownV10 = defineRpcContract({
      method: "declaredTagGrown",
      schemaVersion: { major: 1, minor: 0 } as const,
      requestSchema: z.object({ id: z.string() }),
      responseSchema: z.object({
        row: z.discriminatedUnion("kind", [
          z.object({
            kind: z.enum(["subagent", "monitor"]),
            value: z.string(),
          }),
          z.object({ kind: z.literal("command"), label: z.string() }),
        ]),
      }),
    });
    const grownV11 = defineRpcContract({
      method: "declaredTagGrown",
      schemaVersion: { major: 1, minor: 1 } as const,
      requestSchema: z.object({ id: z.string() }),
      responseSchema: z.object({
        row: z.discriminatedUnion("kind", [
          // Same arm, one more tag value - and `value` dropped. A response with
          // `kind: "subagent"` still lands here and has lost a field.
          z.object({ kind: z.enum(["subagent", "monitor", "worker"]) }),
          z.object({ kind: z.literal("command"), label: z.string() }),
        ]),
      }),
    });
    const grownUpgrade = defineUpgradePath<typeof grownV10, typeof grownV11>({
      from: grownV10.schemaVersion,
      to: grownV11.schemaVersion,
      upgradeRequest: (request) => ({ id: request.id }),
      upgradeResponse: (response) => ({
        row:
          response.row.kind === "command"
            ? response.row
            : { kind: response.row.kind },
      }),
    });
    const registry = {
      declaredTagGrown: {
        1: {
          latestMinor: 1,
          versions: {
            0: { contract: grownV10, upgradeFromPreviousVersion: null },
            1: {
              contract: grownV11,
              upgradeFromPreviousVersion: grownUpgrade,
              responseGrowthProjectionGated: true,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    } as const;

    expect(() => validateVersionedRpcRegistry(registry)).toThrow(
      "Minor 1.1 for method 'declaredTagGrown' response drops field 'row.value' from 1.0",
    );
  });

  it("keeps BOTH halves' identity when a grouped arm SPLITS", () => {
    // The case a first-match index still misses, and the reason identity is a
    // LIST. One arm becomes two, each taking part of the tag set; both still
    // carry traffic the old arm carried. Matching only the first leaves the
    // second free to reduce - here `monitor` drops `value` while `subagent`
    // keeps it, so the walk must look past its first successful match.
    const splitV10 = defineRpcContract({
      method: "declaredTagSplit",
      schemaVersion: { major: 1, minor: 0 } as const,
      requestSchema: z.object({ id: z.string() }),
      responseSchema: z.object({
        row: z.discriminatedUnion("kind", [
          z.object({
            kind: z.enum(["subagent", "monitor"]),
            value: z.string(),
          }),
          z.object({ kind: z.literal("command"), label: z.string() }),
        ]),
      }),
    });
    const splitV11 = defineRpcContract({
      method: "declaredTagSplit",
      schemaVersion: { major: 1, minor: 1 } as const,
      requestSchema: z.object({ id: z.string() }),
      responseSchema: z.object({
        row: z.discriminatedUnion("kind", [
          // Matched FIRST and perfectly clean.
          z.object({ kind: z.literal("subagent"), value: z.string() }),
          // The half that reduced.
          z.object({ kind: z.literal("monitor") }),
          z.object({ kind: z.literal("command"), label: z.string() }),
        ]),
      }),
    });
    const splitUpgrade = defineUpgradePath<typeof splitV10, typeof splitV11>({
      from: splitV10.schemaVersion,
      to: splitV11.schemaVersion,
      upgradeRequest: (request) => ({ id: request.id }),
      upgradeResponse: (response) => ({
        row:
          response.row.kind === "command"
            ? response.row
            : response.row.kind === "subagent"
              ? { kind: "subagent" as const, value: response.row.value }
              : { kind: "monitor" as const },
      }),
    });
    const registry = {
      declaredTagSplit: {
        1: {
          latestMinor: 1,
          versions: {
            0: { contract: splitV10, upgradeFromPreviousVersion: null },
            1: {
              contract: splitV11,
              upgradeFromPreviousVersion: splitUpgrade,
              responseGrowthProjectionGated: true,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    } as const;

    expect(() => validateVersionedRpcRegistry(registry)).toThrow(
      "Minor 1.1 for method 'declaredTagSplit' response drops field 'row.value' from 1.0",
    );
  });

  it("permits a split that drops NOTHING, rather than reading each half's narrower tag as a loss", () => {
    // The false witness that matching every successor introduces, and the
    // reason the declared column is ALIGNED before the comparison. Each half of
    // a split pins a narrower slice of the old tag set, so compared as-is the
    // clean `subagent` half reports "drops enum value 'monitor'" - even though
    // the sibling arm took `monitor` and the union accepts exactly what it did
    // before. Nothing is lost here and nothing may be reported.
    const cleanV10 = defineRpcContract({
      method: "declaredTagSplitClean",
      schemaVersion: { major: 1, minor: 0 } as const,
      requestSchema: z.object({ id: z.string() }),
      responseSchema: z.object({
        row: z.discriminatedUnion("kind", [
          z.object({
            kind: z.enum(["subagent", "monitor"]),
            value: z.string(),
          }),
          z.object({ kind: z.literal("command"), label: z.string() }),
        ]),
      }),
    });
    const cleanV11 = defineRpcContract({
      method: "declaredTagSplitClean",
      schemaVersion: { major: 1, minor: 1 } as const,
      requestSchema: z.object({ id: z.string() }),
      responseSchema: z.object({
        row: z.discriminatedUnion("kind", [
          // Split in two, both halves carrying everything the grouped arm did.
          z.object({ kind: z.literal("subagent"), value: z.string() }),
          z.object({ kind: z.literal("monitor"), value: z.string() }),
          z.object({ kind: z.literal("command"), label: z.string() }),
        ]),
      }),
    });
    const cleanUpgrade = defineUpgradePath<typeof cleanV10, typeof cleanV11>({
      from: cleanV10.schemaVersion,
      to: cleanV11.schemaVersion,
      upgradeRequest: (request) => ({ id: request.id }),
      upgradeResponse: (response) => ({
        row:
          response.row.kind === "command"
            ? response.row
            : response.row.kind === "subagent"
              ? { kind: "subagent" as const, value: response.row.value }
              : { kind: "monitor" as const, value: response.row.value },
      }),
    });
    const registry = {
      declaredTagSplitClean: {
        1: {
          latestMinor: 1,
          versions: {
            0: { contract: cleanV10, upgradeFromPreviousVersion: null },
            1: {
              contract: cleanV11,
              upgradeFromPreviousVersion: cleanUpgrade,
              responseGrowthProjectionGated: true,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    } as const;

    expect(() => validateVersionedRpcRegistry(registry)).not.toThrow();
  });

  it("still reports a tag value that NO arm took after a split", () => {
    // The other side of alignment: it applies only when the whole old tag set
    // is still handled somewhere. Here `monitor` is simply gone - no sibling
    // absorbs it - so the arm's own column stays in place and reports it.
    const lostV10 = defineRpcContract({
      method: "declaredTagLost",
      schemaVersion: { major: 1, minor: 0 } as const,
      requestSchema: z.object({ id: z.string() }),
      responseSchema: z.object({
        row: z.discriminatedUnion("kind", [
          z.object({
            kind: z.enum(["subagent", "monitor"]),
            value: z.string(),
          }),
          z.object({ kind: z.literal("command"), label: z.string() }),
        ]),
      }),
    });
    const lostV11 = defineRpcContract({
      method: "declaredTagLost",
      schemaVersion: { major: 1, minor: 1 } as const,
      requestSchema: z.object({ id: z.string() }),
      responseSchema: z.object({
        row: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("subagent"), value: z.string() }),
          z.object({ kind: z.literal("command"), label: z.string() }),
        ]),
      }),
    });
    const lostUpgrade = defineUpgradePath<typeof lostV10, typeof lostV11>({
      from: lostV10.schemaVersion,
      to: lostV11.schemaVersion,
      upgradeRequest: (request) => ({ id: request.id }),
      upgradeResponse: (response) => ({
        row:
          response.row.kind === "command"
            ? response.row
            : { kind: "subagent" as const, value: response.row.value },
      }),
    });
    const registry = {
      declaredTagLost: {
        1: {
          latestMinor: 1,
          versions: {
            0: { contract: lostV10, upgradeFromPreviousVersion: null },
            1: {
              contract: lostV11,
              upgradeFromPreviousVersion: lostUpgrade,
              responseGrowthProjectionGated: true,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    } as const;

    expect(() => validateVersionedRpcRegistry(registry)).toThrow(
      "Minor 1.1 for method 'declaredTagLost' response drops enum value 'monitor' from 1.0",
    );
  });

  it("reports the DROPPED FIELD on that same arm when it is walked before the moved tag", () => {
    const orderedV10 = defineRpcContract({
      method: "declaredTagEditOrdered",
      schemaVersion: { major: 1, minor: 0 } as const,
      requestSchema: z.object({ id: z.string() }),
      responseSchema: z.object({
        // `value` declared BEFORE `outcome`, so the property walk reaches the
        // dropped field first. Same defect, different first witness.
        row: z.discriminatedUnion("kind", [
          z.object({
            kind: z.literal("a"),
            value: z.string(),
            outcome: z.literal("x"),
          }),
          z.object({ kind: z.literal("b"), outcome: z.literal("y") }),
        ]),
      }),
    });
    const orderedV11 = defineRpcContract({
      method: "declaredTagEditOrdered",
      schemaVersion: { major: 1, minor: 1 } as const,
      requestSchema: z.object({ id: z.string() }),
      responseSchema: z.object({
        row: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("a"), outcome: z.literal("z") }),
          z.object({ kind: z.literal("b"), outcome: z.literal("y") }),
        ]),
      }),
    });
    const orderedUpgrade = defineUpgradePath<
      typeof orderedV10,
      typeof orderedV11
    >({
      from: orderedV10.schemaVersion,
      to: orderedV11.schemaVersion,
      upgradeRequest: (request) => ({ id: request.id }),
      upgradeResponse: (response) => ({
        row:
          response.row.kind === "a"
            ? { kind: "a" as const, outcome: "z" as const }
            : response.row,
      }),
    });
    const registry = {
      declaredTagEditOrdered: {
        1: {
          latestMinor: 1,
          versions: {
            0: { contract: orderedV10, upgradeFromPreviousVersion: null },
            1: {
              contract: orderedV11,
              upgradeFromPreviousVersion: orderedUpgrade,
              responseGrowthProjectionGated: true,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    } as const;

    expect(() => validateVersionedRpcRegistry(registry)).toThrow(
      "Minor 1.1 for method 'declaredTagEditOrdered' response drops field 'row.value' from 1.0",
    );
  });

  it("still permits the replacement when the DECLARED discriminator itself moves, with the same secondary literal shared", () => {
    // The mirror of the arm above, and the reason the fix had to be the
    // declaration rather than a looser match: identical structure - one
    // qualifying field agrees (`outcome`), one differs (`kind`) - but here the
    // field that differs is the declared one, so the arm genuinely has no
    // successor and the gated exemption applies.
    const swapV10 = defineRpcContract({
      method: "declaredTagSwap",
      schemaVersion: { major: 1, minor: 0 } as const,
      requestSchema: z.object({ id: z.string() }),
      responseSchema: z.object({
        row: z.discriminatedUnion("kind", [
          z.object({
            kind: z.literal("a"),
            outcome: z.literal("x"),
            value: z.string(),
          }),
          z.object({ kind: z.literal("b"), outcome: z.literal("y") }),
        ]),
      }),
    });
    const swapV11 = defineRpcContract({
      method: "declaredTagSwap",
      schemaVersion: { major: 1, minor: 1 } as const,
      requestSchema: z.object({ id: z.string() }),
      responseSchema: z.object({
        row: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("c"), outcome: z.literal("x") }),
          z.object({ kind: z.literal("b"), outcome: z.literal("y") }),
        ]),
      }),
    });
    const swapUpgrade = defineUpgradePath<typeof swapV10, typeof swapV11>({
      from: swapV10.schemaVersion,
      to: swapV11.schemaVersion,
      upgradeRequest: (request) => ({ id: request.id }),
      upgradeResponse: (response) => ({
        row:
          response.row.kind === "a"
            ? { kind: "c" as const, outcome: "x" as const }
            : response.row,
      }),
    });
    const registry = {
      declaredTagSwap: {
        1: {
          latestMinor: 1,
          versions: {
            0: { contract: swapV10, upgradeFromPreviousVersion: null },
            1: {
              contract: swapV11,
              upgradeFromPreviousVersion: swapUpgrade,
              responseGrowthProjectionGated: true,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    } as const;

    expect(() => validateVersionedRpcRegistry(registry)).not.toThrow();
  });

  it("rejects a projection-gated minor whose reduced surviving arm comes AFTER a replaced arm", () => {
    // Order independence on top of the "REDUCES a surviving union arm" test
    // above: that test's reduced arm happens to come FIRST, so it would still
    // be found even by a walk that stopped dead at the first exempt replaced
    // arm. Here the replaced arm ("a" -> "c") comes first and the reduced arm
    // ("b" loses its required `bv`) comes second - the shape the survival
    // loop's own doc (see the "EXEMPT means... not stop looking" comment on
    // the anyOf/anyOf loop) says must still be visited: `continue`, not an
    // early `return null`, after an arm is classified as a replacement.
    const orderV10 = defineRpcContract({
      method: "orderIndependentReduce",
      schemaVersion: { major: 1, minor: 0 } as const,
      requestSchema: z.object({ id: z.string() }),
      responseSchema: z.object({
        row: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("a"), av: z.string() }),
          z.object({ kind: z.literal("b"), bv: z.string() }),
        ]),
      }),
    });
    const orderV11 = defineRpcContract({
      method: "orderIndependentReduce",
      schemaVersion: { major: 1, minor: 1 } as const,
      requestSchema: z.object({ id: z.string() }),
      responseSchema: z.object({
        row: z.discriminatedUnion("kind", [
          // Arm "a" is REPLACED by "c" (exempt, no successor).
          z.object({ kind: z.literal("c"), cv: z.string() }),
          // Arm "b" keeps its tag and LOSES its required `bv` - a reduction,
          // and it sits AFTER the replaced arm above.
          z.object({ kind: z.literal("b") }),
        ]),
      }),
    });
    const orderUpgrade = defineUpgradePath<typeof orderV10, typeof orderV11>({
      from: orderV10.schemaVersion,
      to: orderV11.schemaVersion,
      upgradeRequest: (request) => ({ id: request.id }),
      upgradeResponse: (response) => ({
        row:
          response.row.kind === "a"
            ? { kind: "c" as const, cv: response.row.av }
            : { kind: "b" as const },
      }),
    });
    const registry = {
      orderIndependentReduce: {
        1: {
          latestMinor: 1,
          versions: {
            0: { contract: orderV10, upgradeFromPreviousVersion: null },
            1: {
              contract: orderV11,
              upgradeFromPreviousVersion: orderUpgrade,
              responseGrowthProjectionGated: true,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    } as const;

    expect(() => validateVersionedRpcRegistry(registry)).toThrow(
      "Minor 1.1 for method 'orderIndependentReduce' response drops field 'row.bv' from 1.0",
    );
  });

  it("rejects a projection-gated minor that drops a secondary literal from every arm AND a required field from one", () => {
    // The hole this closes: `findDiscriminatedSuccessor` used to infer the
    // discriminator from the PREVIOUS union alone. Here `outcome` is a valid
    // discriminator of the OLD union only (every old arm pins it to one
    // literal, `x`/`y`); the NEW union drops it from every arm, so it is no
    // longer a discriminator on that side. Reading identity off `outcome`
    // (plus `kind`) would make the tuple ("a","x") match nothing in the new
    // union - every arm unmatchable, "a" reads as a replacement with no
    // successor, and the dropped `value` field is swallowed by the
    // exemption.
    //
    // Identity is now the INTERSECTION of both sides' discriminator fields:
    // only `kind` qualifies on the new union, so identity is just `kind`,
    // "a" matches its "a" successor, and the successor is edited (not
    // replaced) - so the walk reports what the edit actually dropped.
    const bothSidesV10 = defineRpcContract({
      method: "discriminatorBothSides",
      schemaVersion: { major: 1, minor: 0 } as const,
      requestSchema: z.object({ id: z.string() }),
      responseSchema: z.object({
        row: z.discriminatedUnion("kind", [
          z.object({
            kind: z.literal("a"),
            outcome: z.literal("x"),
            value: z.string(),
          }),
          z.object({ kind: z.literal("b"), outcome: z.literal("y") }),
        ]),
      }),
    });
    const bothSidesV11 = defineRpcContract({
      method: "discriminatorBothSides",
      schemaVersion: { major: 1, minor: 1 } as const,
      requestSchema: z.object({ id: z.string() }),
      responseSchema: z.object({
        row: z.discriminatedUnion("kind", [
          // `outcome` gone from every arm - no longer a discriminator here.
          z.object({ kind: z.literal("a") }),
          z.object({ kind: z.literal("b") }),
        ]),
      }),
    });
    const bothSidesUpgrade = defineUpgradePath<
      typeof bothSidesV10,
      typeof bothSidesV11
    >({
      from: bothSidesV10.schemaVersion,
      to: bothSidesV11.schemaVersion,
      upgradeRequest: (request) => ({ id: request.id }),
      upgradeResponse: (response) => ({
        row:
          response.row.kind === "a"
            ? { kind: "a" as const }
            : { kind: "b" as const },
      }),
    });
    const registry = {
      discriminatorBothSides: {
        1: {
          latestMinor: 1,
          versions: {
            0: { contract: bothSidesV10, upgradeFromPreviousVersion: null },
            1: {
              contract: bothSidesV11,
              upgradeFromPreviousVersion: bothSidesUpgrade,
              responseGrowthProjectionGated: true,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    } as const;

    expect(() => validateVersionedRpcRegistry(registry)).toThrow(
      "Minor 1.1 for method 'discriminatorBothSides' response drops field 'row.outcome' from 1.0",
    );
  });

  it("rejects a projection-gated union COLLAPSE whose single surviving form is a reduced arm", () => {
    // Same edited-vs-replaced distinction as the anyOf/anyOf loop, applied to
    // the union-COLLAPSE branch (union -> non-union). The collapse loop used
    // to convert every arm mismatch into the exempt "replaced" verdict
    // unconditionally; here the collapsed target IS arm "a" by discriminator
    // (same `kind`), minus its required `value`, so the arm was edited and
    // the reduction must be reported rather than swallowed.
    const collapseV10 = defineRpcContract({
      method: "unionCollapseReduced",
      schemaVersion: { major: 1, minor: 0 } as const,
      requestSchema: z.object({ id: z.string() }),
      responseSchema: z.object({
        row: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("a"), value: z.string() }),
          z.object({ kind: z.literal("b") }),
        ]),
      }),
    });
    const collapseV11 = defineRpcContract({
      method: "unionCollapseReduced",
      schemaVersion: { major: 1, minor: 1 } as const,
      requestSchema: z.object({ id: z.string() }),
      responseSchema: z.object({
        // No longer a union at all - collapsed to arm "a"'s tag, `value`
        // dropped.
        row: z.object({ kind: z.literal("a") }),
      }),
    });
    const collapseUpgrade = defineUpgradePath<
      typeof collapseV10,
      typeof collapseV11
    >({
      from: collapseV10.schemaVersion,
      to: collapseV11.schemaVersion,
      upgradeRequest: (request) => ({ id: request.id }),
      upgradeResponse: () => ({ row: { kind: "a" as const } }),
    });
    const registry = {
      unionCollapseReduced: {
        1: {
          latestMinor: 1,
          versions: {
            0: { contract: collapseV10, upgradeFromPreviousVersion: null },
            1: {
              contract: collapseV11,
              upgradeFromPreviousVersion: collapseUpgrade,
              responseGrowthProjectionGated: true,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    } as const;

    // The collapse (union -> plain object) is itself value growth under
    // strict mode (`union-variant-added`), which keeps the annotation
    // load-bearing without needing an unrelated sibling field - so the
    // rejection below is the reduction itself, not a "remove the annotation"
    // complaint.
    expect(() => validateVersionedRpcRegistry(registry)).toThrow(
      "Minor 1.1 for method 'unionCollapseReduced' response drops field 'row.value' from 1.0",
    );
  });

  it("rejects a projection-gated WIDENING whose new union carries the old form edited", () => {
    // Mirror of the collapse test above, on the WIDENING branch (non-union ->
    // union). The widening lever used to accept whenever NO arm retained the
    // old form additively; that is too coarse when one arm IS the old form
    // with a field removed - it should read as the old form edited, and its
    // reduction must be reported, not treated as if the union were an
    // unrelated new shape.
    const widenV10 = defineRpcContract({
      method: "unionWideningEdited",
      schemaVersion: { major: 1, minor: 0 } as const,
      requestSchema: z.object({ id: z.string() }),
      responseSchema: z.object({
        row: z.object({ kind: z.literal("a"), value: z.string() }),
      }),
    });
    const widenV11 = defineRpcContract({
      method: "unionWideningEdited",
      schemaVersion: { major: 1, minor: 1 } as const,
      requestSchema: z.object({ id: z.string() }),
      responseSchema: z.object({
        row: z.discriminatedUnion("kind", [
          // Arm "a" IS the old form (same `kind` discriminator) minus
          // `value`.
          z.object({ kind: z.literal("a") }),
          z.object({ kind: z.literal("b") }),
        ]),
      }),
    });
    const widenUpgrade = defineUpgradePath<typeof widenV10, typeof widenV11>({
      from: widenV10.schemaVersion,
      to: widenV11.schemaVersion,
      upgradeRequest: (request) => ({ id: request.id }),
      upgradeResponse: () => ({ row: { kind: "a" as const } }),
    });
    const registry = {
      unionWideningEdited: {
        1: {
          latestMinor: 1,
          versions: {
            0: { contract: widenV10, upgradeFromPreviousVersion: null },
            1: {
              contract: widenV11,
              upgradeFromPreviousVersion: widenUpgrade,
              responseGrowthProjectionGated: true,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    } as const;

    // The widening itself is value growth under strict mode
    // (`union-variant-added`), keeping the annotation load-bearing - the
    // rejection below is the reduction inside arm "a", not a "remove the
    // annotation" complaint.
    expect(() => validateVersionedRpcRegistry(registry)).toThrow(
      "Minor 1.1 for method 'unionWideningEdited' response drops field 'row.value' from 1.0",
    );
  });

  it("rejects a projection-gated union replacement that also drops another response field", () => {
    const replaceAndDropV10 = defineRpcContract({
      method: "replaceAndDrop",
      schemaVersion: { major: 1, minor: 0 } as const,
      requestSchema: z.object({ id: z.string() }),
      responseSchema: z.object({
        row: z.union([z.object({ legacy: z.string() }), z.null()]),
        stable: z.string(),
      }),
    });
    const replaceAndDropV11 = defineRpcContract({
      method: "replaceAndDrop",
      schemaVersion: { major: 1, minor: 1 } as const,
      requestSchema: z.object({ id: z.string() }),
      responseSchema: z.object({
        row: z.discriminatedUnion("status", [
          z.object({ status: z.literal("found"), value: z.string() }),
          z.object({ status: z.literal("absent") }),
        ]),
      }),
    });
    const replaceAndDropUpgrade = defineUpgradePath<
      typeof replaceAndDropV10,
      typeof replaceAndDropV11
    >({
      from: replaceAndDropV10.schemaVersion,
      to: replaceAndDropV11.schemaVersion,
      upgradeRequest: (request) => ({ id: request.id }),
      upgradeResponse: (response) => ({
        row:
          response.row === null
            ? { status: "absent" as const }
            : { status: "found" as const, value: response.row.legacy },
      }),
    });
    const registry = {
      replaceAndDrop: {
        1: {
          latestMinor: 1,
          versions: {
            0: {
              contract: replaceAndDropV10,
              upgradeFromPreviousVersion: null,
            },
            1: {
              contract: replaceAndDropV11,
              upgradeFromPreviousVersion: replaceAndDropUpgrade,
              responseGrowthProjectionGated: true,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    } as const;

    expect(() => validateVersionedRpcRegistry(registry)).toThrow(
      "Minor 1.1 for method 'replaceAndDrop' response drops field 'stable' from 1.0",
    );
  });

  it("keeps REQUEST enum growth legal on minors without annotation", () => {
    const optInV10 = defineRpcContract({
      method: "optIn",
      schemaVersion: { major: 1, minor: 0 } as const,
      requestSchema: z.object({ mode: z.enum(["fast"]) }),
      responseSchema: z.object({ ok: z.boolean() }),
    });
    const optInV11 = defineRpcContract({
      method: "optIn",
      schemaVersion: { major: 1, minor: 1 } as const,
      requestSchema: z.object({ mode: z.enum(["fast", "careful"]) }),
      responseSchema: z.object({ ok: z.boolean() }),
    });
    const optInUpgrade = defineUpgradePath<typeof optInV10, typeof optInV11>({
      from: optInV10.schemaVersion,
      to: optInV11.schemaVersion,
      upgradeRequest: (request) => ({ mode: request.mode }),
      upgradeResponse: (response) => ({ ok: response.ok }),
    });

    const registry = {
      optIn: {
        1: {
          latestMinor: 1,
          versions: {
            0: { contract: optInV10, upgradeFromPreviousVersion: null },
            1: {
              contract: optInV11,
              upgradeFromPreviousVersion: optInUpgrade,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    } as const;

    expect(() => validateVersionedRpcRegistry(registry)).not.toThrow();
  });

  it("keeps the annotation hint when response growth is nested under an array", () => {
    const nestedV10 = defineRpcContract({
      method: "nested",
      schemaVersion: { major: 1, minor: 0 } as const,
      requestSchema: z.object({ id: z.string() }),
      responseSchema: z.object({
        rows: z.array(z.object({ status: z.enum(["queued"]) })),
      }),
    });
    const nestedV11 = defineRpcContract({
      method: "nested",
      schemaVersion: { major: 1, minor: 1 } as const,
      requestSchema: z.object({ id: z.string() }),
      responseSchema: z.object({
        rows: z.array(z.object({ status: z.enum(["queued", "running"]) })),
      }),
    });
    const nestedUpgrade = defineUpgradePath<typeof nestedV10, typeof nestedV11>(
      {
        from: nestedV10.schemaVersion,
        to: nestedV11.schemaVersion,
        upgradeRequest: (request) => ({ id: request.id }),
        upgradeResponse: (response) => ({ rows: response.rows }),
      },
    );

    const registry = {
      nested: {
        1: {
          latestMinor: 1,
          versions: {
            0: { contract: nestedV10, upgradeFromPreviousVersion: null },
            1: {
              contract: nestedV11,
              upgradeFromPreviousVersion: nestedUpgrade,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    } as const;

    expect(() => validateVersionedRpcRegistry(registry)).toThrow(
      /array items: adds enum value 'running'.*responseGrowthProjectionGated/s,
    );
  });

  it("rejects a redundant projection-gated annotation on a minor with no growth", () => {
    // The annotation must stay load-bearing: if it outlived the growth it
    // was granted for, the response lane would stay silently lenient for
    // every later edit to that same minor.
    const flatV10 = defineRpcContract({
      method: "flat",
      schemaVersion: { major: 1, minor: 0 } as const,
      requestSchema: z.object({ id: z.string() }),
      responseSchema: z.object({ ok: z.boolean() }),
    });
    const flatV11 = defineRpcContract({
      method: "flat",
      schemaVersion: { major: 1, minor: 1 } as const,
      requestSchema: z.object({ id: z.string() }),
      responseSchema: z.object({
        ok: z.boolean(),
        note: z.string().optional(),
      }),
    });
    const flatUpgrade = defineUpgradePath<typeof flatV10, typeof flatV11>({
      from: flatV10.schemaVersion,
      to: flatV11.schemaVersion,
      upgradeRequest: (request) => ({ id: request.id }),
      upgradeResponse: (response) => ({ ok: response.ok }),
    });

    const registry = {
      flat: {
        1: {
          latestMinor: 1,
          versions: {
            0: { contract: flatV10, upgradeFromPreviousVersion: null },
            1: {
              contract: flatV11,
              upgradeFromPreviousVersion: flatUpgrade,
              responseGrowthProjectionGated: true,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    } as const;

    expect(() => validateVersionedRpcRegistry(registry)).toThrow(
      /declares `responseGrowthProjectionGated` but its response has no value growth or union-arm replacement.*remove the annotation/s,
    );
  });

  it("rejects a projection-gated annotation on the first installed minor", () => {
    const soloV10 = defineRpcContract({
      method: "solo",
      schemaVersion: { major: 1, minor: 0 } as const,
      requestSchema: z.object({ id: z.string() }),
      responseSchema: z.object({ ok: z.boolean() }),
    });

    const registry = {
      solo: {
        1: {
          latestMinor: 0,
          versions: {
            0: {
              contract: soloV10,
              upgradeFromPreviousVersion: null,
              responseGrowthProjectionGated: true,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    } as const;

    expect(() => validateVersionedRpcRegistry(registry)).toThrow(
      /first installed minor of its line, so it has no predecessor to grow over/,
    );
  });
});
