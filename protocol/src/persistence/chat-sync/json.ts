import { z } from "zod";

/**
 * Plain-JSON value vocabulary + the canonical encoder for the
 * `chat-head` / `chat-shard` records.
 *
 * Two jobs:
 *
 * 1. **Passthrough carrier.** Unknown message / content-block / event
 *    variants are preserved verbatim (see `passthrough.ts`), and "verbatim"
 *    needs a type. The schemas here validate that an unmodeled subtree is
 *    actually JSON before a reader promises to re-emit it - an unvalidated
 *    `z.unknown()` bag would let a non-serializable value through and blow
 *    up at publish time instead of at parse time.
 *
 * 2. **Canonical form.** A published snapshot is content-addressed
 *    (`sha256` on the publication ref), and readers re-emit subtrees they
 *    never interpreted. Both need one deterministic encoding, so
 *    `canonicalizeJsonValue` deep-sorts object keys and
 *    `canonicalJsonStringify` serializes the sorted form. Losslessness here
 *    is SEMANTIC, not byte-for-byte: key order is normalized away, values
 *    are preserved exactly.
 *
 * **Validation must not rebuild.** `z.record(...)` (and `z.json()`) construct
 * a fresh object from the parsed entries, which silently drops an own
 * `__proto__` key - a perfectly legal JSON key that `JSON.parse` really does
 * produce as an own property. A dropped key is a hole in the
 * complete-subtree guarantee, so the schemas below are predicate checks over
 * `z.any()`: they validate the value and hand back the very same reference.
 * Rebuilding happens only in the canonicalizers, which use a null-prototype
 * target and `Object.defineProperty` so `__proto__` lands as an own key
 * instead of invoking the prototype setter.
 *
 * The trade-off is that these positions render as `{}` in the record's
 * `storage` JSON-Schema surface. That is honest - what they accept really is
 * "any JSON" - and the interpreted shapes are still frozen on the `domain`
 * side.
 *
 * The same machinery backs the residual capture in `residual.ts`, which is
 * why unmodeled keys of a MODELED object are preserved with the same fidelity
 * as an unknown variant's subtree.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

// ---- Predicates (no reconstruction) ------------------------------------ //

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;

  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      // Rejects NaN / ±Infinity, which have no JSON representation.
      return Number.isFinite(value);
    case "object":
      return Array.isArray(value)
        ? value.every((entry) => isJsonValue(entry))
        : isJsonObject(value);
    default:
      return false;
  }
}

export function isJsonObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  // Plain objects only. A `Date`, `Map`, or class instance has no own
  // enumerable properties, so an own-property-only check would call it a valid
  // empty JSON object and canonicalization would quietly flatten it to `{}`.
  // `null` is allowed because that is what the canonicalizer produces.
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;

  if (Object.getOwnPropertySymbols(value).length > 0) return false;

  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) return false;
    // Accessors and non-enumerable properties are not JSON.
    if (!descriptor.enumerable) return false;
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      return false;
    }
    if (!isJsonValue(descriptor.value)) return false;
  }

  return true;
}

/**
 * Own-property read that works for every legal JSON key, `__proto__`
 * included. A plain `value[key]` would resolve through the prototype for a
 * value that happens not to carry the key as its own.
 */
export function readJsonProperty(
  value: JsonObject,
  key: string,
): JsonValue | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor === undefined ? undefined : descriptor.value;
}

// ---- Schemas ----------------------------------------------------------- //

// Predicate checks over `z.any()`, not structural schemas: `z.any()` hands
// back the value it was given, so no own key is rebuilt away (see the module
// note above). Input is pinned alongside output so consumers can embed these
// in codecs whose `encode` side stays typed as JSON.
export const jsonValueSchema: z.ZodType<JsonValue, JsonValue> = z
  .any()
  .superRefine((value, ctx) => {
    if (isJsonValue(value)) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Expected a JSON value (no undefined, NaN, or non-plain object)",
    });
  });

export const jsonObjectSchema: z.ZodType<JsonObject, JsonObject> = z
  .any()
  .superRefine((value, ctx) => {
    if (isJsonObject(value)) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Expected a JSON object",
    });
  });

// ---- Canonical form ---------------------------------------------------- //

/**
 * Deep-sorts object keys so the same semantic value always encodes to the
 * same string. Arrays keep their order (it is meaningful); `undefined` cannot
 * appear because the input is already validated JSON.
 */
export function canonicalizeJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeJsonValue(entry));
  }

  if (typeof value === "object" && value !== null) {
    return canonicalizeJsonObject(value);
  }

  return value;
}

/**
 * Rebuilds `value` with sorted keys onto a NULL-PROTOTYPE object using
 * `Object.defineProperty`. Both details are load-bearing: assigning
 * `target["__proto__"] = …` on an ordinary object invokes the inherited
 * setter and creates no own key, so a legal JSON `__proto__` would vanish
 * from the re-emitted subtree.
 */
export function canonicalizeJsonObject(value: JsonObject): JsonObject {
  const canonical: JsonObject = Object.create(null);

  for (const key of Object.getOwnPropertyNames(value).sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) continue;

    Object.defineProperty(canonical, key, {
      value: canonicalizeJsonValue(descriptor.value),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  return canonical;
}

/**
 * Canonical serialization: `canonicalizeJsonValue` then `JSON.stringify`.
 * `JSON.stringify` preserves insertion order, so the sorted form survives
 * into the emitted bytes, and it emits an own `__proto__` key faithfully.
 * This is the string a publisher hashes and uploads.
 */
export function canonicalJsonStringify(value: JsonValue): string {
  return JSON.stringify(canonicalizeJsonValue(value));
}
