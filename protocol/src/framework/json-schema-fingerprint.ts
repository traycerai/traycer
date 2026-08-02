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

/** Array fingerprint (z.array). */
export type ArrayJsonSchema = {
  readonly type: "array";
  readonly items: JsonSchemaFingerprint;
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
    return {
      type: "array",
      items: convertJsonSchemaShape(node.items, `${context}.items`),
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
  | { readonly kind: "enum-value"; readonly detail: string }
  | { readonly kind: "union-variant"; readonly detail: string }
  | { readonly kind: "array-items"; readonly detail: string }
  | { readonly kind: "schema-kind"; readonly detail: string };

/**
 * First non-additive change between two fingerprints, or null when
 * `next` is purely additive over `previous`. Used to enforce the
 * within-major-line additivity invariant - minor bumps may add but
 * never remove or change the kind of a field, enum value, or union
 * variant.
 */
export function findAdditivityViolation(
  previous: JsonSchemaFingerprint,
  next: JsonSchemaFingerprint,
): AdditivityViolation | null {
  if (previous.type !== next.type) {
    return {
      kind: "schema-kind",
      detail: `${previous.type} -> ${next.type}`,
    };
  }

  if (previous.type === "object" && next.type === "object") {
    for (const field of Object.keys(previous.properties)) {
      if (!(field in next.properties)) {
        return { kind: "field", detail: field };
      }
    }
    return null;
  }

  if (previous.type === "enum" && next.type === "enum") {
    if (previous.representation !== next.representation) {
      return {
        kind: "schema-kind",
        detail: `enum representation ${previous.representation} -> ${next.representation}`,
      };
    }
    for (const value of previous.values) {
      if (!next.values.includes(value)) {
        return { kind: "enum-value", detail: String(value) };
      }
    }
    return null;
  }

  if (previous.type === "anyOf" && next.type === "anyOf") {
    const nextFingerprints = new Set(
      next.variants.map((variant) => JSON.stringify(variant)),
    );
    for (const previousVariant of previous.variants) {
      const previousFingerprint = JSON.stringify(previousVariant);
      if (!nextFingerprints.has(previousFingerprint)) {
        return {
          kind: "union-variant",
          detail: previousFingerprint.slice(0, 80),
        };
      }
    }
    return null;
  }

  if (previous.type === "array" && next.type === "array") {
    const itemsViolation = findAdditivityViolation(previous.items, next.items);
    if (itemsViolation !== null) {
      return {
        kind: "array-items",
        detail: describeAdditivityViolation(itemsViolation),
      };
    }
    return null;
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
): BreakingChange | null {
  const additivityViolation = findAdditivityViolation(previous, next);
  if (additivityViolation !== null) {
    if (additivityViolation.kind === "schema-kind") {
      return { ...additivityViolation, reason: "schema-changed" };
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
    const itemsBreakingChange = findBreakingChange(previous.items, next.items);
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
    case "enum-value":
      return `drops enum value '${violation.detail}'`;
    case "union-variant":
      return `drops union variant '${violation.detail}'`;
    case "array-items":
      return `array items: ${violation.detail}`;
    case "schema-kind":
      return `changes schema kind (${violation.detail})`;
  }
}
