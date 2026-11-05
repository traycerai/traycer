import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import { getRecordSchema } from "@traycer/protocol/framework/versioned-record";
import { commonRecordRegistry } from "@traycer/protocol/common/registry";
import {
  canonicalJsonStringify,
  isJsonValue,
} from "@traycer/protocol/persistence/chat-sync/json";

/**
 * One revision of a markdown artifact's body: an immutable object in the
 * cloud, named by the sha256 of its canonical bytes. The index entry's head
 * names the current one (`head.files[MARKDOWN_REVISION_HEAD_PATH]`, the same
 * shape as an html head with one file), and the cloud moves that head only by
 * compare-and-swap against the revision the new one names as its parent.
 *
 * The hash covers the whole envelope: the rich document, its markdown
 * rendering, the frontmatter scalars and the manifest. So a markdown body and
 * a rich document from different revisions can never be paired, and the
 * revision id is the object's content address (the object's sha256 IS the
 * revision hash; the manifest does not carry its own hash, since nothing can).
 *
 * Every object here is strict and the envelope carries a format number. A
 * reader that met a newer writer's field would otherwise strip it, and since
 * the bytes are the address, anything it re-encoded would be a different
 * revision with the field lost; refusing is the only safe answer.
 */

export const MARKDOWN_REVISION_FORMAT = 1;

/** The one file of a markdown head: the revision envelope. */
export const MARKDOWN_REVISION_HEAD_PATH = "revision.json";
export const MARKDOWN_REVISION_MEDIA_TYPE = "application/json";
/**
 * The cloud chain position of the revision a markdown head names, a leaf on
 * the head's per-file object generation beside `sha256`. Lets a reader of the
 * index tell a newer projection from an older one without asking the cloud.
 */
export const MARKDOWN_REVISION_HEAD_SEQ_FIELD = "seq";

export const markdownRevisionHashSchema = lazySchema(() =>
  z
    .string()
    .regex(/^[0-9a-f]{64}$/u, "Expected a lowercase hex sha256 revision hash"),
);

/** Who wrote the revision. A merge is attributed to the host's merging actor. */
export const markdownRevisionAuthorSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("person"), userId: z.string().min(1) }).strict(),
    z.object({ kind: z.literal("agent"), chatId: z.string().min(1) }).strict(),
    z.object({ kind: z.literal("system") }).strict(),
  ]),
);
export type MarkdownRevisionAuthor = z.infer<
  typeof markdownRevisionAuthorSchema
>;

/**
 * A merge revision's audit: the base its three-way merge diffed from, and the
 * revisions whose overlapping hunks it dropped. A set (sorted, no duplicates),
 * not one revision: an ingest and a refused republish can both supersede
 * before one publish lands. Empty when the merge combined without dropping
 * anything.
 */
export const markdownRevisionMergeSchema = lazySchema(() =>
  z
    .object({
      base: markdownRevisionHashSchema,
      superseded: z
        .array(markdownRevisionHashSchema)
        .refine(
          (hashes) =>
            hashes.every(
              (hash, index) => index === 0 || hashes[index - 1] < hash,
            ),
          "superseded revisions must be sorted and distinct",
        ),
    })
    .strict(),
);
export type MarkdownRevisionMerge = z.infer<typeof markdownRevisionMergeSchema>;

export const markdownRevisionManifestSchema = lazySchema(() =>
  z
    .object({
      artifactId: z.string().min(1),
      /** The head this revision replaces; `null` only for an artifact's first. */
      parent: markdownRevisionHashSchema.nullable(),
      merge: markdownRevisionMergeSchema.nullable(),
      author: markdownRevisionAuthorSchema,
      hostId: z.string().min(1),
      /** The editor session that produced it; `null` for a write with no editor. */
      editorSessionId: z.string().min(1).nullable(),
      createdAt: z.number().int().nonnegative(),
      /**
       * An intermediate revision of one editor session. Expiry may later drop
       * its object (never its manifest) when its parent and child are both
       * transient revisions of the same session. Merges and agent writes are
       * never transient.
       */
      transient: z.boolean(),
    })
    .strict()
    .superRefine((manifest, ctx) => {
      if (manifest.merge !== null && manifest.parent === null) {
        ctx.addIssue({
          code: "custom",
          message: "a merge revision has a parent",
          path: ["merge"],
        });
      }
      if (!manifest.transient) return;
      if (manifest.merge !== null) {
        ctx.addIssue({
          code: "custom",
          message: "a merge revision is never transient",
          path: ["transient"],
        });
      }
      if (manifest.author.kind !== "person") {
        ctx.addIssue({
          code: "custom",
          message: "only a person's editor revision is transient",
          path: ["transient"],
        });
      }
      if (manifest.editorSessionId === null) {
        ctx.addIssue({
          code: "custom",
          message: "a transient revision names its editor session",
          path: ["editorSessionId"],
        });
      }
    }),
);
export type MarkdownRevisionManifest = z.infer<
  typeof markdownRevisionManifestSchema
