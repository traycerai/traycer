import { z } from "zod";
import {
  surfaceVersionKey,
  type ProtocolSurface,
  type SurfaceMethod,
  type SurfaceVersion,
} from "@traycer/protocol/framework/surface-build";

/**
 * Released-peer compatibility oracle over dumped protocol surfaces.
 *
 * Compares the working tree's surface ("mine") against a surface dumped from
 * an immutable released tag ("theirs") and reports every way a peer running
 * that release would fail against a peer built from this tree. Severities
 * mirror the SHIPPED transports' actual behavior:
 *
 * - **fatal** (unary handshake): a `/rpc` method name present on one side
 *   only, or canonical versions neither side can bridge. The unary open-frame
 *   check is fail-closed for the whole connection
 *   (`compatibility-checker.check`), so these kill every RPC. Never
 *   exceptable.
 * - **breaking** (blocking, exceptable): released peers lose something they
 *   shipped with - a stream method removed or version-unbridgeable (streams
 *   check per-method at subscribe time and degrade, so this is a feature
 *   outage rather than a dead connection), or a same-version wire-schema
 *   change that makes existing payloads unparseable (removed/renamed
 *   properties, required-set changes, removed enum values or union variants,
 *   structural type changes).
 * - **advisory** (reported, non-blocking): additive growth the codebase
 *   deliberately practices behind feature gating - new enum values, new
 *   union variants, and new stream methods. An old peer only meets these
 *   values when a flow it does not have triggers them; the risk is accepted
 *   and visible in the report rather than silently ignored.
 *
 * Deliberate `breaking` tolerances are recorded in a reviewed exceptions
 * file, matched by exact finding coordinates.
 *
 * Pure data-in/data-out - no registry imports - so a single checker built
 * from the PR tree can adjudicate surfaces dumped from arbitrary old tags.
 * `surface-compat.test.ts` pins its bridging verdicts to the real
 * `compatibility-checker`/`stream-compat` oracles so the mirror cannot drift.
 */

const surfaceVersionSchema = z.object({
  major: z.number().int(),
  minor: z.number().int(),
});

const surfaceMajorLineSchema = z.object({
  latestMinor: z.number().int(),
  installedMinors: z.array(z.number().int()),
  downgradeTargets: z.array(z.number().int()),
});

const surfaceMethodSchema = z.object({
  canonical: surfaceVersionSchema,
  majors: z.record(z.string(), surfaceMajorLineSchema),
  schemas: z.record(z.string(), z.record(z.string(), z.unknown())),
});

/** Boundary parser for surface JSON files produced by `dump-protocol-surface.ts`. */
export const protocolSurfaceSchema = z.object({
  formatVersion: z.number().int(),
  unary: z.record(z.string(), surfaceMethodSchema),
  stream: z.record(z.string(), surfaceMethodSchema),
});

export type SurfaceFamily = "unary" | "stream";

export const compatExceptionSchema = z.object({
  family: z.enum(["unary", "stream"]),
  method: z.string().min(1),
  /** `"M.m"` version key the tolerated schema divergence lives at. */
  version: z.string().min(1),
  /** Payload slot: request/response (unary) or openRequest/serverFrame/clientFrame (stream). */
  payload: z.string().min(1),
  /** Exact finding path, e.g. `properties.harnesses.items.enum`. */
  path: z.string().min(1),
  reason: z.string().min(1),
});
export type CompatException = z.infer<typeof compatExceptionSchema>;

export const compatExceptionsFileSchema = z.object({
  exceptions: z.array(compatExceptionSchema),
});

export type CompatSeverity = "fatal" | "breaking" | "advisory";

export type CompatFinding = {
  readonly family: SurfaceFamily;
  readonly method: string;
  readonly severity: CompatSeverity;
  /** `"M.m"` for schema findings; null for handshake findings. */
  readonly version: string | null;
  readonly payload: string | null;
  /** JSON-schema path for schema findings; null for handshake findings. */
  readonly path: string | null;
  readonly detail: string;
  /** True when a reviewed exception suppresses this finding. */
  readonly excepted: boolean;
};

export type SurfaceCompatibilityResult = {
  readonly findings: readonly CompatFinding[];
  /**
   * Fatal/breaking findings not covered by an exception - non-empty means
   * incompatible. Advisory findings never block.
   */
  readonly blocking: readonly CompatFinding[];
};

function formatVersionValue(version: SurfaceVersion): string {
  return `${version.major}.${version.minor}`;
}

/**
 * Mirror of `compatibility-checker.canBridgeFromMySide`, driven by dumped
 * surface data instead of a live registry.
 */
