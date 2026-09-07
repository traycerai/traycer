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
 * Note on the frozen-surface guard: because the persisted side is deliberately open, the `storage` (`io: "input"`) JSON Schema shows the envelope, not the block/message fields.
 */

export type PreservedVariant<Value> = {
  /** Discriminant value read off the persisted object (`"text"`, `"user"`, …). */
  readonly variant: string;
  /** Canonicalized persisted object, kept verbatim. */
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

  // Deliberately open: any JSON object carrying a string discriminant.
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
 * Writer-side constructor: pairs an interpreted value with its canonical persisted encoding.
 * `encoded` must be what the value serializes to on disk - `core.ts` derives it through `z.encode(...)` so codec-backed members (the `autonomous_resume` block) are written in their persisted form rather than their domain.
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
