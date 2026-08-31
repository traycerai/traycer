import { z } from "zod";

/**
 * The single literal version of the `draft/v1` head-dialect contract.
 *
 * Deliberately its own module, importing nothing but Zod, so the registered
 * payload schema, the registry entry, and the document codec can all bind to
 * the SAME literal without a dependency cycle — the `chat-sync/version.ts`
 * pattern.
 *
 * `dialect: "draft/v1"` is the tenant-facing name; `schemaVersion` is the
 * self-identifying persistence version a detached head is trusted on. Both
 * are pinned. A payload claiming any other pair is not a v1.0 draft head.
 */
export const DRAFT_HEAD_DIALECT = "draft/v1" as const;

export const DRAFT_HEAD_SCHEMA_VERSION = { major: 1, minor: 0 } as const;

export type DraftHeadSchemaVersion = typeof DRAFT_HEAD_SCHEMA_VERSION;

export const draftHeadSchemaVersionSchema = z.object({
  major: z.literal(DRAFT_HEAD_SCHEMA_VERSION.major),
  minor: z.literal(DRAFT_HEAD_SCHEMA_VERSION.minor),
});

/**
 * Reader acceptance is the SAME pin as the writer. A 1.0 decoder must not
 * admit a 1.1 head: every level is a plain `z.object`, so an any-minor
 * reader would strip unknown fields, seed, and re-publish without them
 * (silent persisted-data loss on the claim path). Fail closed. Residual
 * capture can arrive with a real 1.1; do not build it speculatively.
 */
export const draftHeadReaderVersionSchema = draftHeadSchemaVersionSchema;