function canBridgeUnaryFromSurface(
  mine: SurfaceMethod,
  myVersion: SurfaceVersion,
  theirVersion: SurfaceVersion,
): boolean {
  if (
    myVersion.major === theirVersion.major &&
    myVersion.minor === theirVersion.minor
  ) {
    return true;
  }
  if (myVersion.major < theirVersion.major) {
    return true;
  }
  const line = mine.majors[String(myVersion.major)];
  if (line === undefined) {
    return false;
  }
  if (myVersion.major === theirVersion.major) {
    if (myVersion.minor < theirVersion.minor) {
      return true;
    }
    return line.installedMinors.includes(theirVersion.minor);
  }
  return line.downgradeTargets.includes(theirVersion.major);
}

/**
 * Mirror of `stream-compat.canBridgeStream`: same-major only, the newer side
 * must have the older minor installed; cross-major is handshake-fatal.
 */
function canBridgeStreamFromSurface(
  mine: SurfaceMethod,
  myVersion: SurfaceVersion,
  theirVersion: SurfaceVersion,
): boolean {
  if (myVersion.major !== theirVersion.major) {
    return false;
  }
  if (myVersion.minor <= theirVersion.minor) {
    return true;
  }
  const line = mine.majors[String(myVersion.major)];
  if (line === undefined) {
    return false;
  }
  return line.installedMinors.includes(theirVersion.minor);
}

type JsonObjectSchema = {
  readonly properties: Readonly<Record<string, unknown>>;
  readonly required: readonly string[];
};

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Readonly<Record<string, unknown>>;
}

function asObjectSchema(value: unknown): JsonObjectSchema | null {
  const record = asRecord(value);
  if (record === null || record["type"] !== "object") {
    return null;
  }
  const properties = asRecord(record["properties"]);
  if (properties === null) {
    return null;
  }
  const required = record["required"];
  const requiredList = Array.isArray(required)
    ? required.filter((entry): entry is string => typeof entry === "string")
    : [];
  return { properties, required: requiredList };
}

function asEnumValues(value: unknown): readonly unknown[] | null {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }
  const values = record["enum"];
  return Array.isArray(values) ? values : null;
}

function isUnavailableSentinel(value: unknown): boolean {
  const record = asRecord(value);
  return record !== null && record["$unavailable"] !== undefined;
}

function asArraySchema(value: unknown): unknown | null {
  const record = asRecord(value);
  if (record === null || record["type"] !== "array") {
    return null;
  }
  return record["items"] ?? null;
}

function asAnyOfVariants(value: unknown): readonly unknown[] | null {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }
  const variants = record["anyOf"] ?? record["oneOf"];
  return Array.isArray(variants) ? variants : null;
}

/**
 * Stable identity for a union variant so the two sides' variants can be
 * paired for recursive diffing. Discriminated-union variants are identified
 * by their const-valued properties (e.g. `kind: "user_message"`); other
 * variants (nullable arms, primitive unions) fall back to their JSON-Schema
 * `type`. Returns null when signatures do not uniquely identify variants on
 * either side - the caller then falls back to whole-value comparison.
 */
/** Browser-safe FNV-1a hash for capping unwieldy variant signatures. */
function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

function variantSignature(variant: unknown): string {
  const record = asRecord(variant);
  if (record === null) {
    return stableStringify(variant);
  }
  if (record["const"] !== undefined) {
    return `const:${stableStringify(record["const"])}`;
  }
  if (Array.isArray(record["anyOf"]) || Array.isArray(record["oneOf"])) {
    // A nested union arm (e.g. the non-null side of a nullable union). One
    // such arm per side is the norm; recursion pairs its inner variants.
    return "anyOf";
  }
  const properties = asRecord(record["properties"]);
  if (properties !== null) {
    const consts: Record<string, unknown> = {};
    for (const key of Object.keys(properties)) {
      const property = asRecord(properties[key]);
      if (property !== null && property["const"] !== undefined) {
        consts[key] = property["const"];
      }
    }
    if (Object.keys(consts).length > 0) {
      const signature = stableStringify(consts);
      return signature.length > 64 ? `sig:${shortHash(signature)}` : signature;
    }
    return "object";
  }
  const type = record["type"];
  if (typeof type === "string") {
    return `type:${type}`;
  }
  const fallback = stableStringify(variant);
  return fallback.length > 64 ? `sig:${shortHash(fallback)}` : fallback;
}

type VariantMatch = {
  readonly pairs: readonly {
    readonly signature: string;
    readonly theirs: unknown;
    readonly mine: unknown;
  }[];
  readonly removedFromMine: readonly string[];
  readonly addedInMine: readonly string[];
};

