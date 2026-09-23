/**
 * The identity file manifest, as `agentIdentity.state.subscribe` projects it.
 *
 * ## TODO(T5): re-point at `persistence/file-plane/files.ts`
 *
 * These shapes are a WIRE PROJECTION of the epic file plane's manifest entry,
 * written out here because the plane's generic module does not exist on `main`
 * yet - it arrives as `protocol/src/persistence/file-plane/files.ts` with the
 * projection-core extraction. When it lands, this module's entry becomes a
 * derivation of the plane's, and the identity-only field below is the only
 * thing that should survive as a local declaration.
 *
 * The replacement must be STRUCTURAL, not a new wire shape, which is what the
 * open-string choices below are protecting: `kind`, `status`, `mediaType` and a
 * producer's `type` are plain strings here for exactly the reason the plane
 * makes them plain strings - a reader must render a value it does not recognise
 * as a generic file rather than failing the entry - so substituting the plane's
 * schema for this one changes no JSON Schema and needs no stream minor. Anyone
 * tightening one of them to an enum breaks that property and turns T5 into a
 * wire change.
 *
 * Two deliberate differences from the plane's entry:
 *
 * - `recordingId` is absent. It links the three objects of one screen recording
 *   and an identity has no recordings; carrying a field that is `null` on every
 *   entry an identity can hold would invite a consumer to branch on it.
 * - `executable` is added. Identity files include scripts under
 *   `skills/<name>/scripts/`, and a script that arrives without its mode is a
 *   skill that silently does not run. The plane's entry has no mode because an
 *   epic drop-zone file never needed one.
 *
 * Leniency is per ENTRY, never per map: a reader parses one key at a time and
 * drops only the key it cannot parse, so one malformed entry renders as a
 * missing file rather than blocking the identity from opening.
 */
import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

/** Lowercase hex sha256 - the only form a content address is written in. */
export const identityFileSha256Schema = lazySchema(() =>
  z.string().regex(/^[0-9a-f]{64}$/),
);

/**
 * Per-file byte cap for an identity.
 *
 * 10 MiB, which is the plane's own `EPIC_FILE_MIRROR_EAGER_MAX_BYTES` rather
 * than its 512 MiB `EPIC_FILE_MAX_BYTES`. The two numbers answer different
 * questions and the identity case wants the smaller one: every identity file is
 * a skill asset that a RUN has to be able to read, so setting the cap at the
 * eager-mirror threshold is what guarantees each one is already on disk on
 * every host at turn start. The 512 MiB figure exists for recordings, which an
 * identity does not hold.
 */
export const AGENT_IDENTITY_FILE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Who produced an object. OPEN, like the plane's: a closed union would make one
 * unrecognised producer written by a newer host fail the whole ENTRY, which
 * contradicts the per-entry leniency this module is built on.
 *
 * `agent` keeps its typed `chatId` - it is the one producer anything branches
 * on - and the generic arm REFUSES the `agent` name, so an agent producer that
 * lost its `chatId` still fails rather than degrading into a generic row that
 * no longer names the chat. Narrow with
 * `producer.type === "agent" && "chatId" in producer`; the `in` check is what
 * excludes the generic arm, whose `type` is an unconstrained string.
 */
export const identityFileProducerSchema = lazySchema(() =>
  z.union([
    z.object({ type: z.literal("agent"), chatId: z.string() }),
    z.object({
      type: z.string().refine((type) => type !== "agent", {
        message: "an agent producer must carry a chatId",
      }),
    }),
  ]),
);
export type IdentityFileProducer = z.infer<typeof identityFileProducerSchema>;

/** One immutable, content-addressed object. Overwriting a path mints a new one. */
export const identityFileObjectSchema = lazySchema(() =>
  z.object({
    sha256: identityFileSha256Schema,
    byteLength: z.number().int().nonnegative(),
    mediaType: z.string(),
    createdAt: z.number(),
    createdBy: z.string(),
    producer: identityFileProducerSchema,
  }),
);
export type IdentityFileObject = z.infer<typeof identityFileObjectSchema>;

/**
 * Newest first, and bounded so a `path@sha` link keeps meaning.
 *
 * The WRITER enforces it. The wire schema below deliberately does NOT re-check
 * the length, for two reasons that point the same way: this is a host-produced
 * frame, so an over-long array is a host bug rather than a peer's input; and a
 * `.max()` here would fail the whole ENTRY over a bookkeeping overflow, taking
 * `current` - the object's actual address - down with it. The plane makes the
 * same call one layer down, where it expresses "trim, never reject" as a
 * reader-side transform; a transform is unrepresentable in JSON Schema and this
 * schema is frozen through `z.toJSONSchema`, so the same intent is stated here
 * as a writer obligation instead.
 */
export const IDENTITY_FILE_VERSIONS_CAP = 10;

/**
 * One manifest entry, keyed in the projection by its identity-root-relative
 * path.
 *
 * `v` is the per-entry schema version: a reader accepts a HIGHER `v` and keeps
 * the fields it understands, which is what lets the plane's own entry replace
 * this one without a negotiation. `current` is the only field an entry cannot
 * be missing, because without it there are no bytes to point at.
 *
 * `versions` is trimmed rather than rejected past the cap. An entry that failed
 * to parse would lose its `current` too, and losing the bytes' address over a
 * bookkeeping overflow is the wrong failure for a lenient reader.
 */
export const identityFileEntrySchema = lazySchema(() =>
  z.object({
    v: z.number(),
    kind: z.string(),
    current: identityFileObjectSchema,
    versions: z.array(identityFileObjectSchema).default([]),
    status: z.string(),
    /** Lineage as `"<path>@<sha>"` refs; a referenced object counts as live. */
    derivedFrom: z.array(z.string()).default([]),
    /** Tombstone timestamp; bytes go, the cloud object stays until the identity does. */
    deletedAt: z.number().nullable().default(null),
    /**
     * IDENTITY-ONLY. Set at ingest from the file mode and re-applied by the
     * mirror after a download, so a `skills/<name>/scripts/*` file that was
     * executable where it was written is executable where it lands.
     *
     * Defaulted rather than optional: "not executable" is the answer for every
     * entry a host wrote before the field existed, and it is also the safe one.
     */
    executable: z.boolean().default(false),
  }),
);
export type IdentityFileEntry = z.infer<typeof identityFileEntrySchema>;

/**
 * Known `status` values, restated for writers. OPEN on the wire: a reader
 * buckets anything else as unknown rather than dropping the entry.
 *
 * `local-only` is the free-tier arm - an upload the write gate refused - and is
 * a normal state, not an error.
 */
export const IDENTITY_FILE_STATUSES = [
  "pending",
  "available",
  "failed",
  "local-only",
] as const;
