import { z } from "zod";
import type { UncheckedVersionedRpcRegistry } from "@traycer/protocol/framework/versioned-rpc-types";
import type { UncheckedVersionedStreamRpcRegistry } from "@traycer/protocol/framework/versioned-stream-rpc";

/**
 * Protocol-surface serialization for the released-peer compatibility gate.
 *
 * A "surface" is a registry reduced to plain JSON: per method, the canonical
 * `{ major, minor }` a peer advertises at the handshake, the installed
 * version/bridge graph the compatibility checkers walk, and a canonicalized
 * JSON Schema per installed version for wire-shape diffing. CI dumps this
 * from an immutable released tag and compares the working tree against it -
 * the baseline never lives in the PR-editable tree, so a red check cannot be
 * silenced by editing a fixture (the failure mode that let `terminal.defaultCwd`
 * ship handshake-incompatible in #227).
 *
 * BACKFILL CONSTRAINT: this module (and the `dump-protocol-surface.ts` CLI
 * that wraps it) is copied verbatim into checkouts of already-released tags
 * that predate it. Its runtime imports must therefore stay limited to `zod`;
 * type-only imports are erased before execution and are safe. Do not import
 * other framework modules at runtime.
 */

export const SURFACE_FORMAT_VERSION = 1;

/** Version key inside a surface: `"<major>.<minor>"`. */
export function surfaceVersionKey(major: number, minor: number): string {
  return `${major}.${minor}`;
}

export type SurfaceVersion = {
  readonly major: number;
  readonly minor: number;
};

export type SurfaceMajorLine = {
  readonly latestMinor: number;
  readonly installedMinors: readonly number[];
  /** Majors reachable via `downgradePathsFromLatest`. Always [] for streams. */
  readonly downgradeTargets: readonly number[];
};

/**
 * One method's surface. `schemas` maps `"M.m"` to a record of payload slots
 * (`request`/`response` for unary; `openRequest`/`serverFrame`/`clientFrame`
 * for streams), each a canonicalized JSON Schema. When the dumping tree's zod
 * cannot serialize a schema, the slot holds `{ "$unavailable": <reason> }` and
 * schema-level diffing is skipped for it.
 */
export type SurfaceMethod = {
  readonly canonical: SurfaceVersion;
  readonly majors: Readonly<Record<string, SurfaceMajorLine>>;
  readonly schemas: Readonly<
    Record<string, Readonly<Record<string, unknown>>>
  >;
};