function matchVariants(
  theirs: readonly unknown[],
  mine: readonly unknown[],
): VariantMatch | null {
  const theirBySignature = new Map<string, unknown>();
  for (const variant of theirs) {
    const signature = variantSignature(variant);
    if (theirBySignature.has(signature)) {
      return null;
    }
    theirBySignature.set(signature, variant);
  }
  const mineBySignature = new Map<string, unknown>();
  for (const variant of mine) {
    const signature = variantSignature(variant);
    if (mineBySignature.has(signature)) {
      return null;
    }
    mineBySignature.set(signature, variant);
  }
  const pairs: { signature: string; theirs: unknown; mine: unknown }[] = [];
  const removedFromMine: string[] = [];
  for (const [signature, theirVariant] of theirBySignature) {
    const mineVariant = mineBySignature.get(signature);
    if (mineVariant === undefined) {
      removedFromMine.push(signature);
      continue;
    }
    pairs.push({ signature, theirs: theirVariant, mine: mineVariant });
  }
  const addedInMine = [...mineBySignature.keys()].filter(
    (signature) => !theirBySignature.has(signature),
  );
  return { pairs, removedFromMine, addedInMine };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = asRecord(value);
  if (record !== null) {
    const body = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",");
    return `{${body}}`;
  }
  return JSON.stringify(value);
}

type SchemaDivergence = {
  readonly path: string;
  readonly detail: string;
  readonly severity: "breaking" | "advisory";
};

function joinPath(parent: string, segment: string): string {
  return parent.length === 0 ? segment : `${parent}.${segment}`;
}

/**
 * Directional-safety diff between the released schema (`theirs`) and the
 * working tree's schema (`mine`) for the SAME negotiated version. Because a
 * registry ships on both ends, every reported divergence is one that breaks
 * at least one deployment direction:
 *
 * - required-set changes break the side that omits the newly-required (or
 *   still-requires the now-optional-and-omitted) property;
 * - a property added as REQUIRED breaks released senders that don't produce it;
 * - removing a property the released side requires breaks released receivers;
 * - enum value-set changes break whichever released side parses the value
 *   the other side no longer/newly produces;
 * - any other structural change (type, items, variants) must be deep-equal.
 */
