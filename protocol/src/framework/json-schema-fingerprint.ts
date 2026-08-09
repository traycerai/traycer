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
  | { readonly kind: "required-field"; readonly detail: string }
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
): AdditivityViolation | null {
  return findNodeAdditivityViolation(previous, next, [], mode);
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
      const oldFormRetained = nextNode.variants.some(
        (variant) =>
          findNodeAdditivityViolation(previous, variant, path, mode) === null,
      );
      return oldFormRetained
        ? null
        : { kind: "union-variant", detail: snippet(previous) };
    }
    // Union collapse: only additive when every previous variant's payloads
    // still project onto the replacement schema.
    if (previousNode.kind === "anyOf") {
      for (const variant of previousNode.variants) {
        if (findNodeAdditivityViolation(variant, next, path, mode) !== null) {
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
      );
      if (nested !== null) return nested;
    }
    // Relaxing required -> optional is not additive: the newer peer may omit
    // the field, and the older schema rejects the payload outright. (A field
    // that merely gains a `default` stays in `required` - `z.toJSONSchema`
    // describes the output shape - so this does not catch that case.)
    const nextRequired = new Set(nextNode.required);
    for (const field of previousNode.required) {
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
    for (const previousVariant of previousNode.variants) {
      const survives = nextNode.variants.some(
        (nextVariant) =>
          findNodeAdditivityViolation(
            previousVariant,
            nextVariant,
            path,
            mode,
          ) === null,
      );
      if (survives) continue;
      if (mode === "no-value-growth") {
        const lenientMatch = nextNode.variants.find(
          (nextVariant) =>
            findNodeAdditivityViolation(
              previousVariant,
              nextVariant,
              path,
              "lenient",
            ) === null,
        );
        if (lenientMatch !== undefined) {
          return findNodeAdditivityViolation(
            previousVariant,
            lenientMatch,
            path,
            mode,
          );
        }
      }
      return { kind: "union-variant", detail: snippet(previousVariant) };
    }
    if (mode === "no-value-growth") {
      for (const nextVariant of nextNode.variants) {
        // Probe in the SAME mode as the survival loop. Under "lenient" a
        // new arm that differs from an old one only by value growth would
        // count as "having a predecessor" and escape the gate - e.g.
        // previous [A], next [A, A'] where A' is A with an extra enum
        // value: A survives strictly, and A' must still be reported.
        const hasPredecessor = previousNode.variants.some(
          (previousVariant) =>
            findNodeAdditivityViolation(
              previousVariant,
              nextVariant,
              path,
              mode,
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
    const itemsViolation = findNodeAdditivityViolation(
      previousNode.items,
      nextNode.items,
      [...path, "items"],
      mode,
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
    if (
      constrainingShape(previousNode.node) ===
      constrainingShape(nextNode.node)
    ) {
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
): BreakingChange | null {
  const additivityViolation = findAdditivityViolation(previous, next, "lenient");
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
    case "required-field":
      return `makes required field '${violation.detail}' optional`;
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
