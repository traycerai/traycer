import { z } from "zod";

/**
 * Normalized JSON-Schema fingerprint shared by the versioned-record
 * and versioned-rpc frameworks.
 *
 * Both families need the same structural diff (additivity within a
 * minor line, breaking change requirement on a major bump). Keeping
 * the helpers in one module means RPC contracts inherit the same
 * object/enum/anyOf/array support that records have, without the two
 * sides drifting on what counts as a breaking change.
 *
 * Schemas convert through `z.toJSONSchema` and are normalized into
 * one of four shapes; anything else fails the build at registry-load
 * time. New shapes can be added here when a new schema kind needs
 * registry-level treatment.
 */

/** Object-shaped fingerprint (z.object). */
export type ObjectJsonSchema = {
  readonly type: "object";
  readonly properties: Readonly<Record<string, unknown>>;
  readonly required: readonly string[];
};

/**
 * Enum-shaped fingerprint (z.enum, or z.union of same-typed literals).
 * Representation tracks the JSON Schema `type` so changing
 * string→number reads as a breaking change distinct from value-set
 * changes.
 */
export type EnumJsonSchema = {
  readonly type: "enum";
  readonly representation: "string" | "number" | "boolean" | "mixed";
  readonly values: readonly (string | number | boolean)[];
};

/** Discriminated-union fingerprint (z.union, z.discriminatedUnion). */
export type AnyOfJsonSchema = {
  readonly type: "anyOf";
  readonly variants: readonly JsonSchemaFingerprint[];
};

/**
 * Array fingerprint (z.array). Bounds are carried because they constrain the
 * payload independently of `items`: normalizing them away would make a root
 * array's `.max(1)` -> `.max(2)` widening invisible (nested arrays keep their
 * raw JSON Schema node, so only the normalized root lost them).
 */
export type ArrayJsonSchema = {
  readonly type: "array";
  readonly items: JsonSchemaFingerprint;
  readonly minItems?: number;
  readonly maxItems?: number;
};

/**
 * Normalized fingerprint covering every shape the framework accepts.
 * Pattern-matching on `.type` makes the compiler surface unhandled
 * cases when a new shape is added.
 */
export type JsonSchemaFingerprint =
  ObjectJsonSchema | EnumJsonSchema | AnyOfJsonSchema | ArrayJsonSchema;

/**
 * Converts a Zod schema to its normalized fingerprint. Throws when
 * the schema is none of object / enum / anyOf / array.
 *
 * `unrepresentable: "any"` lets `z.date()` / `z.coerce.date()` round
 * through `z.toJSONSchema` - dates render as `{}` here, which is fine
 * since the framework only needs structural drift detection (added /
 * removed / changed fields), not the precise runtime shape of every
 * leaf.
 */
export function toJsonSchemaFingerprint(
  schema: z.ZodType,
  context: string,
): JsonSchemaFingerprint {
  return convertJsonSchemaShape(
    z.toJSONSchema(schema, { unrepresentable: "any" }),
    context,
  );
}

/**
 * The `io: "input"` rendering of `schema`, walked in lockstep with the
 * fingerprint so every node - including each union arm individually - can be
 * asked whether it REJECTS unknown keys rather than stripping them.
 *
 * This is load-bearing for additivity: "an added field just strips on
 * projection" is only true of a stripping object. A strict older schema
 * rejects the whole payload instead, so growing a strict object on a minor
 * breaks projection for every payload, not just ones using the new field -
 * the repo relies on exactly this distinction (see the `.strict()` note on
 * `rateLimitUsageRequestSchemaV10`).
 *
 * The default `io: "output"` rendering cannot express it - it emits
 * `additionalProperties: false` for stripping AND strict objects alike.
 * The `io: "input"` rendering can: it describes what the schema ACCEPTS, so
 * only a genuinely strict object carries `additionalProperties: false`.
 * A parallel tree rather than a flattened path set: union arms share a path,
 * so a path-keyed marker cannot say WHICH arm is strict. Walking the arms in
 * lockstep keeps the answer per-arm.
 */
export function toUnknownKeyTree(schema: z.ZodType): unknown {
  return z.toJSONSchema(schema, { unrepresentable: "any", io: "input" });
}

type UnknownKeySchemaNode = {
  readonly type?: unknown;
  readonly properties?: Record<string, unknown>;
  readonly additionalProperties?: unknown;
  readonly anyOf?: readonly unknown[];
  readonly oneOf?: readonly unknown[];
  readonly items?: unknown;
};

function asSchemaNode(node: unknown): UnknownKeySchemaNode | null {
  if (typeof node !== "object" || node === null) return null;
  return node as UnknownKeySchemaNode;
}

/**
 * Whether an object refuses to silently accept a key it does not declare -
 * either by rejecting outright (`additionalProperties: false`, i.e.
 * `.strict()`) or by VALIDATING unknown keys against a constraining catchall
 * (`.catchall(z.string())` renders as `additionalProperties: {type:"string"}`
 * and rejects a key of the wrong type). A permissive catchall
 * (`.catchall(z.unknown())` -> `additionalProperties: {}`) accepts anything,
 * so it strips-equivalent and growth stays safe.
 */
type UnknownKeyPolicy =
  /** Unknown keys are dropped before they reach the payload (plain `z.object`). */
  | { readonly kind: "strip" }
  /**
   * Unknown keys are accepted AND preserved (`.catchall(z.unknown())`, which
   * renders as `additionalProperties: {}`). Distinct from `strip`: a
   * stripping schema never emits an undeclared key, a passthrough one does.
   */
  | { readonly kind: "passthrough" }
  /** Unknown keys are rejected outright (`z.strictObject` / `.strict()`). */
  | { readonly kind: "reject" }
  /** Unknown keys are VALIDATED against a catchall schema. */
  | { readonly kind: "validate"; readonly schema: unknown };

