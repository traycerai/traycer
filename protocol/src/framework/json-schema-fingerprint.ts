import { z } from "zod";
import type {
  $ZodDiscriminatedUnionDef,
  ToJSONSchemaContext,
} from "zod/v4/core";

/** Normalized JSON-Schema fingerprint shared by the versioned-record and versioned-rpc frameworks. */

/** Object-shaped fingerprint (z.object). */
export type ObjectJsonSchema = {
  readonly type: "object";
  readonly properties: Readonly<Record<string, unknown>>;
  readonly required: readonly string[];
};

/** Enum-shaped fingerprint (z.enum, or z.union of same-typed literals). */
export type EnumJsonSchema = {
  readonly type: "enum";
  readonly representation: "string" | "number" | "boolean" | "mixed";
  readonly values: readonly (string | number | boolean)[];
};

/** Discriminated-union fingerprint (z.union, z.discriminatedUnion). */
export type AnyOfJsonSchema = {
  readonly type: "anyOf";
  readonly variants: readonly JsonSchemaFingerprint[];
  /** The field `z.discriminatedUnion(...)` was DECLARED on, or `null` for a plain `z.union(...)`. */
  readonly discriminator: string | null;
};

/** Array fingerprint (z.array). */
export type ArrayJsonSchema = {
  readonly type: "array";
  readonly items: JsonSchemaFingerprint;
  readonly minItems?: number;
  readonly maxItems?: number;
};

/** Normalized fingerprint covering every shape the framework accepts. */
export type JsonSchemaFingerprint =
  | ObjectJsonSchema
  | EnumJsonSchema
  | AnyOfJsonSchema
  | ArrayJsonSchema;

/** Converts a Zod schema to its normalized fingerprint. */
export function toJsonSchemaFingerprint(
  schema: z.ZodType,
  context: string,
): JsonSchemaFingerprint {
  return convertJsonSchemaShape(
    z.toJSONSchema(schema, {
      unrepresentable: "any",
      // The ONE thing JSON Schema drops that arm identity needs.
      override: stampDeclaredDiscriminator,
    }),
    context,
  );
}

const DECLARED_DISCRIMINATOR_KEY = "x-traycer-discriminator";

/**
 * The exact object zod hands the `override` hook, taken from zod's own context type instead of restated here.
 */
type SchemaOverrideContext = Parameters<ToJSONSchemaContext["override"]>[0];

/**
 * Narrows zod's base def to a discriminated union's, against zod's OWN exported def type rather than a local restatement of its shape.
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
 * `json-schema-fingerprint.test.ts` pins the stamp as a positive control, so a zod upgrade that silently stops producing it fails loudly there instead of quietly restoring the defect this closes.
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
 * The `io: "input"` rendering of `schema`, walked in lockstep with the fingerprint so every node - including each union arm individually - can be asked whether it REJECTS unknown keys rather than stripping them.
 * A parallel tree rather than a flattened path set: union arms share a path, so a path-keyed marker cannot say WHICH arm is strict.
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
 * Whether an object refuses to silently accept a key it does not declare - either by rejecting outright (`additionalProperties: false`, i.e.
 */
type UnknownKeyPolicy =
  /** Unknown keys are dropped before they reach the payload (plain `z.object`). */
  | { readonly kind: "strip" }
  /**
   * Unknown keys are accepted AND preserved (`.catchall(z.unknown())`, which renders as `additionalProperties: {}`).
   * Distinct from `strip`: a stripping schema never emits an undeclared key, a passthrough one does.
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

/** Input-tree counterparts of a union's arms, positionally. */
function inputVariants(previousInput: unknown): readonly unknown[] {
  const shape = asSchemaNode(previousInput);
  if (shape === null) return [];
  if (Array.isArray(shape.anyOf)) return shape.anyOf;
  if (Array.isArray(shape.oneOf)) return shape.oneOf;
  return [];
}

/** Directional comparison of array-level constraints. */
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
  // An object node with NO `required` array requires nothing - that is the rendering for a fully-optional/defaulted object, and it must not fall back to the output tree (which marks defaulted fields required).
  if (!Array.isArray(required)) return [];
  return required.filter((field): field is string => typeof field === "string");
}

