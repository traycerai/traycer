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
 * ## Reserved name, and why capture is idempotent
 *
 * `residual` is reserved at every captured level: a future modeled field must
 * not be called that. It is reserved in a stronger sense than "do not use it",
 * because capture READS it: an own `residual` key whose value is a JSON OBJECT
 * is taken to be a PRIOR BAG and its contents are merged into the new one,
 * recursively, rather than re-bagged under a second `residual` key.
 *
 * That is what makes `capture` idempotent -
 * `capture(capture(x)) === capture(x)` - and idempotence is not cosmetic here.
 * A capturing level whose emission does not spread the bag back out re-offers
 * its own POST-CAPTURE object on the next decode. Without this rule each cycle
 * would wrap the bag one level deeper (`{residual: R}` →
 * `{residual: {residual: R}}` → …), so a chat's inline surface would drift by
 * an empty wrapper per reconcile and stop matching a fresh fold of the same
 * state. It did exactly that in the field, to depth 19. Reading a prior bag
 * back also HEALS an already-nested lineage on its next parse, with no repair
 * pass.
 *
 * A NON-object `residual` (string, number, array, `null`) cannot be a bag this
 * module produced, so it survives as ordinary data under the key `residual`.
 * On collision the SHALLOWER key wins: the outermost keys are the newest
 * capture cycle's reading of the object, and deeper ones are older copies of
 * the same thing.
 *
 * Merging routes each key to the home the CURRENT schema gives it: a key the
 * schema now declares is promoted out of the bag and into the modeled fields,
 * because after a version skew the bag can hold that field's only copy. See
 * `absorbPriorResidual` for the sequence that produces one.
 *
 * The wire is unchanged by any of this - the encoder still emits one bag - so
 * this is a decode-side rule only.
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
 * Is this value a JSON OBJECT rather than an array, a primitive or `null`?
 *
 * PRECONDITION: `value` has already been deep-validated as JSON, by an
 * `isJsonObject` call on an ancestor. Sound only under that precondition, which
 * is why it is local to this module and not exported beside `isJsonObject` -
 * as a general validator it would accept a `Date` or a class instance.
 *
 * It exists because the chain walk below would otherwise be QUADRATIC.
 * `isJsonObject` validates every descendant, so calling it once per level
 * re-validates the whole remaining suffix: a chain of depth N costs
 * N + (N-1) + … + 1. Capture already validated the entire raw tree on entry, so
 * every prior bag in the chain is a descendant of an object that was checked -
 * re-deriving that is work with no question attached to it. At depth 10,000 the
 * quadratic form occupied the decoder for seconds on a value under 130 KB.
 */
function isJsonObjectKind(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Merges an already-captured bag into the object being built, descending
 * through however many times the pre-idempotence encoder wrapped it.
 *
 * Written first-wins because the caller has already read the object's OWN keys
 * into `kept` and `into`: those are this cycle's reading of the level, and each
 * level down is an older copy of the same key. Descent stops at the first
 * `residual` that is not an object - that one is data, and it lands as data.
 *
 * ## Where a declared key found in a bag goes
 *
 * To `kept`, not to the bag - and this is the subtle half. The rule cannot be
 * "drop it", even though the bag's standing invariant is that it holds only
 * unmodeled keys, because the bag can hold the SOLE copy of a now-modeled
 * field. That is an ordinary same-major version skew, not a corrupt input:
 *
 * 1. A 1.1 writer puts `newSetting: V` on the wire.
 * 2. A 1.0 reader does not declare it, so capture bags it:
 *    `{…, residual: { newSetting: V }}`. There is no top-level copy - the 1.0
 *    reader never had one to write.
 * 3. That post-capture shape is a supported CARRIER, not a foreign format: a
 *    clone seed carries `core.settings` verbatim, and the host's settings
 *    adapter re-offers its opaque settings object whole.
 * 4. A 1.1 schema re-captures it. `newSetting` is declared now, and the bag is
 *    the only place it exists.
 *
 * Dropping there destroys the newer writer's field - silently for a defaulted
 * one like `serviceTier` or `profileId`, and as a hard parse failure for a
 * required one. Either way it contradicts the mechanically-lossless promise at
 * the top of this module, in exactly the case the bag exists to serve.
 *
 * So each bag key is routed to the home it belongs in - `kept` if the current
 * schema declares it, the bag otherwise - and shallowest still wins in both. A
 * declared key that `kept` ALREADY holds is therefore skipped, which keeps the
 * stale-shadow behaviour: an own modeled value is never overwritten by a bagged
 * copy of itself, the same precedence `mergeResidual` applies on the way out.
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
      // `getOwnPropertyDescriptor` rather than `in` or a truthiness check so a
      // legal `__proto__` key is tested as the own key it is, and a
      // present-but-null value still counts as present.
      if (Object.getOwnPropertyDescriptor(target, key) !== undefined) continue;
      defineOwn(target, key, descriptor.value);
    }

    level = deeper;
  }
}

/**
 * Splits `raw`'s own keys into the declared ones and a canonicalized
 * `residual` bag, ahead of the object schema that will parse the result.
 *
 * Idempotent: an own `residual` key holding a JSON OBJECT is read as a prior
 * bag and merged in rather than re-bagged, so re-capturing an object this
 * function already produced is a no-op and a legacy nest flattens on the way
 * through. See the "Reserved name" note above for why that matters and what it
 * costs (an object-valued `residual` on the wire is no longer ordinary data).
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
    let prior: JsonObject | null = null;

    for (const key of Object.getOwnPropertyNames(raw)) {
      const descriptor = Object.getOwnPropertyDescriptor(raw, key);
      if (descriptor === undefined) continue;

      if (declared.has(key)) {
        defineOwn(kept, key, descriptor.value);
        continue;
      }

      // `isJsonObjectKind`, not `isJsonObject`: the guard above already
      // deep-validated `raw`, so re-validating this subtree would be the first
      // step of the quadratic walk the chain descent exists to avoid.
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