function unknownKeyPolicy(node: unknown): UnknownKeyPolicy {
  const shape = asSchemaNode(node);
  if (shape === null) return { kind: "strip" };
  const additional = shape.additionalProperties;
  if (additional === false) return { kind: "reject" };
  if (typeof additional === "object" && additional !== null) {
    // An empty schema (`{}`, from `.catchall(z.unknown())`) constrains
    // nothing, so unknown keys sail through unvalidated - but they are
    // PRESERVED, not dropped; anything else validates them.
    return Object.keys(additional as Record<string, unknown>).length > 0
      ? { kind: "validate", schema: additional }
      : { kind: "passthrough" };
  }
  return { kind: "strip" };
}


/** Input-tree counterpart of an object property, for lockstep descent. */
function inputProperty(previousInput: unknown, field: string): unknown {
  const shape = asSchemaNode(previousInput);
  if (shape === null || shape.properties === undefined) return null;
  return Object.hasOwn(shape.properties, field)
    ? shape.properties[field]
    : null;
}

/** Input-tree counterpart of array items. */
function inputItems(previousInput: unknown): unknown {
  const shape = asSchemaNode(previousInput);
  return shape === null ? null : (shape.items ?? null);
}

/**
 * Input-tree counterparts of a union's arms, positionally. Both renderings
 * come from the same Zod schema, so variant order corresponds; when it does
 * not line up the entry is `null` and that arm degrades to non-strict.
 */
function inputVariants(previousInput: unknown): readonly unknown[] {
  const shape = asSchemaNode(previousInput);
  if (shape === null) return [];
  if (Array.isArray(shape.anyOf)) return shape.anyOf;
  if (Array.isArray(shape.oneOf)) return shape.oneOf;
  return [];
}

/**
 * Directional comparison of array-level constraints. A newer schema may only
 * tighten what it emits: a higher `maxItems` or a lower `minItems` lets it
 * produce arrays the older schema refuses.
 *
 * `uniqueItems` is deliberately not compared - `z.set(...)` renders as `{}`
 * under `unrepresentable: "any"`, so no schema in this repo can emit it.
 */
function arrayBoundsRelaxation(
  previous: unknown,
  next: unknown,
  path: readonly string[],
): AdditivityViolation | null {
  const previousShape = previous as {
    minItems?: unknown;
    maxItems?: unknown;
  } | null;
  const nextShape = next as {
    minItems?: unknown;
    maxItems?: unknown;
  } | null;
  if (
    typeof previousShape !== "object" ||
    previousShape === null ||
    typeof nextShape !== "object" ||
    nextShape === null
  ) {
    return null;
  }
  const location = path.length === 0 ? "<root>" : dottedPath(path);
  const previousMax = previousShape.maxItems;
  const nextMax = nextShape.maxItems;
  if (typeof previousMax === "number") {
    if (typeof nextMax !== "number" || nextMax > previousMax) {
      return { kind: "array-bounds", detail: `${location} maxItems` };
    }
  }
  const previousMin = previousShape.minItems;
  const nextMin = nextShape.minItems;
  if (typeof previousMin === "number") {
    if (typeof nextMin !== "number" || nextMin < previousMin) {
      return { kind: "array-bounds", detail: `${location} minItems` };
    }
  }
  return null;
}

/** Input-tree `required` list - what the older peer actually enforces. */
function inputRequired(input: unknown): readonly string[] | null {
  const shape = asSchemaNode(input);
  // No input tree available -> caller falls back to the output fingerprint.
  if (shape === null || shape.properties === undefined) return null;
  const required = (shape as { required?: unknown }).required;
  // An object node with NO `required` array requires nothing - that is the
  // rendering for a fully-optional/defaulted object, and it must not fall
  // back to the output tree (which marks defaulted fields required).
  if (!Array.isArray(required)) return [];
  return required.filter((field): field is string => typeof field === "string");
}

/**
 * Directional comparison of unknown-key policies. Projection asks: can the
 * NEWER schema emit an unknown key that the OLDER one refuses?
 *
 * - old `strip` accepts anything (it discards unknowns), so nothing to check.
 * - old `reject` only tolerates a newer schema that never emits unknown keys,
 *   i.e. one that also rejects or strips them.
 * - old `validate` (typed catchall) tolerates a newer catchall whose values
 *   are a subset of the old one's; an unconstrained passthrough is not.
 */
function unknownKeyPolicyRelaxation(
  previous: UnknownKeyPolicy,
  next: UnknownKeyPolicy,
  path: readonly string[],
): AdditivityViolation | null {
  const location = path.length === 0 ? "<root>" : dottedPath(path);
  // An older schema that drops or freely accepts unknown keys can never be
  // broken by what the newer one emits.
  if (previous.kind === "strip" || previous.kind === "passthrough") return null;
  // The newer schema only puts undeclared keys on the wire when it preserves
  // them (`passthrough`) or validates them (`validate`); `reject`/`strip`
  // both emit nothing undeclared.
  const nextEmitsUnknownKeys =
    next.kind === "passthrough" || next.kind === "validate";
  if (!nextEmitsUnknownKeys) return null;
  if (previous.kind === "reject") {
    return { kind: "unknown-key-policy", detail: location };
  }
  // Old validates against a catchall: an unconstrained passthrough can emit
  // anything, so only a narrower typed catchall is safe.
  if (next.kind !== "validate") {
    return { kind: "unknown-key-policy", detail: location };
  }
  const catchallMismatch = findNodeAdditivityViolation(
    previous.schema,
    next.schema,
    path,
    "no-value-growth",
    previous.schema,
    next.schema,
  );
  return catchallMismatch === null
    ? null
    : { kind: "unknown-key-policy", detail: location };
}

