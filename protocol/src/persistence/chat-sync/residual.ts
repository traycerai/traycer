import {
  canonicalizeJsonObject,
  isJsonObject,
  jsonObjectSchema,
  jsonValueSchema as jsonObjectValueSchema,
  type JsonObject,
} from "@traycer/protocol/persistence/chat-sync/json";
import { z } from "zod";

/**
 * Residual capture for modeled `chat-head` / `chat-shard` objects. `residual` is a reserved named field; capture is idempotent; a non-object `residual` is ordinary data.
 * Shard bags do not survive re-publication. Use `z.preprocess` so capture sees original input (`__proto__`-safe). Frozen `storage` surface comes from `storageProjection`, not these schemas.
 */

export const CHAT_SNAPSHOT_RESIDUAL_KEY = "residual";

/** The `residual` bag as it appears on every captured domain object. */
export const residualSchema = jsonObjectSchema;

function defineOwn(target: JsonObject, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** Is this value a JSON OBJECT rather than an array, a primitive or `null`? */
function isJsonObjectKind(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Merges an already-captured bag into the object being built, descending through however many times the pre-idempotence encoder wrapped it.
 * There is no top-level copy - the 1.0 reader never had one to write.
 */
function absorbPriorResidual(
  into: JsonObject,
  kept: JsonObject,
  prior: JsonObject,
  declared: ReadonlySet<string>,
): void {
  let level: JsonObject | null = prior;

  while (level !== null) {
    let deeper: JsonObject | null = null;

    for (const key of Object.getOwnPropertyNames(level)) {
      const descriptor = Object.getOwnPropertyDescriptor(level, key);
      if (descriptor === undefined) continue;

      if (
        key === CHAT_SNAPSHOT_RESIDUAL_KEY &&
        isJsonObjectKind(descriptor.value)
      ) {
        deeper = descriptor.value;
        continue;
      }

      const target = declared.has(key) ? kept : into;
      // Shallower wins, for promotion as for retention.
      if (Object.getOwnPropertyDescriptor(target, key) !== undefined) continue;
      defineOwn(target, key, descriptor.value);
    }

    level = deeper;
  }
}

/**
 * Splits `raw`'s own keys into the declared ones and a canonicalized `residual` bag, ahead of the object schema that will parse the result.
 * Idempotent: an own `residual` key holding a JSON OBJECT is read as a prior bag and merged in rather than re-bagged, so re-capturing an object this function already produced is a no-op and a legacy nest flattens on the.
 */
export function captureResidualKeys(
  declaredKeys: readonly string[],
): (raw: unknown) => unknown {
  const declared = new Set(declaredKeys);

  return (raw) => {
    if (!isJsonObject(raw)) return raw;

    const kept: JsonObject = Object.create(null);
    const residual: JsonObject = Object.create(null);
    let prior: JsonObject | null = null;

    for (const key of Object.getOwnPropertyNames(raw)) {
      const descriptor = Object.getOwnPropertyDescriptor(raw, key);
      if (descriptor === undefined) continue;

      if (declared.has(key)) {
        defineOwn(kept, key, descriptor.value);
        continue;
      }

      if (
        key === CHAT_SNAPSHOT_RESIDUAL_KEY &&
        isJsonObjectKind(descriptor.value)
      ) {
        prior = descriptor.value;
        continue;
      }

      defineOwn(residual, key, descriptor.value);
    }

    if (prior !== null) absorbPriorResidual(residual, kept, prior, declared);

    defineOwn(
      kept,
      CHAT_SNAPSHOT_RESIDUAL_KEY,
      canonicalizeJsonObject(residual),
    );
    return kept;
  };
}

/** What a capture site reports about itself. */
export type CapturedLevelRegistration = {
  /** Stable identifier, matching a `CAPTURED_RESIDUAL_LEVELS` entry. */
  readonly id: string;
  /** Declared (modeled) keys at this level - everything else is residual. */
  readonly declaredKeys: readonly string[];
};

/**
 * Every capture site created in this process, in construction order.
 * Consumers outside this package must not read it - they iterate `CAPTURED_RESIDUAL_LEVELS` instead, which carries the typed accessors.
 */
const capturedLevelRegistrations: CapturedLevelRegistration[] = [];

export function listCapturedLevelRegistrations(): readonly CapturedLevelRegistration[] {
  return capturedLevelRegistrations;
}

/**
 * Wraps a modeled object schema so it captures unmodeled keys.
 * `id` is the level's STABLE CONTRACT identifier and must match its `CAPTURED_RESIDUAL_LEVELS` entry.
 */
export function withResidualCapture<Shape extends z.ZodRawShape>(
  id: string,
  shape: Shape,
) {
  const declaredKeys = Object.keys(shape);
  capturedLevelRegistrations.push({ id, declaredKeys });
  return reprojectResidualCapture(shape);
}

/** The same wrapper WITHOUT registering a level. */
export function reprojectResidualCapture<Shape extends z.ZodRawShape>(
  shape: Shape,
) {
  return z.preprocess(
    captureResidualKeys(Object.keys(shape)),
    z.object({ ...shape, [CHAT_SNAPSHOT_RESIDUAL_KEY]: residualSchema }),
  );
}

/**
 * The WIRE shape of a captured level: declared fields, no `residual`, and unmodeled keys explicitly allowed.
 * This exists because `withResidualCapture`'s own JSON Schema cannot describe the wire.
 */
export function storageProjection<Shape extends z.ZodRawShape>(shape: Shape) {
  return z.object(shape).catchall(jsonObjectValueSchema);
}

/**
 * Encoder counterpart: merges a captured bag back beside the declared fields.
 * Declared keys win on the (impossible by construction) collision, so a malformed hand-built record can never have its modeled state overwritten by its own residual.
 */
export function mergeResidual(
  declared: JsonObject,
  residual: JsonObject,
): JsonObject {
  const merged: JsonObject = Object.create(null);

  for (const key of Object.getOwnPropertyNames(residual)) {
    const descriptor = Object.getOwnPropertyDescriptor(residual, key);
    if (descriptor === undefined) continue;
    defineOwn(merged, key, descriptor.value);
  }

  for (const key of Object.getOwnPropertyNames(declared)) {
    const descriptor = Object.getOwnPropertyDescriptor(declared, key);
    if (descriptor === undefined) continue;
    defineOwn(merged, key, descriptor.value);
  }

  return merged;
}
