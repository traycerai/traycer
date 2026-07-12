import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineDowngradePath,
  defineFallbackMethodDegrade,
  defineFloorAwareVersionedRpcRegistry,
  defineRpcContract,
  defineUpgradePath,
  defineVersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import { check } from "@traycer/protocol/framework/compatibility-checker";
import {
  defineStreamRpcContract,
  defineVersionedStreamRpcRegistry,
} from "@traycer/protocol/framework/versioned-stream-rpc";
import { checkStreamCompatibility } from "@traycer/protocol/framework/stream-compat";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/index";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import { buildProtocolSurface } from "@traycer/protocol/framework/surface-build";
import {
  checkSurfaceCompatibility,
  matchMethodGlob,
  matchPathGlob,
  parseCompatExceptionsFile,
  validateCompatExceptions,
  manifestFromSurface,
  protocolSurfaceSchema,
  type CompatException,
} from "@traycer/protocol/framework/surface-compat";
import type { UncheckedVersionedRpcRegistry } from "@traycer/protocol/framework/versioned-rpc-types";
import type { UncheckedVersionedStreamRpcRegistry } from "@traycer/protocol/framework/versioned-stream-rpc";

const EMPTY_STREAM: UncheckedVersionedStreamRpcRegistry = {};

function surfaceOfUnary(unary: UncheckedVersionedRpcRegistry) {
  return buildProtocolSurface({
    unary,
    unaryFloorMethodNames: Object.keys(unary).sort(),
    stream: EMPTY_STREAM,
  });
}

function surfaceOfUnaryWithFloor(
  unary: UncheckedVersionedRpcRegistry,
  unaryFloorMethodNames: readonly string[],
) {
  return buildProtocolSurface({
    unary,
    unaryFloorMethodNames,
    stream: EMPTY_STREAM,
  });
}

function unaryV10(request: z.ZodType, response: z.ZodType) {
  return {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "host.echo",
            schemaVersion: { major: 1, minor: 0 } as const,
            requestSchema: request,
            responseSchema: response,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  } as const;
}

const baseRequest = z.object({ a: z.string() });
const baseResponse = z.object({ r: z.string() });
const baselineRegistry = defineVersionedRpcRegistry({
  "host.echo": unaryV10(baseRequest, baseResponse),
});
const baselineSurface = surfaceOfUnary(baselineRegistry);

const optionalV10 = defineRpcContract({
  method: "host.optional",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({ value: z.string() }),
  responseSchema: z.object({ ok: z.boolean() }),
});

const hostEchoV10 = defineRpcContract({
  method: "host.echo",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: baseRequest,
  responseSchema: baseResponse,
});

const optionalEntry = {
  1: {
    latestMinor: 0,
    versions: {
      0: {
        contract: optionalV10,
        upgradeFromPreviousVersion: null,
      },
    },
    downgradePathsFromLatest: {},
  },
} as const;

function blockingOf(
  mine: UncheckedVersionedRpcRegistry,
  exceptions: readonly CompatException[],
) {
  return checkSurfaceCompatibility({
    mine: surfaceOfUnary(mine),
    theirs: baselineSurface,
    theirsLabel: "released",
    exceptions,
  }).blocking;
}

describe("surface self-compatibility", () => {
  it("the live host registries are compatible with their own surface", () => {
    const surface = buildProtocolSurface({
      unary: hostRpcRegistry,
      unaryFloorMethodNames: RELEASED_FLOOR_METHOD_NAMES,
      stream: hostStreamRpcRegistry,
    });
    const result = checkSurfaceCompatibility({
      mine: surface,
      theirs: surface,
      theirsLabel: "self",
      exceptions: [],
    });
    expect(result.findings).toEqual([]);
  });
});