function convertJsonSchemaShape(
  raw: unknown,
  context: string,
): JsonSchemaFingerprint {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(
      `Expected a JSON Schema object for ${context}; got ${typeof raw}.`,
    );
  }

  const node = raw as {
    type?: unknown;
    properties?: Record<string, unknown>;
    required?: readonly string[];
    enum?: readonly unknown[];
    anyOf?: readonly unknown[];
    oneOf?: readonly unknown[];
    items?: unknown;
  };

  if (node.type === "object" && node.properties !== undefined) {
    return {
      type: "object",
      properties: node.properties,
      required: node.required ?? [],
    };
  }

  if (Array.isArray(node.enum)) {
    return {
      type: "enum",
      representation: classifyEnumRepresentation(node.type, node.enum),
      values: node.enum as readonly (string | number | boolean)[],
    };
  }

  if (Array.isArray(node.anyOf)) {
    const literalEnum = tryFoldAnyOfLiteralsToEnum(node.anyOf);
    if (literalEnum !== null) {
      return literalEnum;
    }

    return {
      type: "anyOf",
      variants: node.anyOf.map((variant, index) =>
        convertJsonSchemaShape(variant, `${context}.anyOf[${index}]`),
      ),
    };
  }

  // `z.discriminatedUnion(...)` (and some `z.union(...)` shapes under
  // newer Zod versions) emit `oneOf` instead of `anyOf`. Treat them
  // structurally identically for fingerprinting - the framework only
  // cares about the set of variants, not whether JSON Schema marks the
  // union as exclusive.
  if (Array.isArray(node.oneOf)) {
    const literalEnum = tryFoldAnyOfLiteralsToEnum(node.oneOf);
    if (literalEnum !== null) {
      return literalEnum;
    }

    return {
      type: "anyOf",
      variants: node.oneOf.map((variant, index) =>
        convertJsonSchemaShape(variant, `${context}.oneOf[${index}]`),
      ),
    };
  }

  if (
    "const" in node &&
    (typeof (node as { const?: unknown }).const === "string" ||
      typeof (node as { const?: unknown }).const === "number" ||
      typeof (node as { const?: unknown }).const === "boolean")
  ) {
    const value = (node as { const: string | number | boolean }).const;
    return {
      type: "enum",
      representation: classifyEnumRepresentation(node.type, [value]),
      values: [value],
    };
  }

  if (node.type === "array" && node.items !== undefined) {
    const bounds = node as { minItems?: unknown; maxItems?: unknown };
    return {
      type: "array",
      items: convertJsonSchemaShape(node.items, `${context}.items`),
      ...(typeof bounds.minItems === "number"
        ? { minItems: bounds.minItems }
        : {}),
      ...(typeof bounds.maxItems === "number"
        ? { maxItems: bounds.maxItems }
        : {}),
    };
  }

  throw new Error(
    `Unsupported schema for ${context}; expected an object, enum, union, or array (got ${JSON.stringify(node).slice(0, 200)}).`,
  );
}

function tryFoldAnyOfLiteralsToEnum(
  variants: readonly unknown[],
): EnumJsonSchema | null {
  const values: (string | number | boolean)[] = [];
  for (const variant of variants) {
    if (typeof variant !== "object" || variant === null) {
      return null;
    }
    const node = variant as { const?: unknown };
    if (
      typeof node.const !== "string" &&
      typeof node.const !== "number" &&
      typeof node.const !== "boolean"
    ) {
      return null;
    }
    values.push(node.const);
  }

  if (values.length === 0) {
    return null;
  }

  return {
    type: "enum",
    representation: classifyEnumRepresentation(undefined, values),
    values,
  };
}

function classifyEnumRepresentation(
  declaredType: unknown,
  values: readonly unknown[],
): EnumJsonSchema["representation"] {
  if (declaredType === "string") return "string";
  if (declaredType === "number") return "number";
  if (declaredType === "boolean") return "boolean";

  const observedTypes = new Set(values.map((value) => typeof value));
  if (observedTypes.size === 1) {
    const [only] = [...observedTypes];
    if (only === "string" || only === "number" || only === "boolean") {
      return only;
    }
  }
  return "mixed";
}

export type AdditivityViolation =
  | { readonly kind: "field"; readonly detail: string }
  | { readonly kind: "required-field"; readonly detail: string }
  | { readonly kind: "unknown-key-policy"; readonly detail: string }
  | { readonly kind: "array-bounds"; readonly detail: string }
  | { readonly kind: "strict-object-growth"; readonly detail: string }
  | { readonly kind: "enum-value"; readonly detail: string }
  | { readonly kind: "enum-value-added"; readonly detail: string }
  | { readonly kind: "union-variant"; readonly detail: string }
  | { readonly kind: "union-variant-added"; readonly detail: string }
  | {
      readonly kind: "array-items";
      readonly detail: string;
      /**
       * The violation found beneath the array, preserved structurally so
       * callers can classify it (e.g. distinguish value growth from a
       * removal) without re-parsing `detail`'s prose.
       */
      readonly inner: AdditivityViolation;
    }
  | { readonly kind: "schema-kind"; readonly detail: string };