>;

const ticketStatusSchema = getRecordSchema(
  commonRecordRegistry,
  "ticket-status",
  "latest",
);

/**
 * The frontmatter fields the index entry carries, so lists and tiles read a
 * revision without parsing its body.
 */
export const markdownRevisionScalarsSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.enum(["spec", "review"]),
        title: z.string(),
      })
      .strict(),
    z
      .object({
        kind: z.enum(["ticket", "story"]),
        title: z.string(),
        assignee: z.string(),
        status: ticketStatusSchema,
      })
      .strict(),
  ]),
);
export type MarkdownRevisionScalars = z.infer<
  typeof markdownRevisionScalarsSchema
>;

const jsonContentSchema = getRecordSchema(
  commonRecordRegistry,
  "json-content",
  "latest",
);

export const markdownRevisionEnvelopeSchema = lazySchema(() =>
  z
    .object({
      format: z.literal(MARKDOWN_REVISION_FORMAT),
      /**
       * ProseMirror JSON in the artifact document schema, anchor marks
       * included: the seed for an editor doc and the unit of a three-way
       * merge. A markdown-only object would drop the thread anchors.
       */
      document: jsonContentSchema.refine(
        (document) => document.type === "doc",
        "the document is a doc node",
      ),
      /** `document` rendered as the artifact's markdown body, byte for byte. */
      markdown: z.string(),
      scalars: markdownRevisionScalarsSchema,
      manifest: markdownRevisionManifestSchema,
    })
    .strict(),
);
export type MarkdownRevisionEnvelope = z.infer<
  typeof markdownRevisionEnvelopeSchema
>;

export class InvalidMarkdownRevisionError extends Error {
  constructor(reason: string) {
    super(`Invalid markdown revision: ${reason}`);
    this.name = "InvalidMarkdownRevisionError";
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * The envelope's canonical bytes: keys sorted at every depth, no whitespace,
 * UTF-8. The same envelope always encodes to the same bytes, which is what
 * makes its sha256 a stable revision id.
 */
export function encodeMarkdownRevision(
  envelope: MarkdownRevisionEnvelope,
): Uint8Array {
  const parsed = markdownRevisionEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) {
    throw new InvalidMarkdownRevisionError(parsed.error.message);
  }
  // The parsed value, not the argument: what is encoded is exactly what a
  // reader's parse of these bytes yields, so decode(encode(x)) always holds.
  if (!isJsonValue(parsed.data)) {
    throw new InvalidMarkdownRevisionError("not a JSON value");
  }
  return encoder.encode(canonicalJsonStringify(parsed.data));
}

/**
 * Parses stored bytes back into an envelope. Refuses bytes that are not the
 * canonical encoding of what they parse to: such bytes would hash to a
 * different id than the envelope they carry, so the id would not name it.
 */
export function decodeMarkdownRevision(
  bytes: Uint8Array,
): MarkdownRevisionEnvelope {
  let raw: unknown;
  try {
    raw = JSON.parse(decoder.decode(bytes));
  } catch {
    throw new InvalidMarkdownRevisionError("not UTF-8 JSON");
  }
  const parsed = markdownRevisionEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InvalidMarkdownRevisionError(parsed.error.message);
  }
  const canonical = encodeMarkdownRevision(parsed.data);
  if (
    canonical.byteLength !== bytes.byteLength ||
    canonical.some((byte, index) => byte !== bytes[index])
  ) {
    throw new InvalidMarkdownRevisionError("not canonically encoded");
  }
  return parsed.data;
}

/** The revision id: lowercase hex sha256 of the envelope's canonical bytes. */
export async function markdownRevisionHash(bytes: Uint8Array): Promise<string> {
  // Copied into an ArrayBuffer-backed buffer: WebCrypto takes a BufferSource,
  // which a Uint8Array over a possibly shared buffer is not.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", copy),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
