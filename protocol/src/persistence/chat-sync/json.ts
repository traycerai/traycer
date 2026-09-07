import { z } from "zod";

/**
 * Plain-JSON value vocabulary + the canonical encoder for the `chat-head` / `chat-shard` records.
 * That is honest - what they accept really is "any JSON" - and the interpreted shapes are still frozen on the `domain` side.
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

  // Plain objects only.
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

/** Own-property read that works for every legal JSON key, `__proto__` included. */
export function readJsonProperty(
  value: JsonObject,
  key: string,
): JsonValue | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor === undefined ? undefined : descriptor.value;
}

// ---- Schemas ----------------------------------------------------------- //

// Predicate checks over `z.any()`, not structural schemas: `z.any()` hands back the value it was given, so no own key is rebuilt away (see the module note above).
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
 * Deep-sorts object keys so the same semantic value always encodes to the same string.
 * Arrays keep their order (it is meaningful); `undefined` cannot appear because the input is already validated JSON.
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

/** Rebuilds `value` with sorted keys onto a NULL-PROTOTYPE object using `Object.defineProperty`. */
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

export function canonicalJsonStringify(value: JsonValue): string {
  return JSON.stringify(canonicalizeJsonValue(value));
}