/**
 * Unwraps `array-items` nesting to the violation that actually occurred, so
 * classification does not depend on how deeply it was found.
 */
export function rootAdditivityViolation(
  violation: AdditivityViolation,
): AdditivityViolation {
  return violation.kind === "array-items"
    ? rootAdditivityViolation(violation.inner)
    : violation;
}

/**
 * How strictly additivity treats VALUE growth (new enum values, new
 * union variants, widened forms) - growth the older schema validates
 * rather than strips, so an old peer REFUSES any payload carrying it.
 *
 * - `"lenient"`: growth is legal. Correct for request schemas (the
 *   caller only hits the refusal by opting into the new capability on
 *   its own call), for streams (whose serverFrame growth is emitted
 *   behind per-minor capability gates - the chat-frame-projection
 *   pattern), and for persistence records.
 * - `"no-value-growth"`: growth is a violation. Correct for unary
 *   RESPONSE schemas, where the new value's occurrence is typically
 *   decided by shared state rather than by the receiving peer - one
 *   new-valued record would poison every old peer's projection with no
 *   opt-out. A minor whose response growth genuinely is emission-gated
 *   declares `responseGrowthProjectionGated: true` on its registry
 *   version entry, which drops that minor back to `"lenient"`.
 *
 * Structural safety (no removals, no incompatible replacements, at any
 * depth) is enforced identically in both modes.
 */
export type AdditivityMode = "lenient" | "no-value-growth";

/**
 * First non-additive change between two fingerprints, or null when
 * `next` is purely additive over `previous`.
 *
 * "Additive" is defined by projection feasibility, matching what the
 * transport actually does on a same-major version skew: the newer peer
 * re-parses its latest-shape payload through the older installed
 * schema (`prepareRequestPayload` Zod-strip on requests, the frozen
 * response reparse on responses), where a failed parse surfaces as a
 * typed `DOWNGRADE_UNSUPPORTED` refusal. Under that mechanism:
 *
 * - Additions are legal at ANY depth, but by two different mechanisms
 *   with different obligations. Added object keys strip - unconditional,
 *   nothing to own. Added enum values / union variants / widened forms
 *   REFUSE at projection when a payload actually carries the new
 *   capability; that refusal is only acceptable when the value's
 *   occurrence is under the emitting caller's control (request-side
 *   opt-in). Where shared state decides the value - a response field
 *   reflecting replicated data - a single new-valued record poisons
 *   every old peer's projection with no opt-out, so growth there must
 *   ship as version-gated emission (the chat-frame-projection pattern)
 *   or a major with a bridge that filters/maps the new values (the
 *   agent.list harness-growth pattern). This validator cannot see which
 *   case applies; that judgment is the reviewer's.
 * - Removals are illegal at ANY depth - a removed field/value/variant
 *   makes the projection of ordinary payloads fail unconditionally,
 *   which is a de facto major shipped under a minor number.
 * - A field may widen into a union (`z.object` -> `z.union([...])`)
 *   only when some variant of the union remains additively compatible
 *   with the previous form, so old-form payloads still project.
 *
 * The check therefore recurses through object properties (as raw JSON
 * Schema nodes - leaf shapes like plain strings are compared
 * structurally), matches union variants by additive compatibility
 * rather than byte equality, and applies the same rules uniformly
 * regardless of the root schema's shape.
 */
export function findAdditivityViolation(
  previous: JsonSchemaFingerprint,
  next: JsonSchemaFingerprint,
  mode: AdditivityMode,
  previousInput: unknown,
  nextInput: unknown,
): AdditivityViolation | null {
  return findNodeAdditivityViolation(
    previous,
    next,
    [],
    mode,
    previousInput,
    nextInput,
  );
}

/**
 * Classifier over schema nodes for the additivity walk. Accepts both
 * normalized fingerprints (what the exported entry points receive) and
 * raw JSON Schema subtrees (what `ObjectJsonSchema.properties` holds),
 * because the walk crosses from the former into the latter the moment
 * it descends into an object property. Anything that is neither an
 * object, enum, union, nor array - scalar leaves, `{}` from
 * unrepresentable types, records, tuples - is `opaque` and compared
 * structurally.
 */
type ClassifiedSchemaNode =
  | {
      readonly kind: "object";
      readonly properties: Readonly<Record<string, unknown>>;
      /**
       * Carried because requiredness is part of what an older peer's schema
       * ENFORCES: relaxing a required field to optional lets a newer peer
       * emit a payload the older schema rejects, which the property walk
       * alone cannot see (both sides keep identical `properties`).
       */
      readonly required: readonly string[];
    }
  | {
      readonly kind: "enum";
      readonly representation: EnumJsonSchema["representation"];
      readonly values: readonly (string | number | boolean)[];
    }
  | { readonly kind: "anyOf"; readonly variants: readonly unknown[] }
  | { readonly kind: "array"; readonly items: unknown }
  | { readonly kind: "opaque"; readonly node: unknown };

