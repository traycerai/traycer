import { z } from "zod";
import type {
  $ZodDiscriminatedUnionDef,
  ToJSONSchemaContext,
} from "zod/v4/core";

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
  /**
   * The field `z.discriminatedUnion(...)` was DECLARED on, or `null` for a
   * plain `z.union(...)`.
   *
   * Carried because arm identity cannot be inferred once more than one field
   * qualifies as a tag: `{kind:"a",outcome:"x",value}` -> `{kind:"a",outcome:"z"}`
   * (an EDIT that drops `value`) and `{kind:"a",outcome:"x",value}` ->
   * `{kind:"b",outcome:"x"}` (a REPLACEMENT) are structurally identical - one
   * qualifying field agrees, one differs, in both. Only the declaration says
   * which field is the identity, and JSON Schema does not carry it, so
   * `toJsonSchemaFingerprint` stamps it during conversion.
   */
  readonly discriminator: string | null;
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
  | ObjectJsonSchema
  | EnumJsonSchema
  | AnyOfJsonSchema
  | ArrayJsonSchema;

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
    z.toJSONSchema(schema, {
      unrepresentable: "any",
      // The ONE thing JSON Schema drops that arm identity needs. `oneOf`
      // tells us the union was declared discriminated; it does not say on
      // WHICH field, and no amount of comparing the arms can recover it (see
      // `AnyOfJsonSchema.discriminator`). Stamped under an `x-` key so a
      // renderer that round-trips this schema stays valid, and read back by
      // `declaredDiscriminator` during conversion.
      override: stampDeclaredDiscriminator,
    }),
    context,
  );
}

/** The key `toJsonSchemaFingerprint` stamps the declared discriminator under. */
const DECLARED_DISCRIMINATOR_KEY = "x-traycer-discriminator";

/**
 * The exact object zod hands the `override` hook, taken from zod's own
 * context type instead of restated here. A hand-written mirror of it would go
 * on compiling after an upgrade changed the real one, which is the failure
 * mode this whole stamp exists to avoid.
 */
type SchemaOverrideContext = Parameters<ToJSONSchemaContext["override"]>[0];

/**
 * Narrows zod's base def to a discriminated union's, against zod's OWN
 * exported def type rather than a local restatement of its shape.
 *
 * The runtime string check is load-bearing, not belt-and-braces. `_zod.def`
 * is internal and the public surface exposes no accessor for it, so an
 * upgrade that renames or retypes `discriminator` must leave the node
 * UNSTAMPED - identity then falls back to the inferred tuple, the behaviour
 * before this existed - rather than stamp `undefined` as though some field
 * had been declared. Structural, so it is a narrowing and not a cast.
 */
function isDiscriminatedUnionDef(
  def: object,
): def is $ZodDiscriminatedUnionDef {
  return (
    "discriminator" in def &&
    typeof def.discriminator === "string" &&
    def.discriminator.length > 0
  );
}

/**
 * Writes `z.discriminatedUnion`'s declared field onto the emitted union node.
 *
 * A plain `z.union` has no `discriminator` in its def and is left alone, which
 * is the honest answer: nothing was declared, so identity stays the inferred
 * tuple. `json-schema-fingerprint.test.ts` pins the stamp as a positive
 * control, so a zod upgrade that silently stops producing it fails loudly
 * there instead of quietly restoring the defect this closes.
 */
function stampDeclaredDiscriminator(context: SchemaOverrideContext): void {
  const def = context.zodSchema._zod.def;
  if (!isDiscriminatedUnionDef(def)) return;
  context.jsonSchema[DECLARED_DISCRIMINATOR_KEY] = def.discriminator;
}

/** The stamped discriminator on a RAW JSON Schema union node, if any. */
function declaredDiscriminator(node: {
  readonly [DECLARED_DISCRIMINATOR_KEY]?: unknown;
}): string | null {
  const declared = node[DECLARED_DISCRIMINATOR_KEY];
  return typeof declared === "string" && declared.length > 0 ? declared : null;
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
  readonly propertyNames?: unknown;
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

/** Input-tree counterpart of a record's value schema, for lockstep descent. */
function inputRecordValues(previousInput: unknown): unknown {
  const shape = asSchemaNode(previousInput);
  if (shape === null || shape.properties !== undefined) return null;
  const additional = shape.additionalProperties;
  return typeof additional === "object" && additional !== null
    ? additional
    : null;
}

/** Input-tree counterpart of a record's key schema, for lockstep descent. */
function inputRecordKeys(previousInput: unknown): unknown {
  const shape = asSchemaNode(previousInput);
  if (shape === null || shape.properties !== undefined) return null;
  return shape.propertyNames ?? null;
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
    false,
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
    [DECLARED_DISCRIMINATOR_KEY]?: unknown;
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
      discriminator: declaredDiscriminator(node),
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
      discriminator: declaredDiscriminator(node),
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
    false,
  );
}

