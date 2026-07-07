import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineDowngradePath,
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
import { buildProtocolSurface } from "@traycer/protocol/framework/surface-build";
import {
  checkSurfaceCompatibility,
  manifestFromSurface,
  type CompatException,
} from "@traycer/protocol/framework/surface-compat";
import type { UncheckedVersionedRpcRegistry } from "@traycer/protocol/framework/versioned-rpc-types";
import type { UncheckedVersionedStreamRpcRegistry } from "@traycer/protocol/framework/versioned-stream-rpc";

const EMPTY_STREAM: UncheckedVersionedStreamRpcRegistry = {};

function surfaceOfUnary(unary: UncheckedVersionedRpcRegistry) {
  return buildProtocolSurface({ unary, stream: EMPTY_STREAM });
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
            1: defineDowngradePath<
              typeof breakingContract,
              typeof upgraded
            >({
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
    const mine = buildProtocolSurface({ unary: {}, stream: mineRegistry });
    const theirs = buildProtocolSurface({ unary: {}, stream: theirsRegistry });

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
      stream: streamRegistryAt(1),
    });
    const theirs = buildProtocolSurface({ unary: {}, stream: {} });
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
    const mine = buildProtocolSurface({ unary: {}, stream: {} });
    const theirs = buildProtocolSurface({
      unary: {},
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
  it("accepts adding an optional property", () => {
    const mine = defineVersionedRpcRegistry({
      "host.echo": unaryV10(
        baseRequest.extend({ extra: z.string().optional() }),
        baseResponse,
      ),
    });
    expect(blockingOf(mine, [])).toEqual([]);
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
      "host.echo": unaryV10(z.object({ a: z.string().optional() }), baseResponse),
    });
    expect(blockingOf(demoted, []).map((finding) => finding.path)).toEqual([
      "properties.a",
    ]);
  });

  it("reports enum value additions as advisory (feature-gated additive growth)", () => {
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