function diffSchemasAtSameVersion(
  theirs: unknown,
  mine: unknown,
  path: string,
): SchemaDivergence[] {
  if (isUnavailableSentinel(theirs) || isUnavailableSentinel(mine)) {
    // One side could not serialize this schema - nothing to compare. Layer-1
    // handshake checking still applies to the method.
    return [];
  }

  const theirObject = asObjectSchema(theirs);
  const mineObject = asObjectSchema(mine);
  if (theirObject !== null && mineObject !== null) {
    const divergences: SchemaDivergence[] = [];
    const theirRequired = new Set(theirObject.required);
    const mineRequired = new Set(mineObject.required);

    for (const property of Object.keys(theirObject.properties)) {
      const propertyPath = joinPath(path, `properties.${property}`);
      if (!(property in mineObject.properties)) {
        if (theirRequired.has(property)) {
          divergences.push({
            path: propertyPath,
            severity: "breaking",
            detail:
              "property required by the released schema was removed - payloads built from this tree omit it and released peers fail to parse them",
          });
        }
        // Removing a property the released side treats as optional is safe:
        // released senders' extra key is stripped, released receivers accept
        // its absence.
        continue;
      }
      if (theirRequired.has(property) && !mineRequired.has(property)) {
        divergences.push({
          path: propertyPath,
          severity: "breaking",
          detail:
            "property demoted from required to optional - payloads built from this tree may omit it and released peers fail to parse them",
        });
      }
      if (!theirRequired.has(property) && mineRequired.has(property)) {
        divergences.push({
          path: propertyPath,
          severity: "breaking",
          detail:
            "property promoted from optional to required - released peers may omit it and this tree fails to parse their payloads",
        });
      }
      divergences.push(
        ...diffSchemasAtSameVersion(
          theirObject.properties[property],
          mineObject.properties[property],
          propertyPath,
        ),
      );
    }

    for (const property of Object.keys(mineObject.properties)) {
      if (property in theirObject.properties) {
        continue;
      }
      if (mineRequired.has(property)) {
        divergences.push({
          path: joinPath(path, `properties.${property}`),
          severity: "breaking",
          detail:
            "new property added as required - released peers do not produce it and this tree fails to parse their payloads",
        });
      }
      // Added optional properties are safe in both directions: released
      // receivers strip the unknown key, this tree accepts its absence.
    }

    return divergences;
  }

  const theirArray = asArraySchema(theirs);
  const mineArray = asArraySchema(mine);
  if (theirArray !== null && mineArray !== null) {
    return diffSchemasAtSameVersion(
      theirArray,
      mineArray,
      joinPath(path, "items"),
    );
  }

  const theirVariants = asAnyOfVariants(theirs);
  const mineVariants = asAnyOfVariants(mine);
  if (theirVariants !== null && mineVariants !== null) {
    const matched = matchVariants(theirVariants, mineVariants);
    if (matched !== null) {
      const divergences: SchemaDivergence[] = [];
      for (const pair of matched.pairs) {
        divergences.push(
          ...diffSchemasAtSameVersion(
            pair.theirs,
            pair.mine,
            joinPath(path, `anyOf[${pair.signature}]`),
          ),
        );
      }
      for (const signature of matched.removedFromMine) {
        divergences.push({
          path: joinPath(path, `anyOf[${signature}]`),
          severity: "breaking",
          detail:
            "union variant removed - released peers may still send it and this tree fails to parse",
        });
      }
      for (const signature of matched.addedInMine) {
        divergences.push({
          path: joinPath(path, `anyOf[${signature}]`),
          severity: "advisory",
          detail:
            "union variant added at a released version - safe only while feature-gated (released peers fail to parse payloads that carry it)",
        });
      }
      return divergences;
    }
  }

  const theirEnum = asEnumValues(theirs);
  const mineEnum = asEnumValues(mine);
  if (theirEnum !== null && mineEnum !== null) {
    const stripEnum = (value: unknown): Record<string, unknown> => {
      const { enum: _values, ...rest } = asRecord(value) ?? {};
      return rest;
    };
    if (stableStringify(stripEnum(theirs)) !== stableStringify(stripEnum(mine))) {
      return [
        {
          path: path.length === 0 ? "(root)" : path,
          severity: "breaking",
          detail:
            "enum schema changed beyond its value set (e.g. representation type) at an already-released version",
        },
      ];
    }
    const theirSet = new Set(theirEnum.map(stableStringify));
    const mineSet = new Set(mineEnum.map(stableStringify));
    const added = [...mineSet].filter((value) => !theirSet.has(value));
    const removed = [...theirSet].filter((value) => !mineSet.has(value));
    const divergences: SchemaDivergence[] = [];
    if (added.length > 0) {
      divergences.push({
        path: joinPath(path, "enum"),
        severity: "advisory",
        detail: `enum values added at a released version (${added.join(", ")}) - safe only while feature-gated (released peers fail to parse payloads that carry them)`,
      });
    }
    if (removed.length > 0) {
      divergences.push({
        path: joinPath(path, "enum"),
        severity: "breaking",
        detail: `enum values removed (${removed.join(", ")}) - released peers may still send them and this tree fails to parse`,
      });
    }
    return divergences;
  }

  if (stableStringify(theirs) !== stableStringify(mine)) {
    return [
      {
        path: path.length === 0 ? "(root)" : path,
        severity: "breaking",
        detail:
          "schema changed structurally at an already-released version - ship the change as a version bump instead",
      },
    ];
  }
  return [];
}

