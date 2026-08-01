import {
  canonicalizeJsonObject,
  isJsonObject,
  jsonObjectSchema,
  jsonValueSchema as jsonObjectValueSchema,
  type JsonObject,
} from "@traycer/protocol/persistence/chat-sync/json";
import { z } from "zod";

/**
 * Residual capture for the MODELED objects of the `chat-head` / `chat-shard` records.
 *
 * The passthrough carrier makes a new content-block type, message role or
 * event type lossless for an older reader. This closes the other half: a new
 * field on `core` (or on the record, the lifecycle, the run settings, the
 * host-private envelope). A plain `z.object` strips an unmodeled key, and this
 * record's readers do not merely display what they read - a clone target
 * RE-PUBLISHES it. A stripped field is therefore destroyed, not ignored.
 *
 * So every modeled object captures its unmodeled own keys into one typed
 * `residual` field, and the encoder merges them back. A v1.0 clone target
 * re-publishing a v1.1 record is mechanically lossless for core scalars, the
 * same way it already is for unknown variants - no per-writer discipline, no
 * per-ref flag, nothing for a future author to remember.
 *
 * `residual` is deliberately a NAMED FIELD, not an index signature: consumers
 * keep precise types, and the bag is something a reader has to reach for on
 * purpose rather than something it can confuse with modeled state.
 *
 * The "mechanically lossless" claim above holds per LEVEL, and one level is an
 * exception a minor author has to know about: the `shard` bag never reaches a
 * re-publishing reader at all, because assembly folds shards into one chat and
 * keeps only the head's. See the COMPAT section in `captured-levels.ts` for
 * what a same-major minor may and may not put on a shard record.
 *
 * ## Why `z.preprocess`
 *
 * Capture has to see the ORIGINAL input. Zod's object parser rebuilds its
 * output, which drops an own `__proto__` key (see `json.ts`), so a `.catchall`
 * on the object itself would capture a subtly lossy copy. `z.preprocess` runs
 * ahead of the object schema on the untouched value, so the split uses the
 * `json.ts` own-property machinery throughout and is `__proto__`-safe end to
 * end.
 *
 * The alternatives do not work at all: a codec would re-validate the domain
 * side, feeding already-decoded messages back through the message codec's
 * persisted schema, and a `.transform` is unrepresentable in output mode.
 *
 * The cost is that a capturing schema cannot describe its own WIRE form.
 * `z.toJSONSchema` reports a preprocess's INNER schema in both IO modes, and
 * that inner schema is the post-capture DOMAIN shape - it requires `residual`
 * and, because a preprocess accepts `unknown`, marks every captured child
 * optional. `storageProjection` below exists for exactly that gap; the frozen
 * `storage` surface is generated from it, not from these schemas.
 *
 * ## Reserved name
 *
 * `residual` is reserved at every captured level: a future modeled field must
 * not be called that. A persisted key of that name still round-trips (it lands
 * in the bag and is re-emitted from there), it just reads oddly.
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

/**
 * Splits `raw`'s own keys into the declared ones and a canonicalized
 * `residual` bag, ahead of the object schema that will parse the result.
 *
 * A non-object input is handed straight through so the inner schema produces
 * the normal type error rather than this step swallowing it.
 */
export function captureResidualKeys(
  declaredKeys: readonly string[],
): (raw: unknown) => unknown {
  const declared = new Set(declaredKeys);

  return (raw) => {
    if (!isJsonObject(raw)) return raw;

    const kept: JsonObject = Object.create(null);
    const residual: JsonObject = Object.create(null);

    for (const key of Object.getOwnPropertyNames(raw)) {
      const descriptor = Object.getOwnPropertyDescriptor(raw, key);
      if (descriptor === undefined) continue;
      defineOwn(declared.has(key) ? kept : residual, key, descriptor.value);
    }

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
 *
 * The ground truth for "which captured levels exist". Consumers outside this
 * package must not read it - they iterate `CAPTURED_RESIDUAL_LEVELS` instead,
 * which carries the typed accessors. This exists so the manifest's
 * completeness guard has something to check ITSELF against, without reaching
 * into Zod's private internals to go hunting for preprocess nodes.
 *
 * Populated at module-load time, so a reader must have imported the record
 * schema (which transitively builds every level reachable from it) before the
 * list is meaningful.
 */
const capturedLevelRegistrations: CapturedLevelRegistration[] = [];

export function listCapturedLevelRegistrations(): readonly CapturedLevelRegistration[] {
  return capturedLevelRegistrations;
}

/**
 * Wraps a modeled object schema so it captures unmodeled keys.
 *
 * Pass the shape (not the built object) so the declared key list and the
 * schema can never disagree about what "unmodeled" means.
 *
 * `id` is the level's STABLE CONTRACT identifier and must match its
 * `CAPTURED_RESIDUAL_LEVELS` entry. Declaring it here rather than only in the
 * manifest is what lets the guard check identity instead of a bare count, and
 * anchors the id to the schema it names - see `captured-levels.ts` for why
 * downstream consumers depend on an id never being reused with new meaning.
 */
export function withResidualCapture<Shape extends z.ZodRawShape>(
  id: string,
  shape: Shape,
) {
  const declaredKeys = Object.keys(shape);
  capturedLevelRegistrations.push({ id, declaredKeys });
  return reprojectResidualCapture(shape);
}

/**
 * The same wrapper WITHOUT registering a level.
 *
 * For an alternate projection of a level that is already registered - the
 * reader's version-widened record schema is the same `record` level, just
 * accepting more. Registering it again would double-count the level and fail
 * the manifest guard for no reason.
 */
export function reprojectResidualCapture<Shape extends z.ZodRawShape>(
  shape: Shape,
) {
  return z.preprocess(
    captureResidualKeys(Object.keys(shape)),
    z.object({ ...shape, [CHAT_SNAPSHOT_RESIDUAL_KEY]: residualSchema }),
  );
}

/**
 * The WIRE shape of a captured level: declared fields, no `residual`, and
 * unmodeled keys explicitly allowed.
 *
 * This exists because `withResidualCapture`'s own JSON Schema cannot describe
 * the wire. `z.toJSONSchema` reports a preprocess's INNER schema in both IO
 * modes, and the inner schema is the post-capture domain shape: it requires
 * `residual` (a key that never appears on the wire) and, because a preprocess
 * accepts `unknown`, it marks every captured child field as optional. Freezing
 * that as the storage surface would assert the opposite of the truth on both
 * counts - a valid snapshot would fail it, and one missing `core` would pass.
 *
 * So the storage surface is projected explicitly from the SAME shape maps,
 * substituting this projection at each nested captured level. Same source of
 * truth, honest output; `chat-sync-schema-surface-compat.test.ts` asserts
 * the projection actually accepts a wire record and rejects a truncated one.
 */
export function storageProjection<Shape extends z.ZodRawShape>(shape: Shape) {
  return z.object(shape).catchall(jsonObjectValueSchema);
}

/**
 * Encoder counterpart: merges a captured bag back beside the declared fields.
 * Declared keys win on the (impossible by construction) collision, so a
 * malformed hand-built record can never have its modeled state overwritten by
 * its own residual.
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