function classifySchemaNode(node: unknown): ClassifiedSchemaNode {
  if (typeof node !== "object" || node === null) {
    return { kind: "opaque", node };
  }

  const shape = node as {
    type?: unknown;
    properties?: Record<string, unknown>;
    required?: unknown;
    values?: unknown;
    representation?: unknown;
    variants?: unknown;
    enum?: readonly unknown[];
    anyOf?: readonly unknown[];
    oneOf?: readonly unknown[];
    items?: unknown;
  };
  const requiredFields = Array.isArray(shape.required)
    ? shape.required.filter((field): field is string => typeof field === "string")
    : [];

  // Normalized-fingerprint forms first: `type: "enum"` / `type: "anyOf"`
  // never occur in raw JSON Schema, so these branches are unambiguous.
  if (shape.type === "enum" && Array.isArray(shape.values)) {
    return {
      kind: "enum",
      representation:
        shape.representation === "string" ||
        shape.representation === "number" ||
        shape.representation === "boolean"
          ? shape.representation
          : "mixed",
      values: shape.values as readonly (string | number | boolean)[],
    };
  }
  if (shape.type === "anyOf" && Array.isArray(shape.variants)) {
    return { kind: "anyOf", variants: shape.variants };
  }

  // Raw JSON Schema forms, mirroring `convertJsonSchemaShape`'s branch
  // order (a normalized object/array fingerprint is shape-identical to
  // its raw form, so these cover both).
  if (shape.type === "object" && shape.properties !== undefined) {
    return {
      kind: "object",
      properties: shape.properties,
      required: requiredFields,
    };
  }
  if (Array.isArray(shape.enum)) {
    return {
      kind: "enum",
      representation: classifyEnumRepresentation(shape.type, shape.enum),
      values: shape.enum as readonly (string | number | boolean)[],
    };
  }
  const unionVariants = Array.isArray(shape.anyOf)
    ? shape.anyOf
    : Array.isArray(shape.oneOf)
      ? shape.oneOf
      : null;
  if (unionVariants !== null) {
    const literalEnum = tryFoldAnyOfLiteralsToEnum(unionVariants);
    if (literalEnum !== null) {
      return {
        kind: "enum",
        representation: literalEnum.representation,
        values: literalEnum.values,
      };
    }
    return { kind: "anyOf", variants: unionVariants };
  }
  if (
    "const" in shape &&
    (typeof (shape as { const?: unknown }).const === "string" ||
      typeof (shape as { const?: unknown }).const === "number" ||
      typeof (shape as { const?: unknown }).const === "boolean")
  ) {
    const value = (shape as { const: string | number | boolean }).const;
    return {
      kind: "enum",
      representation: classifyEnumRepresentation(shape.type, [value]),
      values: [value],
    };
  }
  if (shape.type === "array" && shape.items !== undefined) {
    return { kind: "array", items: shape.items };
  }

  return { kind: "opaque", node };
}

function dottedPath(path: readonly string[]): string {
  return path.join(".");
}

function snippet(node: unknown): string {
  return JSON.stringify(node)?.slice(0, 80) ?? String(node);
}

/**
 * JSON Schema keywords that annotate a leaf without constraining the values
 * it accepts. Two leaves differing only in these describe the same accepted
 * value set, so a newer peer's payloads still project onto the older schema
 * and the change is additive. `default` belongs here: it affects how an
 * absent input is filled, never which emitted values are valid.
 */
const NON_CONSTRAINING_SCHEMA_KEYS = new Set([
  "default",
  "description",
  "title",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "$comment",
]);

/**
 * Structural identity of a leaf, ignoring annotation-only keywords. Keys are
 * sorted so declaration order never reads as a change.
 */
/**
 * Bound keywords where a LOWER value on the newer side narrows the accepted
 * set, so `next <= previous` still projects.
 */
const UPPER_BOUND_KEYS = new Set([
  "maximum",
  "exclusiveMaximum",
  "maxLength",
  "maxItems",
  "maxProperties",
]);

/** Bound keywords where a HIGHER value on the newer side narrows. */
const LOWER_BOUND_KEYS = new Set([
  "minimum",
  "exclusiveMinimum",
  "minLength",
  "minItems",
  "minProperties",
]);

/**
 * Whether every value the NEWER leaf can emit is still accepted by the OLDER
 * leaf. Narrowing a scalar constraint (`z.string().max(10)` ->
 * `z.string().max(5)`) is projection-safe and must not be reported;
 * widening it is not. Non-bound keywords (`type`, `format`, `pattern`,
 * `multipleOf`, ...) are compared for identity, because deciding subset
 * relationships between them in general is not something this checker can
 * do soundly - so it stays conservative there.
 */
function leafProjectsOnto(previous: unknown, next: unknown): boolean {
  const previousShape = constrainingRecord(previous);
  const nextShape = constrainingRecord(next);
  if (previousShape === null || nextShape === null) {
    return constrainingShape(previous) === constrainingShape(next);
  }

  for (const key of new Set([
    ...Object.keys(previousShape),
    ...Object.keys(nextShape),
  ])) {
    const previousValue = previousShape[key];
    const nextValue = nextShape[key];
    if (UPPER_BOUND_KEYS.has(key) || LOWER_BOUND_KEYS.has(key)) {
      // An unbounded older side accepts anything the newer side bounds.
      if (previousValue === undefined) continue;
      if (typeof previousValue !== "number" || typeof nextValue !== "number") {
        return false;
      }
      const narrows = UPPER_BOUND_KEYS.has(key)
        ? nextValue <= previousValue
        : nextValue >= previousValue;
      if (!narrows) return false;
      continue;
    }
    if (constrainingShape(previousValue) !== constrainingShape(nextValue)) {
      return false;
    }
  }
  return true;
}