describe("handshake-fatal method-name drift (the #227 class)", () => {
  it("flags a method the released peer does not know", () => {
    const mine = defineVersionedRpcRegistry({
      "host.echo": unaryV10(baseRequest, baseResponse),
      "terminal.defaultCwd": {
        1: {
          latestMinor: 0,
          versions: {
            0: {
              contract: defineRpcContract({
                method: "terminal.defaultCwd",
                schemaVersion: { major: 1, minor: 0 } as const,
                requestSchema: z.object({ epicId: z.string() }),
                responseSchema: z.object({ cwd: z.string() }),
              }),
              upgradeFromPreviousVersion: null,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    });

    const blocking = blockingOf(mine, []);
    expect(blocking).toHaveLength(1);
    expect(blocking[0].method).toBe("terminal.defaultCwd");
    expect(blocking[0].severity).toBe("fatal");

    // The real released-side oracle agrees: its own checker fail-closes.
    const releasedVerdict = check(
      baselineRegistry,
      manifestFromSurface(baselineSurface, "unary"),
      manifestFromSurface(surfaceOfUnary(mine), "unary"),
      "host",
    );
    expect(releasedVerdict.ok).toBe(false);
  });

  it("flags a method removed relative to the released peer", () => {
    const blocking = checkSurfaceCompatibility({
      mine: surfaceOfUnary(
        defineVersionedRpcRegistry({
          "host.other": {
            1: {
              latestMinor: 0,
              versions: {
                0: {
                  contract: defineRpcContract({
                    method: "host.other",
                    schemaVersion: { major: 1, minor: 0 } as const,
                    requestSchema: baseRequest,
                    responseSchema: baseResponse,
                  }),
                  upgradeFromPreviousVersion: null,
                },
              },
              downgradePathsFromLatest: {},
            },
          },
        }),
      ),
      theirs: baselineSurface,
      theirsLabel: "released",
      exceptions: [],
    }).blocking;
    expect(blocking.map((finding) => finding.method).sort()).toEqual([
      "host.echo",
      "host.other",
    ]);
    expect(blocking.every((finding) => finding.severity === "fatal")).toBe(
      true,
    );
  });

  it("fatal findings cannot be suppressed by exceptions", () => {
    const mine = defineVersionedRpcRegistry({
      "host.echo": unaryV10(baseRequest, baseResponse),
      "host.extra": {
        1: {
          latestMinor: 0,
          versions: {
            0: {
              contract: defineRpcContract({
                method: "host.extra",
                schemaVersion: { major: 1, minor: 0 } as const,
                requestSchema: baseRequest,
                responseSchema: baseResponse,
              }),
              upgradeFromPreviousVersion: null,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    });
    const blocking = blockingOf(mine, [
      {
        family: "unary",
        method: "host.extra",
        version: "1.0",
        payload: "request",
        path: "(root)",
        reason: "attempted fatal suppression",
      },
    ]);
    expect(blocking).toHaveLength(1);
  });
});

describe("optional unary channel and degrade-story policy", () => {
  it("dumps floor methods separately from optional unary methods with degrade data", () => {
    const registry = defineFloorAwareVersionedRpcRegistry(["host.echo"], {
      "host.echo": unaryV10(baseRequest, baseResponse),
      "host.optional": {
        degrade: defineFallbackMethodDegrade<
          typeof optionalV10,
          typeof hostEchoV10,
          "host.echo"
        >({
          kind: "fallback",
          to: { method: "host.echo", major: 1, minor: 0 },
          adaptRequest: (request) => ({ a: request.value }),
          adaptResponse: () => ({ ok: true }),
        }),
        ...optionalEntry,
      },
    });

    const surface = surfaceOfUnaryWithFloor(registry, ["host.echo"]);

    expect(surface.unary["host.echo"]).toBeDefined();
    expect(surface.unary["host.optional"]).toBeUndefined();
    expect(surface.optionalUnary["host.optional"]?.canonical).toEqual({
      major: 1,
      minor: 0,
    });
    expect(surface.optionalUnary["host.optional"]?.degrade).toEqual({
      kind: "fallback",
      to: { method: "host.echo", major: 1, minor: 0 },
    });
  });

  it("parses old-format surfaces that have no optional channel", () => {
    const parsed = protocolSurfaceSchema.parse({
      formatVersion: 1,
      unary: baselineSurface.unary,
      stream: {},
    });

    expect(parsed.optionalUnary).toEqual({});
  });

  it("blocks an optional unary method that is absent from the baseline and has no story", () => {
    const registry = defineVersionedRpcRegistry({
      "host.echo": unaryV10(baseRequest, baseResponse),
      "host.optional": optionalEntry,
    });
    const result = checkSurfaceCompatibility({
      mine: surfaceOfUnaryWithFloor(registry, ["host.echo"]),
      theirs: baselineSurface,
      theirsLabel: "released",
      exceptions: [
        {
          family: "unary",
          method: "host.optional",
          version: "1.0",
          payload: "request",
          path: "(root)",
          reason: "attempted optional policy suppression",
        },
      ],
    });

    expect(result.blocking).toHaveLength(1);
    expect(result.blocking[0]).toMatchObject({
      method: "host.optional",
      severity: "blocking",
      excepted: false,
    });
  });

  it("accepts an absent optional unary method when its fallback target is reachable on the baseline", () => {
    const registry = defineFloorAwareVersionedRpcRegistry(["host.echo"], {
      "host.echo": unaryV10(baseRequest, baseResponse),
      "host.optional": {
        degrade: defineFallbackMethodDegrade<
          typeof optionalV10,
          typeof hostEchoV10,
          "host.echo"
        >({
          kind: "fallback",
          to: { method: "host.echo", major: 1, minor: 0 },
          adaptRequest: (request) => ({ a: request.value }),
          adaptResponse: () => ({ ok: true }),
        }),
        ...optionalEntry,
      },
    });
    const mine = surfaceOfUnaryWithFloor(registry, ["host.echo"]);
    const result = checkSurfaceCompatibility({
      mine,
      theirs: baselineSurface,
      theirsLabel: "released",
      exceptions: [],
    });

    expect(result.blocking).toEqual([]);
    const targetVerdict = check(
      baselineRegistry,
      manifestFromSurface(baselineSurface, "unary"),
      { "host.echo": { major: 1, minor: 0 } },
      "host",
    );
    expect(targetVerdict.ok).toBe(true);
  });

  it("blocks an absent optional unary method when its fallback target is unreachable", () => {
    const registry = defineVersionedRpcRegistry({
      "host.echo": unaryV10(baseRequest, baseResponse),
      "host.optional": {
        degrade: {
          kind: "fallback",
          to: { method: "host.missing", major: 1, minor: 0 },
          adaptRequest: () => ({ a: "fallback" }),
          adaptResponse: () => ({ ok: true }),
        },
        ...optionalEntry,
      },
    });
    const result = checkSurfaceCompatibility({
      mine: surfaceOfUnaryWithFloor(registry, ["host.echo"]),
      theirs: baselineSurface,
      theirsLabel: "released",
      exceptions: [],
    });

    expect(result.blocking).toHaveLength(1);
    expect(result.blocking[0]).toMatchObject({
      method: "host.optional",
      severity: "blocking",
    });
    expect(result.blocking[0].detail).toContain("fallback is unreachable");
  });

  it("treats an absent optional unary method with unsupported story as advisory", () => {
    const registry = defineFloorAwareVersionedRpcRegistry(["host.echo"], {
      "host.echo": unaryV10(baseRequest, baseResponse),
      "host.optional": {
        degrade: { kind: "unsupported" },
        ...optionalEntry,
      },
    });
    const result = checkSurfaceCompatibility({
      mine: surfaceOfUnaryWithFloor(registry, ["host.echo"]),
      theirs: baselineSurface,
      theirsLabel: "released",
      exceptions: [],
    });

    expect(result.blocking).toEqual([]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      method: "host.optional",
      severity: "advisory",
    });
  });
});

describe("unary version bridging mirrors the shipped checker", () => {
  const echoV10 = defineRpcContract({
    method: "host.echo",
    schemaVersion: { major: 1, minor: 0 } as const,
    requestSchema: baseRequest,
    responseSchema: baseResponse,
  });
  const upgraded = defineRpcContract({
    method: "host.echo",
    schemaVersion: { major: 1, minor: 1 } as const,
    requestSchema: baseRequest.extend({ b: z.number().nullable() }),
    responseSchema: baseResponse,
  });
  const minorBumpRegistry = defineVersionedRpcRegistry({
    "host.echo": {
      1: {
        latestMinor: 1,
        versions: {
          0: {
            contract: echoV10,
            upgradeFromPreviousVersion: null,
          },
          1: {
            contract: upgraded,
            upgradeFromPreviousVersion: defineUpgradePath<
              typeof echoV10,
              typeof upgraded
            >({
              from: { major: 1, minor: 0 },
              to: { major: 1, minor: 1 },
              upgradeRequest: (request) => ({ ...request, b: null }),
              upgradeResponse: (response) => response,
            }),
          },
        },
        downgradePathsFromLatest: {},
      },
    },
  });

  it("accepts a minor bump that keeps the released minor installed", () => {
    expect(blockingOf(minorBumpRegistry, [])).toEqual([]);
    const verdict = check(
      minorBumpRegistry,
      manifestFromSurface(surfaceOfUnary(minorBumpRegistry), "unary"),
      manifestFromSurface(baselineSurface, "unary"),
      "client",
    );
    expect(verdict.ok).toBe(true);
  });

  it("rejects a major bump without a downgrade bridge, mirroring check()", () => {
    const breakingContract = defineRpcContract({
      method: "host.echo",
      schemaVersion: { major: 2, minor: 0 } as const,
      requestSchema: z.object({ a: z.number() }),
      responseSchema: baseResponse,
    });
    const majorNoBridge = defineVersionedRpcRegistry({
      "host.echo": {
        1: minorBumpRegistry["host.echo"][1],
        2: {
          latestMinor: 0,
          versions: {
            0: {
              contract: breakingContract,
              upgradeFromPreviousVersion: defineUpgradePath<
                typeof upgraded,
                typeof breakingContract
              >({
                from: { major: 1, minor: 1 },
                to: { major: 2, minor: 0 },
                upgradeRequest: (request) => ({ a: Number(request.a) }),
                upgradeResponse: (response) => response,
              }),
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    });
    const blocking = blockingOf(majorNoBridge, []);
    expect(blocking).toHaveLength(1);
    expect(blocking[0].severity).toBe("fatal");
    const verdict = check(
      majorNoBridge,
      manifestFromSurface(surfaceOfUnary(majorNoBridge), "unary"),
      manifestFromSurface(baselineSurface, "unary"),
      "client",
    );
    expect(verdict.ok).toBe(false);
  });

  it("accepts a major bump that declares a downgrade bridge, mirroring check()", () => {
    const breakingContract = defineRpcContract({
      method: "host.echo",
      schemaVersion: { major: 2, minor: 0 } as const,
      requestSchema: z.object({ a: z.number() }),
      responseSchema: baseResponse,
    });
    const majorWithBridge = defineVersionedRpcRegistry({
      "host.echo": {
        1: minorBumpRegistry["host.echo"][1],
        2: {
          latestMinor: 0,
          versions: {
            0: {
              contract: breakingContract,
              upgradeFromPreviousVersion: defineUpgradePath<
                typeof upgraded,
                typeof breakingContract
              >({
                from: { major: 1, minor: 1 },
                to: { major: 2, minor: 0 },
                upgradeRequest: (request) => ({ a: Number(request.a) }),
                upgradeResponse: (response) => response,
              }),
            },
          },
          downgradePathsFromLatest: {
            1: defineDowngradePath<typeof breakingContract, typeof upgraded>({
              from: { major: 2, minor: 0 },
              to: { major: 1, minor: 1 },
              downgradeRequest: (request) => ({
                ok: true,
                value: { a: String(request.a), b: null },
              }),
              downgradeResponse: (response) => ({ ok: true, value: response }),
            }),
          },
        },
      },
    });
    expect(blockingOf(majorWithBridge, [])).toEqual([]);
    const verdict = check(
      majorWithBridge,
      manifestFromSurface(surfaceOfUnary(majorWithBridge), "unary"),
      manifestFromSurface(baselineSurface, "unary"),
      "client",
    );
    expect(verdict.ok).toBe(true);
  });
});

describe("stream bridging mirrors the shipped stream checker", () => {
  const openSchema = z.object({ epicId: z.string() });
  const serverFrame = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("data"), value: z.string() }),
  ]);
  const clientFrame = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("ack"), id: z.string() }),
  ]);

  function streamRegistryAt(major: number) {
    return defineVersionedStreamRpcRegistry({
      "demo.subscribe": {
        [major]: {
          latestMinor: 0,
          versions: {
            0: {
              contract: defineStreamRpcContract({
                method: "demo.subscribe",
                schemaVersion: { major, minor: 0 },
                openRequestSchema: openSchema,
                serverFrameSchema:
                  major === 1
                    ? serverFrame
                    : z.discriminatedUnion("kind", [
                        z.object({
                          kind: z.literal("data"),
                          value: z.number(),
                        }),
                      ]),
                clientFrameSchema: clientFrame,
              }),
            },
          },
        },
      },
    });
  }

  it("treats a cross-major stream mismatch as breaking, mirroring checkStreamCompatibility's per-method verdict", () => {
    const mineRegistry = streamRegistryAt(2);
    const theirsRegistry = streamRegistryAt(1);
    const mine = buildProtocolSurface({
      unary: {},
      unaryFloorMethodNames: [],
      stream: mineRegistry,
    });
    const theirs = buildProtocolSurface({
      unary: {},
      unaryFloorMethodNames: [],
      stream: theirsRegistry,
    });

    const blocking = checkSurfaceCompatibility({
      mine,
      theirs,
      theirsLabel: "released",
      exceptions: [],
    }).blocking;
    expect(blocking).toHaveLength(2);
    expect(blocking.every((finding) => finding.severity === "breaking")).toBe(
      true,
    );

    const verdict = checkStreamCompatibility(
      mineRegistry,
      manifestFromSurface(mine, "stream"),
      manifestFromSurface(theirs, "stream"),
      "client",
    );
    expect(verdict.ok).toBe(false);
  });

  it("treats a stream method the released peer never had as advisory (the resources.subscribe precedent)", () => {
    const mine = buildProtocolSurface({
      unary: {},
      unaryFloorMethodNames: [],
      stream: streamRegistryAt(1),
    });
    const theirs = buildProtocolSurface({
      unary: {},
      unaryFloorMethodNames: [],
      stream: {},
    });
    const result = checkSurfaceCompatibility({
      mine,
      theirs,
      theirsLabel: "released",
      exceptions: [],
    });
    expect(result.blocking).toEqual([]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe("advisory");
  });

  it("treats removing a stream method the released peer shipped with as breaking", () => {
    const mine = buildProtocolSurface({
      unary: {},
      unaryFloorMethodNames: [],
      stream: {},
    });
    const theirs = buildProtocolSurface({
      unary: {},
      unaryFloorMethodNames: [],
      stream: streamRegistryAt(1),
    });
    const blocking = checkSurfaceCompatibility({
      mine,
      theirs,
      theirsLabel: "released",
      exceptions: [],
    }).blocking;
    expect(blocking).toHaveLength(1);
    expect(blocking[0].severity).toBe("breaking");
  });
});

describe("same-version wire-schema evolution rules", () => {
  it("accepts adding an optional property on a client→host slot (advisory only)", () => {
    const mine = defineVersionedRpcRegistry({
      "host.echo": unaryV10(
        baseRequest.extend({ extra: z.string().optional() }),
        baseResponse,
      ),
    });
    expect(blockingOf(mine, [])).toEqual([]);
    const result = checkSurfaceCompatibility({
      mine: surfaceOfUnary(mine),
      theirs: baselineSurface,
      theirsLabel: "released",
      exceptions: [],
    });
    const requestFinding = result.findings.find(
      (finding) => finding.payload === "request" && finding.path === "properties.extra",
    );
    expect(requestFinding?.severity).toBe("advisory");
  });

  it("rejects a tolerated (.catch()/optional) property added at a released version on a host→client slot - the providers.list #258 class", () => {
    // Mirrors the historical miss: a `.catch()`-tolerant field lands on an
    // already-released response shape without a version bump. Schema-level
    // parsing still succeeds (that's the whole point of `.catch()`), but the
    // released peer's wire payload never carries the key.
    const mine = defineVersionedRpcRegistry({
      "host.echo": unaryV10(
        baseRequest,
        baseResponse.extend({ profiles: z.array(z.string()).catch([]) }),
      ),
    });
    const result = checkSurfaceCompatibility({
      mine: surfaceOfUnary(mine),
      theirs: baselineSurface,
      theirsLabel: "released",
      exceptions: [],
    });
    const finding = result.blocking.find(
      (f) => f.payload === "response" && f.path === "properties.profiles",
    );
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("breaking");
    expect(finding?.detail).toContain("host→client");
    expect(finding?.detail).toContain("never carries this key");
  });

  it("rejects adding a required property at a released version", () => {
    const mine = defineVersionedRpcRegistry({
      "host.echo": unaryV10(
        baseRequest.extend({ extra: z.string() }),
        baseResponse,
      ),
    });
    const blocking = blockingOf(mine, []);
    expect(blocking).toHaveLength(1);
    expect(blocking[0].severity).toBe("breaking");
    expect(blocking[0].path).toBe("properties.extra");
  });

  it("rejects removing a required property at a released version", () => {
    const mine = defineVersionedRpcRegistry({
      "host.echo": unaryV10(baseRequest, z.object({})),
    });
    const blocking = blockingOf(mine, []);
    expect(blocking).toHaveLength(1);
    expect(blocking[0].payload).toBe("response");
    expect(blocking[0].path).toBe("properties.r");
  });

  it("rejects flipping a property between optional and required", () => {
    const demoted = defineVersionedRpcRegistry({
      "host.echo": unaryV10(
        z.object({ a: z.string().optional() }),
        baseResponse,
      ),
    });
    expect(blockingOf(demoted, []).map((finding) => finding.path)).toEqual([
      "properties.a",
    ]);
  });

  it("reports request enum value additions as advisory (client→host growth)", () => {
    const withEnum = defineVersionedRpcRegistry({
      "host.echo": unaryV10(
        z.object({ a: z.string(), mode: z.enum(["x", "y"]) }),
        baseResponse,
      ),
    });
    const widened = defineVersionedRpcRegistry({
      "host.echo": unaryV10(
        z.object({ a: z.string(), mode: z.enum(["x", "y", "z"]) }),
        baseResponse,
      ),
    });
    const result = checkSurfaceCompatibility({
      mine: surfaceOfUnary(widened),
      theirs: surfaceOfUnary(withEnum),
      theirsLabel: "released",
      exceptions: [],
    });
    expect(result.blocking).toEqual([]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe("advisory");
    expect(result.findings[0].path).toBe("properties.mode.enum");
  });

  it("rejects enum value removals and honors reviewed exceptions", () => {
    const withEnum = defineVersionedRpcRegistry({
      "host.echo": unaryV10(
        z.object({ a: z.string(), mode: z.enum(["x", "y"]) }),
        baseResponse,
      ),
    });
    const narrowed = defineVersionedRpcRegistry({
      "host.echo": unaryV10(
        z.object({ a: z.string(), mode: z.enum(["x"]) }),
        baseResponse,
      ),
    });
    const theirs = surfaceOfUnary(withEnum);

    const unexcepted = checkSurfaceCompatibility({
      mine: surfaceOfUnary(narrowed),
      theirs,
      theirsLabel: "released",
      exceptions: [],
    });
    expect(unexcepted.blocking).toHaveLength(1);
    const finding = unexcepted.blocking[0];
    expect(finding.severity).toBe("breaking");
    expect(finding.path).toBe("properties.mode.enum");

    const excepted = checkSurfaceCompatibility({
      mine: surfaceOfUnary(narrowed),
      theirs,
      theirsLabel: "released",
      exceptions: [
        {
          family: "unary",
          method: "host.echo",
          version: "1.0",
          payload: "request",
          path: "properties.mode.enum",
          reason: "value was never produced by released clients",
        },
      ],
    });
    expect(excepted.blocking).toEqual([]);
    expect(excepted.findings).toHaveLength(1);
    expect(excepted.findings[0].excepted).toBe(true);
  });

  it("rejects structural type changes at a released version", () => {
    const mine = defineVersionedRpcRegistry({
      "host.echo": unaryV10(z.object({ a: z.number() }), baseResponse),
    });
    const blocking = blockingOf(mine, []);
    expect(blocking).toHaveLength(1);
    expect(blocking[0].severity).toBe("breaking");
  });

  it("skips schema comparison when one side carries an $unavailable sentinel", () => {
    const theirs = JSON.parse(
      JSON.stringify(baselineSurface),
    ) as typeof baselineSurface;
    const slots = theirs.unary["host.echo"].schemas["1.0"] as Record<
      string,
      unknown
    >;
    slots["request"] = { $unavailable: "old zod" };
    const mine = defineVersionedRpcRegistry({
      "host.echo": unaryV10(z.object({ a: z.number() }), baseResponse),
    });
    const result = checkSurfaceCompatibility({
      mine: surfaceOfUnary(mine),
      theirs,
      theirsLabel: "released",
      exceptions: [],
    });
    expect(result.blocking).toEqual([]);
  });
});


describe("direction-aware enum/union addition severity", () => {
  const catalogRequest = z.object({});
  const catalogResponseV10 = z.object({
    harnesses: z.array(z.object({ id: z.enum(["claude", "cursor"]) })),
  });
  const catalogResponseV10PlusDevin = z.object({
    harnesses: z.array(
      z.object({ id: z.enum(["claude", "cursor", "devin"]) }),
    ),
  });

  function catalogRegistry(response: z.ZodType) {
    return defineVersionedRpcRegistry({
      "agent.gui.listHarnesses": {
        1: {
          latestMinor: 0,
          versions: {
            0: {
              contract: defineRpcContract({
                method: "agent.gui.listHarnesses",
                schemaVersion: { major: 1, minor: 0 } as const,
                requestSchema: catalogRequest,
                responseSchema: response,
              }),
              upgradeFromPreviousVersion: null,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    });
  }

  it("response enum add at the shared canonical version is blocking", () => {
    const released = surfaceOfUnary(catalogRegistry(catalogResponseV10));
    const mine = surfaceOfUnary(catalogRegistry(catalogResponseV10PlusDevin));
    const result = checkSurfaceCompatibility({
      mine,
      theirs: released,
      theirsLabel: "released",
      exceptions: [],
    });
    const blocking = result.blocking.filter(
      (finding) => finding.method === "agent.gui.listHarnesses",
    );
    expect(blocking.length).toBeGreaterThanOrEqual(1);
    expect(blocking[0].severity).toBe("breaking");
    expect(blocking[0].payload).toBe("response");
    expect(blocking[0].detail).toContain("host→client");
    expect(blocking[0].detail).toContain("freeze the shipped line");
  });

  it("frozen old line + new major with downgrade bridge is clean", () => {
    const released = surfaceOfUnary(catalogRegistry(catalogResponseV10));
    // v1 frozen without devin; v2 canonical carries it - no shared-version
    // divergence at 1.0 for the response enum (v1 response stays frozen).
    const frozenV10 = catalogResponseV10;
    const liveV20 = catalogResponseV10PlusDevin;
    const v10 = defineRpcContract({
      method: "agent.gui.listHarnesses",
      schemaVersion: { major: 1, minor: 0 } as const,
      requestSchema: catalogRequest,
      responseSchema: frozenV10,
    });
    const v20 = defineRpcContract({
      method: "agent.gui.listHarnesses",
      schemaVersion: { major: 2, minor: 0 } as const,
      requestSchema: catalogRequest,
      responseSchema: liveV20,
    });
    const mine = defineVersionedRpcRegistry({
      "agent.gui.listHarnesses": {
        1: {
          latestMinor: 0,
          versions: {
            0: { contract: v10, upgradeFromPreviousVersion: null },
          },
          downgradePathsFromLatest: {},
        },
        2: {
          latestMinor: 0,
          versions: {
            0: {
              contract: v20,
              upgradeFromPreviousVersion: defineUpgradePath<typeof v10, typeof v20>({
                from: { major: 1, minor: 0 },
                to: { major: 2, minor: 0 },
                upgradeRequest: (request) => request,
                upgradeResponse: (response) => response,
              }),
            },
          },
          downgradePathsFromLatest: {
            1: defineDowngradePath<typeof v20, typeof v10>({
              from: { major: 2, minor: 0 },
              to: { major: 1, minor: 0 },
              downgradeRequest: (request) => ({ ok: true, value: request }),
              downgradeResponse: (response) => {
                const harnesses: { id: "claude" | "cursor" }[] = [];
                for (const row of response.harnesses) {
                  if (row.id === "claude" || row.id === "cursor") {
                    harnesses.push({ id: row.id });
                  }
                }
                return { ok: true, value: { harnesses } };
              },
            }),
          },
        },
      },
    });
    const result = checkSurfaceCompatibility({
      mine: surfaceOfUnary(mine),
      theirs: released,
      theirsLabel: "released",
      exceptions: [],
    });
    const catalogBlocking = result.blocking.filter(
      (finding) =>
        finding.method === "agent.gui.listHarnesses" &&
        finding.payload === "response",
    );
    expect(catalogBlocking).toEqual([]);
  });

  it("request enum add stays advisory", () => {
    const requestV10 = z.object({ a: z.string(), mode: z.enum(["x"]) });
    const requestV10Plus = z.object({
      a: z.string(),
      mode: z.enum(["x", "y"]),
    });
    const result = checkSurfaceCompatibility({
      mine: surfaceOfUnary(defineVersionedRpcRegistry({
        "host.echo": unaryV10(requestV10Plus, baseResponse),
      })),
      theirs: surfaceOfUnary(defineVersionedRpcRegistry({
        "host.echo": unaryV10(requestV10, baseResponse),
      })),
      theirsLabel: "released",
      exceptions: [],
    });
    const requestFindings = result.findings.filter(
      (finding) =>
        finding.method === "host.echo" &&
        finding.payload === "request" &&
        finding.path?.includes("enum"),
    );
    expect(requestFindings.length).toBeGreaterThanOrEqual(1);
    expect(requestFindings.every((f) => f.severity === "advisory")).toBe(true);
    expect(result.blocking.filter((f) => f.payload === "request")).toEqual([]);
  });
});

describe("exception pattern matching", () => {
  it("matchPathGlob supports ** and bracket-safe segments", () => {
    expect(
      matchPathGlob(
        "**.harnessId.enum",
        "properties.source.properties.harnessId.enum",
      ),
    ).toBe(true);
    expect(
      matchPathGlob(
        "**.providerId.enum",
        "properties.state.anyOf[object].properties.providerId.enum",
      ),
    ).toBe(true);
    expect(matchMethodGlob("providers.set*", "providers.setApiKey")).toBe(true);
    expect(matchMethodGlob("providers.set*", "providers.list")).toBe(false);
  });

  it("rejects exceptions that cover catalog host→client methods", () => {
    const problems = validateCompatExceptions([
      {
        family: "unary",
        method: "agent.list",
        version: "*",
        payload: "response",
        path: "**.enum",
        reason: "should be rejected",
      },
    ]);
    expect(problems.length).toBeGreaterThanOrEqual(1);
    expect(() =>
      parseCompatExceptionsFile({
        exceptions: [
          {
            family: "unary",
            method: "providers.list",
            version: "*",
            payload: "response",
            path: "**.enum",
            reason: "should be rejected",
          },
        ],
      }),
    ).toThrow(/catalog method/);
  });

  it("serverFrame variant add is breaking unless excepted", () => {
    const openRequest = z.object({ chatId: z.string() });
    const clientFrame = z.object({ kind: z.literal("ping") });
    const serverFrameReleased = z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("ready") }),
    ]);
    const serverFrameMine = z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("ready") }),
      z.object({ kind: z.literal("extra"), harnessId: z.literal("devin") }),
    ]);

    function streamSurface(serverFrame: z.ZodType) {
      return buildProtocolSurface({
        unary: defineVersionedRpcRegistry({
          "host.echo": unaryV10(baseRequest, baseResponse),
        }),
        unaryFloorMethodNames: ["host.echo"],
        stream: defineVersionedStreamRpcRegistry({
          "chat.subscribe": {
            1: {
              latestMinor: 0,
              versions: {
                0: {
                  contract: defineStreamRpcContract({
                    method: "chat.subscribe",
                    schemaVersion: { major: 1, minor: 0 } as const,
                    openRequestSchema: openRequest,
                    serverFrameSchema: serverFrame,
                    clientFrameSchema: clientFrame,
                  }),
                  upgradeFromPreviousVersion: null,
                },
              },
              downgradePathsFromLatest: {},
            },
          },
        }),
      });
    }

    const withoutException = checkSurfaceCompatibility({
      mine: streamSurface(serverFrameMine),
      theirs: streamSurface(serverFrameReleased),
      theirsLabel: "released",
      exceptions: [],
    });
    const blocking = withoutException.blocking.filter(
      (finding) =>
        finding.method === "chat.subscribe" &&
        finding.payload === "serverFrame",
    );
    expect(blocking.length).toBeGreaterThanOrEqual(1);
    expect(blocking[0].severity).toBe("breaking");

    const withException = checkSurfaceCompatibility({
      mine: streamSurface(serverFrameMine),
      theirs: streamSurface(serverFrameReleased),
      theirsLabel: "released",
      exceptions: [
        {
          family: "stream",
          method: "chat.subscribe",
          version: "*",
          payload: "serverFrame",
          path: "anyOf[*]",
          reason: "gated stream growth",
        },
      ],
    });
    expect(
      withException.blocking.filter(
        (finding) =>
          finding.method === "chat.subscribe" &&
          finding.payload === "serverFrame",
      ),
    ).toEqual([]);
    expect(
      withException.findings.some(
        (finding) =>
          finding.method === "chat.subscribe" &&
          finding.excepted &&
          finding.severity === "breaking",
      ),
    ).toBe(true);
  });
});

describe("catalog methods at the oracle boundary", () => {
  it("a hand-built exception never suppresses catalog host→client growth", () => {
    const catalogContract = (harnessIds: readonly [string, ...string[]]) =>
      defineRpcContract({
        method: "agent.gui.listHarnesses",
        schemaVersion: { major: 1, minor: 0 } as const,
        requestSchema: z.object({}),
        responseSchema: z.object({
          harnesses: z.array(z.enum(harnessIds)),
        }),
      });
    const catalogRegistry = (harnessIds: readonly [string, ...string[]]) =>
      defineVersionedRpcRegistry({
        "agent.gui.listHarnesses": {
          1: {
            latestMinor: 0,
            versions: {
              0: {
                contract: catalogContract(harnessIds),
                upgradeFromPreviousVersion: null,
              },
            },
            downgradePathsFromLatest: {},
          },
        },
      });

    // This exceptions array deliberately bypasses parseCompatExceptionsFile
    // (which rejects it at load time) to prove the oracle itself refuses it.
    const result = checkSurfaceCompatibility({
      mine: surfaceOfUnary(catalogRegistry(["amp", "devin"])),
      theirs: surfaceOfUnary(catalogRegistry(["amp"])),
      theirsLabel: "released",
      exceptions: [
        {
          family: "unary",
          method: "agent.gui.listHarnesses",
          version: "*",
          payload: "response",
          path: "**",
          reason: "attempted catalog grandfathering",
        },
      ],
    });

    const catalogFindings = result.blocking.filter(
      (finding) =>
        finding.method === "agent.gui.listHarnesses" &&
        finding.payload === "response",
    );
    expect(catalogFindings).toHaveLength(1);
    expect(catalogFindings[0].excepted).toBe(false);
    expect(catalogFindings[0].severity).toBe("breaking");
  });
});
