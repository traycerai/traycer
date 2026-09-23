/**
 * The identity file manifest, as `agentIdentity.state.subscribe` projects it.
 *
 * A DERIVATION of the file plane's manifest entry
 * (`persistence/file-plane/files.ts`), not a second declaration of it. The
 * plane's module is the one schema every container's manifest is read with;
 * this one restates only what the identity wire projection changes, so a field
 * the plane grows reaches identity readers without a copy to keep in step.
 *
 * The derivation is STRUCTURAL: `kind`, `status`, `mediaType` and a producer's
 * `type` stay the plane's open strings - a reader must render a value it does
 * not recognise as a generic file rather than failing the entry - so the JSON
 * Schema this module freezes is the one the original hand-written projection
 * froze, and no stream minor was spent on the re-point. Anyone tightening one of
 * them to an enum breaks that property and turns a refactor into a wire change.
 *
 * Two deliberate differences from the plane's entry:
 *
 * - `recordingId` is absent. It links the three objects of one screen recording
 *   and an identity has no recordings; carrying a field that is `null` on every
 *   entry an identity can hold would invite a consumer to branch on it.
 * - `executable` is carried on the ENTRY, required and defaulted, where the
 *   plane keeps an optional bit per object. Identity files include scripts
 *   under `skills/<name>/scripts/`, and a script that arrives without its mode
 *   is a skill that silently does not run. The host projects the current
 *   object's bit into this one field, so an identity reader never has to spell
 *   the absence case and never sees two spellings of one mode.
 *
 * Leniency is per ENTRY, never per map: a reader parses one key at a time and
 * drops only the key it cannot parse, so one malformed entry renders as a
 * missing file rather than blocking the identity from opening.
 */
import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import {
  FILE_PLANE_MIRROR_EAGER_MAX_BYTES,
  FILE_PLANE_VERSIONS_CAP,
  SHA256_HEX,
  filePlaneEntrySchema,
  filePlaneObjectSchema,
  filePlaneProducerSchema,
  filePlaneStatuses,
} from "@traycer/protocol/persistence/file-plane/files";

/** Lowercase hex sha256 - the only form a content address is written in. */
export const identityFileSha256Schema = lazySchema(() =>
  z.string().regex(SHA256_HEX),
);

/**
 * Per-file byte cap for an identity.
 *
 * The plane's eager-mirror threshold (10 MiB) rather than its 512 MiB per-file
 * cap. The two numbers answer different questions and the identity case wants
 * the smaller one: every identity file is a skill asset that a RUN has to be
 * able to read, so setting the cap at the eager-mirror threshold is what
 * guarantees each one is already on disk on every host at turn start. The
 * larger figure exists for recordings, which an identity does not hold.
 */
export const AGENT_IDENTITY_FILE_MAX_BYTES = FILE_PLANE_MIRROR_EAGER_MAX_BYTES;

/**
 * Who produced an object. The plane's own union: OPEN, with the `agent` arm
 * keeping its typed `chatId`. Narrow with
 * `producer.type === "agent" && "chatId" in producer`.
 */
export const identityFileProducerSchema = filePlaneProducerSchema;
export type IdentityFileProducer = z.infer<typeof identityFileProducerSchema>;

/**
 * One immutable, content-addressed object. The plane's object WITHOUT its
 * optional `executable` bit: the identity projection carries the mode once,
 * required and defaulted, on the ENTRY below, and two spellings of one fact on
 * one wire is how a reader ends up branching on the wrong one.
 */
export const identityFileObjectSchema = lazySchema(() =>
  filePlaneObjectSchema.omit({ executable: true }),
);
export type IdentityFileObject = z.infer<typeof identityFileObjectSchema>;

/**
 * Newest first, and bounded so a `path@sha` link keeps meaning. The plane's
 * cap; the WRITER enforces it and the wire schema deliberately does not
 * re-check the length (a `.max()` would fail the whole ENTRY, `current`
 * included, over a bookkeeping overflow).
 */
export const IDENTITY_FILE_VERSIONS_CAP = FILE_PLANE_VERSIONS_CAP;

/**
 * One manifest entry, keyed in the projection by its identity-root-relative
 * path: the plane's entry minus `recordingId`, plus the identity-only
 * `executable` bit.
 *
 * `versions` is TRIMMED rather than rejected past the cap, exactly as the plane
 * does it: an entry that failed to parse would lose its `current` too.
 */
export const identityFileEntrySchema = lazySchema(() =>
  filePlaneEntrySchema
    .omit({ recordingId: true, current: true, versions: true })
    .extend({
      current: identityFileObjectSchema,
      versions: z
        .array(identityFileObjectSchema)
        .default([])
        .transform((versions) => versions.slice(0, IDENTITY_FILE_VERSIONS_CAP)),
      /**
       * IDENTITY-ONLY on the wire. The plane records the mode per OBJECT
       * (optional, absent on objects written before it existed); the host
       * projects the current object's bit here, so a
       * `skills/<name>/scripts/*` file that was executable where it was
       * written is executable where it lands. Defaulted rather than optional:
       * "not executable" is the answer for every entry a host wrote before the
       * field existed, and it is also the safe one.
       */
      executable: z.boolean().default(false),
    }),
);
export type IdentityFileEntry = z.infer<typeof identityFileEntrySchema>;

/**
 * Known `status` values, restated for writers. The plane's list; OPEN on the
 * wire, where a reader buckets anything else as unknown rather than dropping
 * the entry. `local-only` is the free-tier arm and a normal state.
 */
export const IDENTITY_FILE_STATUSES = filePlaneStatuses;