/** Plain-object view of a leaf's constraining keywords, or null if not one. */
function constrainingRecord(node: unknown): Record<string, unknown> | null {
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    return null;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (NON_CONSTRAINING_SCHEMA_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

function constrainingShape(node: unknown): string {
  if (typeof node !== "object" || node === null) return JSON.stringify(node) ?? String(node);
  if (Array.isArray(node)) {
    return `[${node.map(constrainingShape).join(",")}]`;
  }
  const entries = Object.entries(node as Record<string, unknown>)
    .filter(([key]) => !NON_CONSTRAINING_SCHEMA_KEYS.has(key))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${JSON.stringify(key)}:${constrainingShape(value)}`);
  return `{${entries.join(",")}}`;
}

function findNodeAdditivityViolation(
  previous: unknown,
  next: unknown,
  path: readonly string[],
  mode: AdditivityMode,
  previousInput: unknown,
  nextInput: unknown,
): AdditivityViolation | null {
  const previousNode = classifySchemaNode(previous);
  const nextNode = classifySchemaNode(next);

  if (previousNode.kind !== nextNode.kind) {
    // Widening lever: any previous form may become a union on a minor,
    // provided some variant still accepts old-form payloads additively -
    // payloads using a genuinely new form refuse by design at projection.
    // Widening IS value growth (the union's other forms are new values an
    // old schema refuses), so under no-value-growth it is a violation
    // regardless of whether the old form is retained.
    if (nextNode.kind === "anyOf") {
      if (mode === "no-value-growth") {
        return { kind: "union-variant-added", detail: snippet(next) };
      }
      const nextWideningArms = inputVariants(nextInput);
      const oldFormRetained = nextNode.variants.some(
        (variant, variantIndex) =>
          findNodeAdditivityViolation(
            previous,
            variant,
            path,
            mode,
            previousInput,
            nextWideningArms[variantIndex] ?? null,
          ) === null,
      );
      return oldFormRetained
        ? null
        : { kind: "union-variant", detail: snippet(previous) };
    }
    // Union collapse: only additive when every previous variant's payloads
    // still project onto the replacement schema.
    if (previousNode.kind === "anyOf") {
      const previousInputArms = inputVariants(previousInput);
      for (const [index, variant] of previousNode.variants.entries()) {
        if (
          findNodeAdditivityViolation(
            variant,
            next,
            path,
            mode,
            previousInputArms[index] ?? null,
            nextInput,
          ) !== null
        ) {
          return { kind: "union-variant", detail: snippet(variant) };
        }
      }
      return null;
    }
    return {
      kind: "schema-kind",
      detail:
        path.length === 0
          ? `${previousNode.kind} -> ${nextNode.kind}`
          : `${previousNode.kind} -> ${nextNode.kind} at '${dottedPath(path)}'`,
    };
  }

  if (previousNode.kind === "object" && nextNode.kind === "object") {
    // Only keys the OLD schema knows are walked: a brand-new key's subtree
    // is invisible to the old schema (stripped on projection), so it is
    // exempt from value-growth checking in either mode.
    for (const field of Object.keys(previousNode.properties)) {
      // `Object.hasOwn`, not `in`: a schema property legitimately named
      // `constructor`/`toString`/`valueOf` would match an inherited
      // prototype member, silently passing the removal check and then
      // classifying a function as an `opaque` node.
      if (!Object.hasOwn(nextNode.properties, field)) {
        return {
          kind: "field",
          detail: dottedPath([...path, field]),
        };
      }
      const nested = findNodeAdditivityViolation(
        previousNode.properties[field],
        nextNode.properties[field],
        [...path, field],
        mode,
        inputProperty(previousInput, field),
        inputProperty(nextInput, field),
      );
      if (nested !== null) return nested;
    }
    // "An added field just strips" holds only when the OLDER object strips.
    // A strict object rejects the whole payload instead, so growing one on a
    // minor breaks projection for every payload - not just those exercising
    // the new field.
    const policy = unknownKeyPolicy(previousInput);
    if (policy.kind === "reject" || policy.kind === "validate") {
      for (const field of Object.keys(nextNode.properties)) {
        if (Object.hasOwn(previousNode.properties, field)) continue;
        if (policy.kind === "reject") {
          return {
            kind: "strict-object-growth",
            detail: dottedPath([...path, field]),
          };
        }
        // A typed catchall already ACCEPTS unknown keys that satisfy it, so
        // an addition whose own schema fits the catchall still projects -
        // rejecting it outright would force safe evolution into a major.
        // Compare the added key against the catchall (input-rendered, the
        // shape the old peer accepts) and only reject a genuine mismatch.
        //
        // This comparison is ALWAYS strict, never the caller's `mode`: the
        // question is whether every value the new property admits satisfies
        // the old catchall, which is a subset test. Under `lenient` an added
        // property typed `z.enum(["a","b"])` would pass a `z.enum(["a"])`
        // catchall because enum growth is lenient - yet the old peer rejects
        // the value "b".
        const mismatch = findNodeAdditivityViolation(
          policy.schema,
          nextNode.properties[field],
          [...path, field],
          "no-value-growth",
          policy.schema,
          inputProperty(nextInput, field),
        );
        if (mismatch !== null) {
          return {
            kind: "strict-object-growth",
            detail: dottedPath([...path, field]),
          };
        }
      }
    }
    // An unknown-key policy can also be RELAXED without declaring any new
    // field: `z.strictObject({a})` -> the same shape with `.catchall(...)` or
    // passthrough. The loop above sees no added properties, so only comparing
    // the policies themselves catches it - and the newer schema then emits
    // undeclared keys the older one rejects.
    const nextPolicy = unknownKeyPolicy(nextInput);
    const policyViolation = unknownKeyPolicyRelaxation(policy, nextPolicy, path);
    if (policyViolation !== null) return policyViolation;
    // Relaxing required -> optional is not additive: the newer peer may omit
    // the field, and the older schema rejects the payload outright.
    //
    // The two sides read from DIFFERENT renderings, deliberately:
    //
    // - PREVIOUS uses the INPUT tree - what the older peer ACCEPTS. Its output
    //   rendering marks a `.default()` field required, which would reject the
    //   projection-safe `z.string().default("x")` -> `z.string().optional()`
    //   transition even though the old schema tolerates omission.
    // - NEXT uses the OUTPUT fingerprint - what the newer peer EMITS. Its
    //   input rendering marks a defaulted field optional, which would reject
    //   the equally safe `z.string()` -> `z.string().default("x")`, even
    //   though the newer peer always puts the field on the wire.
    //
    // Reading both from one side reintroduces one of those false positives.
    const previousRequired =
      inputRequired(previousInput) ?? previousNode.required;
    const nextRequired = new Set(nextNode.required);
    for (const field of previousRequired) {
      if (!nextRequired.has(field)) {
        return { kind: "required-field", detail: dottedPath([...path, field]) };
      }
    }
    return null;
  }

  if (previousNode.kind === "enum" && nextNode.kind === "enum") {
    if (previousNode.representation !== nextNode.representation) {
      return {
        kind: "schema-kind",
        detail: `enum representation ${previousNode.representation} -> ${nextNode.representation}`,
      };
    }
    for (const value of previousNode.values) {
      if (!nextNode.values.includes(value)) {
        return { kind: "enum-value", detail: String(value) };
      }
    }
    if (mode === "no-value-growth") {
      for (const value of nextNode.values) {
        if (!previousNode.values.includes(value)) {
          return { kind: "enum-value-added", detail: String(value) };
        }
      }
    }
    return null;
  }

  if (previousNode.kind === "anyOf" && nextNode.kind === "anyOf") {
    // A previous variant survives when SOME next variant is additively
    // compatible with it - byte-identical is the trivial case, an
    // extended variant (added optional keys) the intended one. Matching
    // by compatibility instead of equality is what lets union arms grow
    // on minors exactly like object properties do. Under no-value-growth
    // the survival match runs strict too; when a variant has a lenient
    // successor whose only sin is value growth, surface that precise
    // violation instead of a misleading "dropped variant".
    const previousInputArms = inputVariants(previousInput);
    const nextInputArms = inputVariants(nextInput);
    for (const [index, previousVariant] of previousNode.variants.entries()) {
      // Each arm carries its OWN unknown-key behaviour: a mixed union (one
      // strict arm, one stripping arm) must reject growth of the strict arm
      // while still allowing growth of the stripping one.
      const previousArmInput = previousInputArms[index] ?? null;
      const survives = nextNode.variants.some(
        (nextVariant, nextIndex) =>
          findNodeAdditivityViolation(
            previousVariant,
            nextVariant,
            path,
            mode,
            previousArmInput,
            nextInputArms[nextIndex] ?? null,
          ) === null,
      );
      if (survives) continue;
      if (mode === "no-value-growth") {
        const lenientIndex = nextNode.variants.findIndex(
          (nextVariant, nextIndex) =>
            findNodeAdditivityViolation(
              previousVariant,
              nextVariant,
              path,
              "lenient",
              previousArmInput,
              nextInputArms[nextIndex] ?? null,
            ) === null,
        );
        if (lenientIndex !== -1) {
          return findNodeAdditivityViolation(
            previousVariant,
            nextNode.variants[lenientIndex],
            path,
            mode,
            previousArmInput,
            nextInputArms[lenientIndex] ?? null,
          );
        }
      }
      return { kind: "union-variant", detail: snippet(previousVariant) };
    }
    if (mode === "no-value-growth") {
      for (const [nextIndex, nextVariant] of nextNode.variants.entries()) {
        // Probe in the SAME mode as the survival loop. Under "lenient" a
        // new arm that differs from an old one only by value growth would
        // count as "having a predecessor" and escape the gate - e.g.
        // previous [A], next [A, A'] where A' is A with an extra enum
        // value: A survives strictly, and A' must still be reported.
        const hasPredecessor = previousNode.variants.some(
          (previousVariant, index) =>
            findNodeAdditivityViolation(
              previousVariant,
              nextVariant,
              path,
              mode,
              previousInputArms[index] ?? null,
              nextInputArms[nextIndex] ?? null,
            ) === null,
        );
        if (!hasPredecessor) {
          return { kind: "union-variant-added", detail: snippet(nextVariant) };
        }
      }
    }
    return null;
  }

  if (previousNode.kind === "array" && nextNode.kind === "array") {
    // Array-level bounds constrain the payload independently of `items`:
    // widening `.max(1)` to `.max(2)` lets the newer peer emit a two-element
    // array the older schema rejects, with identical item schemas. The newer
    // bounds must stay at least as tight as the older ones.
    const boundsViolation = arrayBoundsRelaxation(previous, next, path);
    if (boundsViolation !== null) return boundsViolation;
    const itemsViolation = findNodeAdditivityViolation(
      previousNode.items,
      nextNode.items,
      [...path, "items"],
      mode,
      inputItems(previousInput),
      inputItems(nextInput),
    );
    if (itemsViolation !== null) {
      return {
        kind: "array-items",
        detail: describeAdditivityViolation(itemsViolation),
        inner: itemsViolation,
      };
    }
    return null;
  }

  if (previousNode.kind === "opaque" && nextNode.kind === "opaque") {
    if (leafProjectsOnto(previousNode.node, nextNode.node)) {
      return null;
    }
    return {
      kind: "schema-kind",
      detail:
        path.length === 0
          ? `${snippet(previousNode.node)} -> ${snippet(nextNode.node)}`
          : `${snippet(previousNode.node)} -> ${snippet(nextNode.node)} at '${dottedPath(path)}'`,
    };
  }

  return null;
}

export type BreakingChange =
  | {
      readonly kind: "field";
      readonly detail: string;
      readonly reason: "removed" | "schema-changed";
    }
  | {
      readonly kind: "enum-value";
      readonly detail: string;
      readonly reason: "removed";
    }
  | {
      readonly kind: "union-variant";
      readonly detail: string;
      readonly reason: "removed";
    }
  | {
      readonly kind: "array-items";
      readonly detail: string;
      readonly reason: "removed" | "schema-changed";
    }
  | {
      readonly kind: "schema-kind";
      readonly detail: string;
      readonly reason: "schema-changed";
    };

/**
 * First breaking change between two latest-of-major fingerprints, or
 * null when `next` is fully backwards-compatible. A null result on a
 * major bump signals that the change could have shipped as a minor.
 *
 * Builds on `findAdditivityViolation` - every removal is also breaking
 * - and additionally catches per-field schema changes for object kinds.
 */
export function findBreakingChange(
  previous: JsonSchemaFingerprint,
  next: JsonSchemaFingerprint,
  previousInput: unknown,
  nextInput: unknown,
): BreakingChange | null {
  // Major justification only asks "is this breaking"; strictness-aware
  // growth detection is an additivity concern, so no strict paths here.
  //
  // The input trees are still required. Passing `null` would make every old
  // object look like it strips unknown keys, so adding a root field to a
  // `z.strictObject` would read as non-breaking here while being correctly
  // forbidden as a minor - leaving the change with no valid version bump.
  const additivityViolation = findAdditivityViolation(
    previous,
    next,
    "lenient",
    previousInput,
    nextInput,
  );
  if (additivityViolation !== null) {
    if (additivityViolation.kind === "schema-kind") {
      return { ...additivityViolation, reason: "schema-changed" };
    }
    if (
      additivityViolation.kind === "enum-value-added" ||
      additivityViolation.kind === "union-variant-added"
    ) {
      // Value-growth violations only exist under "no-value-growth" mode;
      // the lenient call above cannot produce them.
      throw new Error(
        "unreachable: lenient additivity produced a value-growth violation",
      );
    }
    if (additivityViolation.kind === "strict-object-growth") {
      // Growing a strict object changes what the schema accepts.
      return {
        kind: "field",
        detail: additivityViolation.detail,
        reason: "schema-changed",
      };
    }
    if (
      additivityViolation.kind === "unknown-key-policy" ||
      additivityViolation.kind === "array-bounds"
    ) {
      // Relaxing what the schema accepts is a change in the field's own
      // contract, not a removal.
      return {
        kind: "field",
        detail: additivityViolation.detail,
        reason: "schema-changed",
      };
    }
    if (additivityViolation.kind === "required-field") {
      // Relaxing required -> optional does not remove the field, it changes
      // what the schema accepts - which is exactly a breaking field change
      // for major-justification purposes.
      return {
        kind: "field",
        detail: additivityViolation.detail,
        reason: "schema-changed",
      };
    }
    return { ...additivityViolation, reason: "removed" };
  }

  if (previous.type === "object" && next.type === "object") {
    const previousRequired = new Set(previous.required);
    const newlyRequiredField = next.required.find(
      (field) => !previousRequired.has(field),
    );
    if (newlyRequiredField !== undefined) {
      return {
        kind: "field",
        detail: newlyRequiredField,
        reason: "schema-changed",
      };
    }
    for (const field of Object.keys(previous.properties)) {
      if (
        JSON.stringify(previous.properties[field]) !==
        JSON.stringify(next.properties[field])
      ) {
        return { kind: "field", detail: field, reason: "schema-changed" };
      }
    }
  }

  if (previous.type === "array" && next.type === "array") {
    const itemsBreakingChange = findBreakingChange(
      previous.items,
      next.items,
      inputItems(previousInput),
      inputItems(nextInput),
    );
    if (itemsBreakingChange !== null) {
      return {
        kind: "array-items",
        detail:
          itemsBreakingChange.kind === "field"
            ? `field '${itemsBreakingChange.detail}'`
            : itemsBreakingChange.detail,
        reason: itemsBreakingChange.reason,
      };
    }
  }

  return null;
}

export function describeAdditivityViolation(
  violation: AdditivityViolation,
): string {
  switch (violation.kind) {
    case "field":
      return `drops field '${violation.detail}'`;
    case "required-field":
      return `makes required field '${violation.detail}' optional`;
    case "unknown-key-policy":
      return `relaxes the unknown-key policy at '${violation.detail}'`;
    case "array-bounds":
      return `relaxes array bounds (${violation.detail})`;
    case "strict-object-growth":
      return `adds field '${violation.detail}' to a strict object (an older strict schema rejects the extra key instead of stripping it)`;
    case "enum-value":
      return `drops enum value '${violation.detail}'`;
    case "enum-value-added":
      return `adds enum value '${violation.detail}'`;
    case "union-variant":
      return `drops union variant '${violation.detail}'`;
    case "union-variant-added":
      return `adds union variant '${violation.detail}'`;
    case "array-items":
      return `array items: ${violation.detail}`;
    case "schema-kind":
      return `changes schema kind (${violation.detail})`;
  }
}