/**
 * First non-additive change while treating removed union arms as compatible.
 *
 * Versioned RPC uses this only after a minor's reviewed
 * `responseGrowthProjectionGated` declaration has made a version-specific
 * projection responsible for the old arm. The recursive walk still visits
 * every sibling and reports every other reduction; it does not turn the
 * response lane generally lenient.
 */
export function findAdditivityViolationAllowingUnionArmReplacement(
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
    true,
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
      readonly kind: "record";
      /** `propertyNames` subtree, `null` for a plain string key space. */
      readonly keys: unknown;
      /** `additionalProperties` subtree — the per-key value schema. */
      readonly values: unknown;
    }
  | {
      readonly kind: "enum";
      readonly representation: EnumJsonSchema["representation"];
      readonly values: readonly (string | number | boolean)[];
    }
  | {
      readonly kind: "anyOf";
      readonly variants: readonly unknown[];
      /** See {@link AnyOfJsonSchema.discriminator}; `null` for a plain union. */
      readonly discriminator: string | null;
    }
  | { readonly kind: "array"; readonly items: unknown }
  | { readonly kind: "opaque"; readonly node: unknown };

function classifySchemaNode(node: unknown): ClassifiedSchemaNode {
  if (typeof node !== "object" || node === null) {
    return { kind: "opaque", node };
  }

  const shape = node as {
    type?: unknown;
    properties?: Record<string, unknown>;
    additionalProperties?: unknown;
    propertyNames?: unknown;
    required?: unknown;
    values?: unknown;
    representation?: unknown;
    variants?: unknown;
    enum?: readonly unknown[];
    anyOf?: readonly unknown[];
    oneOf?: readonly unknown[];
    items?: unknown;
    // Two carriers, because this classifier sees BOTH forms: a normalized
    // fingerprint node (`type:"anyOf"`, discriminator already converted) and
    // a raw JSON Schema node nested below one (still carrying the stamp).
    discriminator?: unknown;
    [DECLARED_DISCRIMINATOR_KEY]?: unknown;
  };
  const requiredFields = Array.isArray(shape.required)
    ? shape.required.filter(
        (field): field is string => typeof field === "string",
      )
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
    return {
      kind: "anyOf",
      variants: shape.variants,
      discriminator:
        typeof shape.discriminator === "string" &&
        shape.discriminator.length > 0
          ? shape.discriminator
          : null,
    };
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
  // A record (`z.record`): object-typed with one value schema for every key
  // and no declared properties. Walked like an object's properties rather
  // than compared as an opaque leaf — a value-schema field addition strips
  // under an old peer's reparse exactly as a nested object addition does,
  // and the opaque comparison was pricing every record-value evolution as a
  // schema-kind change.
  if (
    shape.type === "object" &&
    shape.properties === undefined &&
    typeof shape.additionalProperties === "object" &&
    shape.additionalProperties !== null
  ) {
    return {
      kind: "record",
      keys: shape.propertyNames ?? null,
      values: shape.additionalProperties,
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
    return {
      kind: "anyOf",
      variants: unionVariants,
      discriminator: declaredDiscriminator(shape),
    };
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

function unionArmReplacementViolation(
  detail: string,
  allowUnionArmReplacement: boolean,
): AdditivityViolation | null {
  return allowUnionArmReplacement ? null : { kind: "union-variant", detail };
}

/**
 * The single literal value a property pins, or `null` when it pins none.
 *
 * A discriminated union's tag is exactly this: `z.literal("ok")` renders as a
 * one-value enum. Two or more values is a choice rather than a tag, and
 * anything else - an object, an array, an open scalar - cannot identify an arm.
 */
function discriminantValue(
  property: unknown,
): string | number | boolean | null {
  const classified = classifySchemaNode(property);
  if (classified.kind !== "enum" || classified.values.length !== 1) {
    return null;
  }
  return classified.values[0];
}

/**
 * Every literal value a property pins, or `null` when it pins none.
 *
 * {@link discriminantValue}'s multi-value sibling, and used ONLY for a
 * DECLARED discriminator. Inference must keep rejecting a multi-value column
 * (nothing tells it apart from an ordinary enum field that happens to differ
 * per arm), but a declared tag is not inferred - the union named it - so a
 * grouped arm like `kind: z.enum(["subagent", "monitor"])` is a perfectly
 * good identity.
 */
function discriminantValues(
  property: unknown,
): ReadonlySet<string | number | boolean> | null {
  const classified = classifySchemaNode(property);
  if (classified.kind !== "enum" || classified.values.length === 0) return null;
  return new Set(classified.values);
}

/**
 * Whether two declared tag value sets name the SAME arm - i.e. share at least
 * one value.
 *
 * OVERLAP, not equality. A grouped tag may gain or lose a value while remaining
 * the same arm, and under equality such an arm read as REPLACED - handing every
 * reduction inside it straight back to the exemption this whole mechanism
 * exists to close. A value the old arm carried and the new side still routes is
 * the honest identity: responses pinned to it projected through the old arm and
 * now project through the new one. Matching on the survivors does not lose the
 * dropped values - the arms' own enum comparison still reports those.
 */
function sharesValue(
  a: ReadonlySet<string | number | boolean>,
  b: ReadonlySet<string | number | boolean>,
): boolean {
  for (const value of a) {
    if (b.has(value)) return true;
  }
  return false;
}

/**
 * Whether `declared` actually tells THIS side's arms apart: pinned to at least
 * one literal on every object arm, with no value shared between two of them.
 *
 * The same qualification {@link discriminatorFields} applies, minus the
 * one-value-per-arm restriction. When it fails, the declaration has stopped
 * answering the identity question on this side and the inferred tuple is the
 * honest fallback.
 */
function declaredTagIdentifies(
  variants: readonly unknown[],
  declared: string,
): boolean {
  const seen = new Set<string | number | boolean>();
  let objectArms = 0;
  for (const variant of variants) {
    const classified = classifySchemaNode(variant);
    if (classified.kind !== "object") continue;
    objectArms += 1;
    const values = discriminantValues(classified.properties[declared]);
    if (values === null) return false;
    for (const value of values) {
      if (seen.has(value)) return false;
      seen.add(value);
    }
  }
  return objectArms > 0;
}

/**
 * One next variant that IS this previous variant - the same arm, edited -
 * paired with the previous arm as it should be COMPARED against that variant.
 */
interface DiscriminatedSuccessor {
  readonly index: number;
  readonly previous: unknown;
}

/**
 * The previous arm rewritten so its declared tag column reads as the
 * successor's - used ONLY when every value the arm carried is still handled
 * somewhere in the new union.
 *
 * WHY. A grouped arm may SPLIT, and each half then pins a narrower slice of the
 * old tag set. Compared as-is, the half reads as "drops enum value 'monitor'"
 * even though the sibling arm took that value and the union's accepted set is
 * unchanged - so a perfectly benign split would fail the gate. Alignment
 * removes exactly that false witness: every OTHER property still compares
 * as-is, so a reduction hiding in either half is reported as before.
 *
 * Only when FULLY covered. A value no next arm took really is gone, and leaving
 * the arm's own column in place is what still reports it.
 */
function alignDeclaredColumn(
  previousVariant: unknown,
  nextVariant: unknown,
  declared: string,
): unknown {
  if (typeof previousVariant !== "object" || previousVariant === null)
    return previousVariant;
  const next = classifySchemaNode(nextVariant);
  if (next.kind !== "object") return previousVariant;
  const previousRecord = previousVariant as Record<string, unknown>;
  const previousProperties = previousRecord["properties"];
  if (typeof previousProperties !== "object" || previousProperties === null)
    return previousVariant;
  return {
    ...previousRecord,
    properties: {
      ...(previousProperties as Record<string, unknown>),
      [declared]: next.properties[declared],
    },
  };
}

/**
 * Every next variant that IS this previous variant - the same arm, edited -
 * or an empty list when the arm genuinely has no successor.
 *
 * WHY THIS EXISTS. The survival loop above can only answer "is any next
 * variant compatible with this previous one", and every NO used to fall into
 * the same bucket: {@link unionArmReplacementViolation}, exempt whenever the
 * minor declared `responseGrowthProjectionGated`. So under that declaration a
 * REDUCTION inside an arm - dropping a required field from it, narrowing a
 * leaf, removing an enum value it carries - was reported by the recursive
 * comparison and then converted into an allowed "arm replacement" and dropped
 * on the floor. That contradicts the exemption's own documented promise (see
 * `findAdditivityViolationAllowingUnionArmReplacement`), which says the walk
 * still reports every other reduction; the gate was quietly accepting breaking
 * changes as long as they were made INSIDE a union.
 *
 * Arm identity is the discriminator, because that is what identity means for
 * the unions the protocol actually registers: matching on shape cannot
 * distinguish "this arm was edited" from "this arm was swapped for a similar
 * one", while a shared tag says the newer schema still calls it the same
 * thing. An arm with no discriminator - a bare `z.string() | z.number()` - has
 * no identity to match on, so it keeps the old blanket treatment rather than
 * being force-matched by position, which would report edits to unrelated arms
 * as if they were the same one.
 *
 * The discriminator is INFERRED FROM THE WHOLE UNION, not read off the one
 * arm. An earlier version took every one-value literal on the previous arm as
 * a tag and matched a successor on ANY of them, which let an incidental
 * literal impersonate identity: with `{kind:"success", outcome:"done", value}`
 * replaced by `{kind:"failure", outcome:"done"}`, the shared `outcome` made
 * the new arm read as the old one EDITED, so its changed `kind` and dropped
 * `value` were reported and a replacement the exemption permits was rejected.
 * A property is a discriminator only if EVERY object arm pins it to a single
 * literal and no two arms pin the same value - what `z.discriminatedUnion`
 * guarantees of the field it names - and it must be one ON BOTH SIDES: a
 * property inferred from the previous union alone would let a minor that
 * drops a secondary literal from every arm make every arm unmatchable, and
 * the arm's other reductions would then pass as permitted replacements. Where
 * more than one property qualifies, identity is the whole tuple: an arm whose
 * tuple changed is not the same arm.
 */
function findDiscriminatedSuccessors(
  previousVariant: unknown,
  previousVariants: readonly unknown[],
  nextVariants: readonly unknown[],
  declared: string | null,
): readonly DiscriminatedSuccessor[] {
  const previous = classifySchemaNode(previousVariant);
  if (previous.kind !== "object") return [];
  // The DECLARED field wins outright when the union names one and that field
  // still tells the arms apart on both sides. Identity is then that field
  // ALONE: a secondary literal moving on an arm whose declared tag is
  // unchanged is an EDIT to that arm, and folding it into a tuple made the
  // arm unmatchable - which handed its dropped fields to the replacement
  // exemption.
  //
  // Matched as a VALUE SET, not a single literal. A declared tag may
  // legitimately group several values in ONE arm - this repo does it with
  // `kind: z.enum(["subagent", "monitor"])` in `agent/gui/subscribe.ts` - and
  // `discriminatorFields` cannot see such a column, because INFERENCE has to
  // reject it (nothing says the grouping is deliberate). A declared tag needs
  // no inference: the union already named the column. Requiring it to survive
  // inference therefore silently dropped every multi-value union straight back
  // onto the incidental-tuple fallback, i.e. back into this exact defect.
  //
  // Matched by SHARED value, and to EVERY next arm that shares one. A grouped
  // arm moves in ways a single literal cannot, and each is a way for a
  // reduction to escape if identity is one index matched on the whole set:
  //
  //   grown   ["a","b"] -> ["a","b","c"]   same arm, one more value
  //   shrunk  ["a","b"] -> ["a"]           same arm; the dropped value is
  //                                        reported by the arms' enum compare
  //   merged  ["a"] + ["b"] -> ["a","b"]   both old arms project onto it
  //   split   ["a","b"] -> ["a"] + ["b"]   BOTH halves still carry old traffic
  //
  // Only the split needs the LIST. `declaredTagIdentifies` forbids a value
  // shared by two arms on one side, so any single value lands in at most one
  // next arm - but a previous arm holding several values can have them land in
  // several, and a reduction in the second is invisible to a first-match index.
  if (
    declared !== null &&
    declaredTagIdentifies(previousVariants, declared) &&
    declaredTagIdentifies(nextVariants, declared)
  ) {
    const previousValues = discriminantValues(previous.properties[declared]);
    if (previousValues === null) return [];
    // Coverage is asked of the WHOLE next union, not of the matched arm: after
    // a split it is the siblings that hold the rest of the old tag set, and a
    // value none of them holds is the one real drop.
    const covered = new Set<string | number | boolean>();
    for (const nextVariant of nextVariants) {
      const next = classifySchemaNode(nextVariant);
      if (next.kind !== "object") continue;
      const nextValues = discriminantValues(next.properties[declared]);
      if (nextValues === null) continue;
      for (const value of nextValues) covered.add(value);
    }
    const fullyCovered = [...previousValues].every((value) =>
      covered.has(value),
    );
    const successors: DiscriminatedSuccessor[] = [];
    for (const [index, nextVariant] of nextVariants.entries()) {
      const next = classifySchemaNode(nextVariant);
      if (next.kind !== "object") continue;
      const nextValues = discriminantValues(next.properties[declared]);
      if (nextValues === null) continue;
      if (!sharesValue(previousValues, nextValues)) continue;
      successors.push({
        index,
        previous: fullyCovered
          ? alignDeclaredColumn(previousVariant, nextVariant, declared)
          : previousVariant,
      });
    }
    return successors;
  }
  const nextFields = new Set(discriminatorFields(nextVariants));
  const inferred = discriminatorFields(previousVariants).filter((field) =>
    nextFields.has(field),
  );
  // The tuple is the fallback: a plain `z.union(...)` declares nothing, and a
  // union whose declared column stopped telling the arms apart is no longer
  // answering the identity question either.
  const fields = inferred;
  if (fields.length === 0) return [];
  const identity = fields.map(
    (field) => [field, discriminantValue(previous.properties[field])] as const,
  );
  // At most one match, so no list to build: every field here is a SINGLE-value
  // column that `discriminatorFields` already proved unique across the arms, so
  // the tuple names one arm or none. No alignment either - a single-value tag
  // cannot be split across arms, so the arm's own column is never a false
  // witness.
  const index = nextVariants.findIndex((nextVariant) => {
    const next = classifySchemaNode(nextVariant);
    if (next.kind !== "object") return false;
    return identity.every(
      ([field, value]) => discriminantValue(next.properties[field]) === value,
    );
  });
  return index === -1 ? [] : [{ index, previous: previousVariant }];
}

/**
 * The properties that tell this union's arms apart: pinned to one literal in
 * every OBJECT arm, with no value shared between two of them. Empty when the
 * union has no object arm or no such property - including the case where one
 * object arm pins the field and another leaves it open, which is exactly the
 * case where a literal on one arm says nothing about identity.
 *
 * Non-object arms (a primitive or array beside the objects) are NOT voters
 * and do NOT veto: they carry no properties to discriminate on, and refusing
 * to infer for the whole union because of them would leave a lone object arm
 * with no successor - so an EDIT to it (a dropped field) would read as a
 * permitted replacement under `responseGrowthProjectionGated`. With a single
 * object arm every pinned literal qualifies, and that is safe because
 * `findDiscriminatedSuccessor` matches on the WHOLE tuple of fields pinned
 * on BOTH sides: an arm whose `kind` changed is a different arm however many
 * incidental literals it shares. `versioned-rpc-json-schema.test.ts` pins
 * both halves ("MIXED union" / "lone object arm").
 */
function discriminatorFields(variants: readonly unknown[]): readonly string[] {
  const arms: Array<Readonly<Record<string, unknown>>> = [];
  for (const variant of variants) {
    const classified = classifySchemaNode(variant);
    if (classified.kind === "object") arms.push(classified.properties);
  }
  const first = arms[0];
  if (first === undefined) return [];
  const fields: string[] = [];
  for (const field of Object.keys(first)) {
    const seen = new Set<string | number | boolean>();
    let qualifies = true;
    for (const arm of arms) {
      const value = discriminantValue(arm[field]);
      if (value === null || seen.has(value)) {
        qualifies = false;
        break;
      }
      seen.add(value);
    }
    if (qualifies) fields.push(field);
  }
  return fields;
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
  // OUR OWN metadata, not the peer's contract. It records which column a
  // union was DECLARED on so arm identity can be resolved; it constrains no
  // value, and two schemas differing only in it accept and emit byte-identical
  // JSON. Left in, a union that merely moves its declaration from one valid
  // tag column to another reads as a changed schema.
  DECLARED_DISCRIMINATOR_KEY,
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

/**
 * The node with ONLY this file's own discriminator stamp removed, everything
 * else - key order included - left exactly as `z.toJSONSchema` emitted it.
 *
 * For callers asking "was this schema CHANGED at all", where the answer must
 * not turn on metadata we wrote ourselves, but must still turn on every
 * keyword the peer's contract actually carries. {@link constrainingShape} is
 * the wrong tool for that: it also drops `default` and friends, which are
 * non-constraining for a LEAF's accepted values yet decide whether a payload
 * parses at all.
 */
function withoutDeclaredDiscriminator(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutDeclaredDiscriminator);
  if (typeof node !== "object" || node === null) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === DECLARED_DISCRIMINATOR_KEY) continue;
    out[key] = withoutDeclaredDiscriminator(value);
  }
  return out;
}

function constrainingShape(node: unknown): string {
  if (typeof node !== "object" || node === null)
    return JSON.stringify(node) ?? String(node);
  if (Array.isArray(node)) {
    return `[${node.map(constrainingShape).join(",")}]`;
  }
  const entries = Object.entries(node as Record<string, unknown>)
    .filter(([key]) => !NON_CONSTRAINING_SCHEMA_KEYS.has(key))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(
      ([key, value]) => `${JSON.stringify(key)}:${constrainingShape(value)}`,
    );
  return `{${entries.join(",")}}`;
}

function findNodeAdditivityViolation(
  previous: unknown,
  next: unknown,
  path: readonly string[],
  mode: AdditivityMode,
  previousInput: unknown,
  nextInput: unknown,
  allowUnionArmReplacement: boolean,
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
            allowUnionArmReplacement,
          ) === null,
      );
      if (oldFormRetained) return null;
      // Same distinction as the union loops: an arm of the new union that IS
      // the old form by discriminator was the old form EDITED, so its
      // reduction is what gets reported - only an old form with no successor
      // is the replacement the exemption covers.
      const successors = allowUnionArmReplacement
        ? findDiscriminatedSuccessors(
            previous,
            [previous],
            nextNode.variants,
            // The previous node is not a union here (a single form GREW into
            // one), so only the new union declares anything. Taking its
            // declaration is what keeps identity from being every literal the
            // old single form happened to pin.
            nextNode.discriminator,
          )
        : [];
      if (successors.length > 0) {
        // EVERY successor, not the first: a grouped tag can split the old form
        // across several new arms, and a reduction in any of them breaks the
        // traffic that arm still carries.
        for (const successor of successors) {
          const edited = findNodeAdditivityViolation(
            successor.previous,
            nextNode.variants[successor.index],
            path,
            mode,
            previousInput,
            nextWideningArms[successor.index] ?? null,
            allowUnionArmReplacement,
          );
          if (edited !== null) return edited;
        }
        return null;
      }
      return unionArmReplacementViolation(
        snippet(previous),
        allowUnionArmReplacement,
      );
    }
    // Union collapse: only additive when every previous variant's payloads
    // still project onto the replacement schema.
    if (previousNode.kind === "anyOf") {
      const previousInputArms = inputVariants(previousInput);
      for (const [index, variant] of previousNode.variants.entries()) {
        const violation = findNodeAdditivityViolation(
          variant,
          next,
          path,
          mode,
          previousInputArms[index] ?? null,
          nextInput,
          allowUnionArmReplacement,
        );
        if (violation === null) continue;
        // The same edited-vs-replaced distinction the anyOf/anyOf loop
        // draws: if the ONE surviving form is this arm's discriminated
        // successor, the arm was edited and its reduction is reported; only
        // an arm with no successor is a replacement the exemption covers.
        if (
          allowUnionArmReplacement &&
          findDiscriminatedSuccessors(
            variant,
            previousNode.variants,
            [next],
            previousNode.discriminator,
          ).length > 0
        ) {
          return violation;
        }
        const replaced = unionArmReplacementViolation(
          snippet(variant),
          allowUnionArmReplacement,
        );
        if (replaced !== null) return replaced;
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
        allowUnionArmReplacement,
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
          false,
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
    const policyViolation = unknownKeyPolicyRelaxation(
      policy,
      nextPolicy,
      path,
    );
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
            allowUnionArmReplacement,
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
              allowUnionArmReplacement,
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
            allowUnionArmReplacement,
          );
        }
      }
      // An arm that still has a successor was EDITED, not replaced, so the
      // exemption does not reach it: report what the edit actually broke.
      // Probed only when the exemption is live - without it the blanket
      // `union-variant` violation below is already the honest answer, and
      // swapping it for a nested detail would change the error every
      // non-gated minor reports.
      const successors = allowUnionArmReplacement
        ? findDiscriminatedSuccessors(
            previousVariant,
            previousNode.variants,
            nextNode.variants,
            // Both sides must call identity the same thing. A minor that
            // re-declares the union on a DIFFERENT field has not edited its
            // arms, it has redefined what an arm is, and the inferred tuple
            // is the honest answer there.
            previousNode.discriminator === nextNode.discriminator
              ? previousNode.discriminator
              : null,
          )
        : [];
      if (successors.length > 0) {
        // EVERY successor, not the first. A grouped declared tag can SPLIT one
        // old arm across several new ones, and each of them still carries the
        // traffic pinned to the values it took, so a reduction in the second
        // half breaks old clients exactly as the first half would.
        for (const successor of successors) {
          const edited = findNodeAdditivityViolation(
            successor.previous,
            nextNode.variants[successor.index],
            path,
            mode,
            previousArmInput,
            nextInputArms[successor.index] ?? null,
            // Passed through, NOT forced off: a union nested inside this arm
            // may still have had one of ITS arms genuinely replaced under the
            // same declaration, and that is what the exemption is for. What
            // must not survive is this arm's own reduction, and that returns a
            // `required-field` / `enum-value` / `schema-kind` violation, none
            // of which consult the flag.
            allowUnionArmReplacement,
          );
          if (edited !== null) return edited;
        }
        continue;
      }
      const replaced = unionArmReplacementViolation(
        snippet(previousVariant),
        allowUnionArmReplacement,
      );
      if (replaced !== null) return replaced;
      // EXEMPT means "this arm's removal is not a violation", not "stop
      // looking". Returning `null` here ended the whole walk at the first
      // replaced arm, so a reduction in any LATER sibling was never visited
      // and the verdict on one semantic change flipped with arm order - the
      // exact leniency the exemption's own doc says it does not grant.
      continue;
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
              allowUnionArmReplacement,
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
      allowUnionArmReplacement,
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

  if (previousNode.kind === "record" && nextNode.kind === "record") {
    // Key schemas evolve under the same rules as any other node: a plain
    // string key space classifies opaque-equal on both sides, while an
    // enum-keyed record growing a key is value growth the old peer's key
    // schema refuses — priced by the mode exactly like any other growth.
    const keysViolation = findNodeAdditivityViolation(
      previousNode.keys,
      nextNode.keys,
      [...path, "(record keys)"],
      mode,
      inputRecordKeys(previousInput),
      inputRecordKeys(nextInput),
      allowUnionArmReplacement,
    );
    if (keysViolation !== null) return keysViolation;
    return findNodeAdditivityViolation(
      previousNode.values,
      nextNode.values,
      [...path, "(record values)"],
      mode,
      inputRecordValues(previousInput),
      inputRecordValues(nextInput),
      allowUnionArmReplacement,
    );
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
      // Raw `JSON.stringify` MINUS our own stamp - not `constrainingShape`.
      // This decides whether a MAJOR is justified, and the stamp must never
      // justify one: a nested union that moves its declaration between two
      // equally valid tag columns emits identical JSON, and comparing raw
      // called that `schema-changed` on metadata this file wrote itself.
      //
      // But `constrainingShape` was the wrong instrument for stripping it. It
      // drops all of `NON_CONSTRAINING_SCHEMA_KEYS`, a set that answers a
      // DIFFERENT question - "does this keyword constrain the values a LEAF
      // accepts" in the additivity walk - and some of those keywords do justify
      // a major here. `.catch([])` renders as `default`, so dropping the catch
      // makes a payload that used to parse fail outright; strip `default` and
      // that major reads as "could have shipped as a minor".
      if (
        JSON.stringify(
          withoutDeclaredDiscriminator(previous.properties[field]),
        ) !==
        JSON.stringify(withoutDeclaredDiscriminator(next.properties[field]))
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