export type ProtocolSurface = {
  readonly formatVersion: number;
  readonly unary: Readonly<Record<string, SurfaceMethod>>;
  readonly stream: Readonly<Record<string, SurfaceMethod>>;
};

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortKeysDeep(record[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Canonicalized JSON Schema for one zod schema, or an `$unavailable` sentinel
 * when the tree's zod cannot represent it (old zod without `toJSONSchema`, or
 * a schema kind the converter rejects). The sentinel keeps Layer-1 handshake
 * checking fully functional against trees whose schemas cannot be dumped.
 */
function serializeSchema(schema: z.ZodType): unknown {
  // Property read (not a call) so trees whose zod predates `toJSONSchema`
  // degrade to the sentinel instead of throwing at dump time.
  const converter: unknown = z.toJSONSchema;
  if (typeof converter !== "function") {
    return { $unavailable: "zod.toJSONSchema is not available in this tree" };
  }
  try {
    // `io: "input"` - wire compatibility is about what a receiver ACCEPTS.
    return sortKeysDeep(
      (converter as (s: z.ZodType, opts: object) => unknown)(schema, {
        unrepresentable: "any",
        io: "input",
      }),
    );
  } catch (error) {
    return { $unavailable: `toJSONSchema failed: ${String(error)}` };
  }
}

function numberKeys(record: Readonly<Record<number, unknown>>): number[] {
  return Object.keys(record)
    .map(Number)
    .sort((a, b) => a - b);
}

type UnarySchemaCarrier = {
  readonly requestSchema: z.ZodType;
  readonly responseSchema: z.ZodType;
};

type StreamSchemaCarrier = {
  readonly openRequestSchema: z.ZodType;
  readonly serverFrameSchema: z.ZodType;
  readonly clientFrameSchema: z.ZodType;
};

function buildMethodSurface(
  majors: Readonly<
    Record<
      number,
      {
        readonly latestMinor: number;
        readonly versions: Readonly<Record<number, { readonly contract: object }>>;
        readonly downgradeTargets: readonly number[];
      }
    >
  >,
  schemaSlots: (contract: object) => Readonly<Record<string, unknown>>,
): SurfaceMethod {
  const majorKeys = numberKeys(majors);
  const highestMajor = majorKeys[majorKeys.length - 1];
  const majorLines: Record<string, SurfaceMajorLine> = {};
  const schemas: Record<string, Readonly<Record<string, unknown>>> = {};

  for (const major of majorKeys) {
    const line = majors[major];
    const installedMinors = numberKeys(line.versions);
    majorLines[String(major)] = {
      latestMinor: line.latestMinor,
      installedMinors,
      downgradeTargets: line.downgradeTargets,
    };
    for (const minor of installedMinors) {
      schemas[surfaceVersionKey(major, minor)] = schemaSlots(
        line.versions[minor].contract,
      );
    }
  }

  return {
    canonical: {
      major: highestMajor,
      minor: majors[highestMajor].latestMinor,
    },
    majors: majorLines,
    schemas,
  };
}

/**
 * Reduces the live unary + stream registries to a plain-JSON protocol
 * surface. Accepts the unchecked structural registry shapes so both the
 * validated branded registries and raw literals (tests) can be passed.
 */
export function buildProtocolSurface(args: {
  readonly unary: UncheckedVersionedRpcRegistry;
  readonly stream: UncheckedVersionedStreamRpcRegistry;
}): ProtocolSurface {
  const unary: Record<string, SurfaceMethod> = {};
  for (const method of Object.keys(args.unary).sort()) {
    const methodRegistry = args.unary[method];
    const majors: Record<
      number,
      {
        latestMinor: number;
        versions: Record<number, { contract: object }>;
        downgradeTargets: readonly number[];
      }
    > = {};
    for (const major of numberKeys(methodRegistry)) {
      const line = methodRegistry[major];
      majors[major] = {
        latestMinor: line.latestMinor,
        versions: line.versions,
        downgradeTargets: numberKeys(line.downgradePathsFromLatest),
      };
    }
    unary[method] = buildMethodSurface(majors, (contract) => {
      const carrier = contract as UnarySchemaCarrier;
      return {
        request: serializeSchema(carrier.requestSchema),
        response: serializeSchema(carrier.responseSchema),
      };
    });
  }

  const stream: Record<string, SurfaceMethod> = {};
  for (const method of Object.keys(args.stream).sort()) {
    const methodRegistry = args.stream[method];
    const majors: Record<
      number,
      {
        latestMinor: number;
        versions: Record<number, { contract: object }>;
        downgradeTargets: readonly number[];
      }
    > = {};
    for (const major of numberKeys(methodRegistry)) {
      const line = methodRegistry[major];
      majors[major] = {
        latestMinor: line.latestMinor,
        versions: line.versions,
        // v1 streams have no cross-major bridges; reconnect on major mismatch.
        downgradeTargets: [],
      };
    }
    stream[method] = buildMethodSurface(majors, (contract) => {
      const carrier = contract as StreamSchemaCarrier;
      return {
        openRequest: serializeSchema(carrier.openRequestSchema),
        serverFrame: serializeSchema(carrier.serverFrameSchema),
        clientFrame: serializeSchema(carrier.clientFrameSchema),
      };
    });
  }

  return { formatVersion: SURFACE_FORMAT_VERSION, unary, stream };
}