function checkFamily(
  family: SurfaceFamily,
  mine: Readonly<Record<string, SurfaceMethod>>,
  theirs: Readonly<Record<string, SurfaceMethod>>,
  theirsLabel: string,
  canBridge: (
    side: SurfaceMethod,
    myVersion: SurfaceVersion,
    theirVersion: SurfaceVersion,
  ) => boolean,
  isExcepted: (finding: Omit<CompatFinding, "excepted">) => boolean,
): CompatFinding[] {
  const findings: CompatFinding[] = [];
  const methods = [...new Set([...Object.keys(mine), ...Object.keys(theirs)])]
    .sort();

  const pushFinding = (finding: Omit<CompatFinding, "excepted">): void => {
    findings.push({ ...finding, excepted: isExcepted(finding) });
  };

  // The unary `/rpc` open-frame check is fail-closed for the whole
  // connection, so unary handshake mismatches are fatal. Streams check
  // per-method at subscribe time and degrade (`onMethodSupport`), so a
  // stream mismatch is a per-feature outage: a method the released peer
  // never had is advisory (it degrades there by design - the
  // `resources.subscribe` precedent), while removing or un-bridging a
  // method the released peer shipped with is breaking.
  const handshakeSeverity: CompatSeverity =
    family === "unary" ? "fatal" : "breaking";

  for (const method of methods) {
    const mineMethod = mine[method];
    const theirsMethod = theirs[method];

    if (mineMethod === undefined || theirsMethod === undefined) {
      const missingFromMine = mineMethod === undefined;
      const missingSide = missingFromMine
        ? `missing from this tree but advertised by ${theirsLabel}`
        : `missing from ${theirsLabel} but advertised by this tree`;
      pushFinding({
        family,
        method,
        severity:
          family === "stream" && !missingFromMine
            ? "advisory"
            : handshakeSeverity,
        version: null,
        payload: null,
        path: null,
        detail:
          family === "unary"
            ? `handshake-fatal method-name mismatch: ${missingSide} - every RPC on the connection fails`
            : `stream method-name mismatch: ${missingSide} - the subscription degrades as unsupported on the side that lacks it`,
      });
      continue;
    }

    const mineCanonical = mineMethod.canonical;
    const theirsCanonical = theirsMethod.canonical;
    if (!canBridge(mineMethod, mineCanonical, theirsCanonical)) {
      pushFinding({
        family,
        method,
        severity: handshakeSeverity,
        version: null,
        payload: null,
        path: null,
        detail: `this tree (canonical ${formatVersionValue(mineCanonical)}) cannot bridge ${theirsLabel}'s canonical ${formatVersionValue(theirsCanonical)}`,
      });
    }
    if (!canBridge(theirsMethod, theirsCanonical, mineCanonical)) {
      pushFinding({
        family,
        method,
        severity: handshakeSeverity,
        version: null,
        payload: null,
        path: null,
        detail: `${theirsLabel} (canonical ${formatVersionValue(theirsCanonical)}) cannot bridge this tree's canonical ${formatVersionValue(mineCanonical)}`,
      });
    }

    for (const versionKey of Object.keys(theirsMethod.schemas).sort()) {
      const mineSlots = mineMethod.schemas[versionKey];
      if (mineSlots === undefined) {
        // The version is not installed here; whether that matters for the
        // handshake is already covered by the bridging verdicts above.
        continue;
      }
      const theirSlots = theirsMethod.schemas[versionKey];
      for (const slot of Object.keys(theirSlots).sort()) {
        if (!(slot in mineSlots)) {
          continue;
        }
        for (const divergence of diffSchemasAtSameVersion(
          theirSlots[slot],
          mineSlots[slot],
          "",
        )) {
          pushFinding({
            family,
            method,
            severity: divergence.severity,
            version: versionKey,
            payload: slot,
            path: divergence.path,
            detail: `wire schema diverges from ${theirsLabel} at negotiated version ${versionKey}: ${divergence.detail}`,
          });
        }
      }
    }
  }

  return findings;
}

/**
 * Full two-sided compatibility verdict of this tree's surface against one
 * released baseline surface. `blocking` (findings with no reviewed exception)
 * must be empty for the gate to pass.
 */
export function checkSurfaceCompatibility(args: {
  readonly mine: ProtocolSurface;
  readonly theirs: ProtocolSurface;
  readonly theirsLabel: string;
  readonly exceptions: readonly CompatException[];
}): SurfaceCompatibilityResult {
  const isExcepted = (finding: Omit<CompatFinding, "excepted">): boolean =>
    finding.severity === "breaking" &&
    args.exceptions.some(
      (exception) =>
        exception.family === finding.family &&
        exception.method === finding.method &&
        exception.version === finding.version &&
        exception.payload === finding.payload &&
        exception.path === finding.path,
    );

  const findings = [
    ...checkFamily(
      "unary",
      args.mine.unary,
      args.theirs.unary,
      args.theirsLabel,
      canBridgeUnaryFromSurface,
      isExcepted,
    ),
    ...checkFamily(
      "stream",
      args.mine.stream,
      args.theirs.stream,
      args.theirsLabel,
      canBridgeStreamFromSurface,
      isExcepted,
    ),
  ];

  return {
    findings,
    blocking: findings.filter(
      (finding) => finding.severity !== "advisory" && !finding.excepted,
    ),
  };
}

/** Canonical handshake manifest (method -> version) from a surface family. */
export function manifestFromSurface(
  surface: ProtocolSurface,
  family: SurfaceFamily,
): Readonly<Record<string, SurfaceVersion>> {
  const methods = family === "unary" ? surface.unary : surface.stream;
  const manifest: Record<string, SurfaceVersion> = {};
  for (const method of Object.keys(methods)) {
    manifest[method] = methods[method].canonical;
  }
  return manifest;
}

export { surfaceVersionKey };
