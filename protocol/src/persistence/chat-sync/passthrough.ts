import { z } from "zod";
import {
  canonicalizeJsonObject,
  isJsonObject,
  jsonObjectSchema,
  readJsonProperty,
  type JsonObject,
} from "@traycer/protocol/persistence/chat-sync/json";

/**
 * Semantic unknown-variant passthrough.
 *
 * A published chat is read by cloud renderers and clone targets on
 * different release cadences, so a reader routinely meets a variant a newer
 * writer introduced - a content-block `type`, a message `role`, a chat-event
 * `type`. A plain `z.discriminatedUnion` rejects the whole record in that
 * case (the ScheduleWakeup regression), and a plain `z.object` silently
 * STRIPS the unmodeled keys, which is worse here than rejecting: a clone that
 * re-publishes a stripped snapshot destroys data the writer still owned.
 *
 * `definePreservedVariant` replaces both failure modes with one contract:
 *
 * - the persisted side accepts any JSON object carrying a string discriminant;
 * - `value` is the parsed view when the discriminant is in this reader's
 *   vocabulary, and `null` when it is not;
 * - `raw` is ALWAYS the canonicalized persisted object, so re-emission is
 *   lossless for the interpreted and uninterpreted cases alike.
 *
 * That is what reclassifies a new content-block type from a breaking change
 * to a minor one: shipped readers keep parsing, keep rendering what they
 * know, and keep round-tripping what they do not.
 *
 * A KNOWN variant that fails to parse still throws. Passthrough is for
 * vocabulary the reader lacks, not a blanket swallow of corruption -
 * `gateChatHeadVersion` (see `head.ts`) rejects a publication on a different
 * major, or one whose HEAD carries an explicit `minReaderVersion` this build is
 * below, before any part is fetched. v2 has no publication-ref union: the head
 * is the row's opaque JSON, so the gate reads off the head itself. Everything
 * it admits is a publication whose known variants are expected to parse.
 *
 * Note on the frozen-surface guard: because the persisted side is
 * deliberately open, the `storage` (`io: "input"`) JSON Schema shows the
 * envelope, not the block/message fields. The `domain` surface carries the
 * interpreted shapes, so drift in those still trips the guard there.
 */

export type PreservedVariant<Value> = {
  /** Discriminant value read off the persisted object (`"text"`, `"user"`, …). */
  readonly variant: string;
  /**
   * Canonicalized persisted object, kept verbatim. Authoritative for
   * re-emission: an encoder writes this back, so a subtree this reader could
   * not interpret survives a read/write cycle with its meaning intact.
   */
  readonly raw: JsonObject;
  /** Parsed view, or `null` when `variant` is outside this reader's vocabulary. */
  readonly value: Value | null;
};

export function definePreservedVariant<KnownSchema extends z.ZodType>(options: {
  /** Object key carrying the variant tag. */
  discriminant: string;
  /** Variant tags this build interprets; anything else passes through. */
  knownVariants: readonly string[];
  /** Schema for an interpreted variant, applied to the whole persisted object. */
  knownSchema: KnownSchema;
  /** Human label used in the "missing discriminant" failure (`"content block"`, …). */
  label: string;
}) {
  const knownVariants = new Set(options.knownVariants);

  // Deliberately open: any JSON object carrying a string discriminant. That
  // openness is the contract, which is why the record's `storage`
  // (`io: "input"`) JSON Schema shows this envelope rather than the block /
  // message fields - the `domain` surface below carries those.
  //
  // A predicate over `z.any()` rather than `z.record(...)`: a record schema
  // rebuilds the object from its entries, which drops an own `__proto__` key
  // before `decode` ever sees it. See `json.ts`.
  const persistedSchema: z.ZodType<JsonObject, JsonObject> = z
    .any()
    .superRefine((value, ctx) => {
      if (!isJsonObject(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `A persisted ${options.label} must be a JSON object`,
        });
        return;
      }

      if (typeof readJsonProperty(value, options.discriminant) === "string") {
        return;
      }

      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [options.discriminant],
        message: `A persisted ${options.label} must carry a string '${options.discriminant}' discriminant`,
      });
    });

  // `value` is piped from `unknown` so the known schema does the parsing here,
  // in one pass, with real issue paths - `decode` below only decides whether
  // the variant is in this reader's vocabulary.
  const domainSchema = z.object({
    variant: z.string(),
    raw: jsonObjectSchema,
    value: z.unknown().pipe(options.knownSchema).nullable(),
  });

  return z.codec(persistedSchema, domainSchema, {
    decode: (persisted) => {
      const tag = readJsonProperty(persisted, options.discriminant);
      const variant = typeof tag === "string" ? tag : "";

      return {
        variant,
        raw: canonicalizeJsonObject(persisted),
        value: knownVariants.has(variant) ? persisted : null,
      };
    },
    encode: (domain): JsonObject => canonicalizeJsonObject(domain.raw),
  });
}

/**
 * Writer-side constructor: pairs an interpreted value with its canonical
 * persisted encoding. `encoded` must be what the value serializes to on
 * disk - `core.ts` derives it through `z.encode(...)` so codec-backed
 * members (the `autonomous_resume` block) are written in their persisted
 * form rather than their domain form.
 */
export function preserveKnownVariant<Value>(
  discriminant: string,
  encoded: JsonObject,
  value: Value,
): PreservedVariant<Value> {
  const tag = readJsonProperty(encoded, discriminant);
  if (typeof tag !== "string") {
    throw new Error(
      `Encoded variant is missing a string '${discriminant}' discriminant`,
    );
  }

  return { variant: tag, raw: canonicalizeJsonObject(encoded), value };
}