/** Directional comparison of unknown-key policies. */
function unknownKeyPolicyRelaxation(
  previous: UnknownKeyPolicy,
  next: UnknownKeyPolicy,
  path: readonly string[],
): AdditivityViolation | null {
  const location = path.length === 0 ? "<root>" : dottedPath(path);
  // An older schema that drops or freely accepts unknown keys can never be
  // broken by what the newer one emits.
  if (previous.kind === "strip" || previous.kind === "passthrough") return null;
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

  // `z.discriminatedUnion(...)` (and some `z.union(...)` shapes under newer Zod versions) emit `oneOf` instead of `anyOf`.
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

export type AdditivityMode = "lenient" | "no-value-growth";

/**
 * First non-additive change between two fingerprints, or null when `next` is purely additive over `previous`.
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

/** First non-additive change while treating removed union arms as compatible. */
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

/** Classifier over schema nodes for the additivity walk. */
type ClassifiedSchemaNode =
  | {
      readonly kind: "object";
      readonly properties: Readonly<Record<string, unknown>>;
      /**
       * Carried because requiredness is part of what an older peer's schema ENFORCES: relaxing a required field to optional lets a newer peer emit a payload the older schema rejects, which the property walk alone cannot see.
       */
      readonly required: readonly string[];
    }
  | {
      readonly kind: "record";
      /** `propertyNames` subtree, `null` for a plain string key space. */
      readonly keys: unknown;
      /** `additionalProperties` subtree - the per-key value schema. */
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

  if (shape.type === "object" && shape.properties !== undefined) {
    return {
      kind: "object",
      properties: shape.properties,
      required: requiredFields,
    };
  }
  // A record (`z.record`): object-typed with one value schema for every key and no declared properties.
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
 * Two or more values is a choice rather than a tag, and anything else - an object, an array, an open scalar - cannot identify an arm.
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

/** Every literal value a property pins, or `null` when it pins none. */
function discriminantValues(
  property: unknown,
): ReadonlySet<string | number | boolean> | null {
  const classified = classifySchemaNode(property);
  if (classified.kind !== "enum" || classified.values.length === 0) return null;
  return new Set(classified.values);
}

/** Whether two declared tag value sets name the SAME arm - i.e. share at least one value. */
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
 * Whether `declared` actually tells THIS side's arms apart: pinned to at least one literal on every object arm, with no value shared between two of them.
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
 * Every next variant that IS this previous variant - the same arm, edited - or an empty list when the arm genuinely has no successor.
 */
function findDiscriminatedSuccessors(
  previousVariant: unknown,
  previousVariants: readonly unknown[],
  nextVariants: readonly unknown[],
  declared: string | null,
): readonly DiscriminatedSuccessor[] {
  const previous = classifySchemaNode(previousVariant);
  if (previous.kind !== "object") return [];
  // The DECLARED field wins outright when the union names one and that field still tells the arms apart on both sides.
  // Requiring it to survive inference therefore silently dropped every multi-value union straight back onto the incidental-tuple fallback, i.e. back into this exact defect.
  if (
    declared !== null &&
    declaredTagIdentifies(previousVariants, declared) &&
    declaredTagIdentifies(nextVariants, declared)
  ) {
    const previousValues = discriminantValues(previous.properties[declared]);
    if (previousValues === null) return [];
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
  const fields = inferred;
  if (fields.length === 0) return [];
  const identity = fields.map(
    (field) => [field, discriminantValue(previous.properties[field])] as const,
  );
  // At most one match, so no list to build: every field here is a SINGLE-value column that `discriminatorFields` already proved unique across the arms, so the tuple names one arm or none.
  // No alignment either - a single-value tag cannot be split across arms, so the arm's own column is never a false witness.
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
 * The properties that tell this union's arms apart: pinned to one literal in every OBJECT arm, with no value shared between two of them.
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
 * JSON Schema keywords that annotate a leaf without constraining the values it accepts.
 * `default` belongs here: it affects how an absent input is filled, never which emitted values are valid.
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
  // OUR OWN metadata, not the peer's contract.
  DECLARED_DISCRIMINATOR_KEY,
]);

/** Structural identity of a leaf, ignoring annotation-only keywords. Keys are sorted so declaration order never reads as a change. */
/** Bound keywords where a lower value on the newer side narrows the accepted set, so `next <= previous` still projects. */
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
 * Whether every value the NEWER leaf can emit is still accepted by the OLDER leaf.
 * Narrowing a scalar constraint (`z.string().max(10)` -> `z.string().max(5)`) is projection-safe and must not be reported; widening it is not.
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
 * The node with ONLY this file's own discriminator stamp removed, everything else - key order included - left exactly as `z.toJSONSchema` emitted it.
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
      const successors = allowUnionArmReplacement
        ? findDiscriminatedSuccessors(
            previous,
            [previous],
            nextNode.variants,
            // The previous node is not a union here (a single form GREW into one), so only the new union declares anything.
            nextNode.discriminator,
          )
        : [];
      if (successors.length > 0) {
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
    for (const field of Object.keys(previousNode.properties)) {
      // `Object.hasOwn`, not `in`: a schema property legitimately named `constructor`/`toString`/`valueOf` would match an inherited prototype member, silently passing the removal check and then classifying a function as an.
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
        // A typed catchall already ACCEPTS unknown keys that satisfy it, so an addition whose own schema fits the catchall still projects - rejecting it outright would force safe evolution into a major.
        // This comparison is ALWAYS strict, never the caller's `mode`: the question is whether every value the new property admits satisfies the old catchall, which is a subset test.
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
    // An unknown-key policy can also be RELAXED without declaring any new field: `z.strictObject({a})` -> the same shape with `.catchall(...)` or passthrough.
    const nextPolicy = unknownKeyPolicy(nextInput);
    const policyViolation = unknownKeyPolicyRelaxation(
      policy,
      nextPolicy,
      path,
    );
    if (policyViolation !== null) return policyViolation;
    // Relaxing required -> optional is not additive: the newer peer may omit the field, and the older schema rejects the payload outright.
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
    const previousInputArms = inputVariants(previousInput);
    const nextInputArms = inputVariants(nextInput);
    for (const [index, previousVariant] of previousNode.variants.entries()) {
      // Each arm carries its OWN unknown-key behaviour: a mixed union (one strict arm, one stripping arm) must reject growth of the strict arm while still allowing growth of the stripping one.
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
      // An arm that still has a successor was EDITED, not replaced, so the exemption does not reach it: report what the edit actually broke.
      const successors = allowUnionArmReplacement
        ? findDiscriminatedSuccessors(
            previousVariant,
            previousNode.variants,
            nextNode.variants,
            // Both sides must call identity the same thing.
            previousNode.discriminator === nextNode.discriminator
              ? previousNode.discriminator
              : null,
          )
        : [];
      if (successors.length > 0) {
        for (const successor of successors) {
          const edited = findNodeAdditivityViolation(
            successor.previous,
            nextNode.variants[successor.index],
            path,
            mode,
            previousArmInput,
            nextInputArms[successor.index] ?? null,
            // Passed through, NOT forced off: a union nested inside this arm may still have had one of ITS arms genuinely replaced under the same declaration, and that is what the exemption is for.
            // What must not survive is this arm's own reduction, and that returns a `required-field` / `enum-value` / `schema-kind` violation, none of which consult the flag.
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
      // EXEMPT means "this arm's removal is not a violation", not "stop looking".
      continue;
    }
    if (mode === "no-value-growth") {
      for (const [nextIndex, nextVariant] of nextNode.variants.entries()) {
        // Probe in the SAME mode as the survival loop.
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
    // Array-level bounds constrain the payload independently of `items`: widening `.max(1)` to `.max(2)` lets the newer peer emit a two-element array the older schema rejects, with identical item schemas.
    // The newer bounds must stay at least as tight as the older ones.
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
 * First breaking change between two latest-of-major fingerprints, or null when `next` is fully backwards-compatible.
 */
export function findBreakingChange(
  previous: JsonSchemaFingerprint,
  next: JsonSchemaFingerprint,
  previousInput: unknown,
  nextInput: unknown,
): BreakingChange | null {
  // Major justification only asks "is this breaking"; strictness-aware growth detection is an additivity concern, so no strict paths here.
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
