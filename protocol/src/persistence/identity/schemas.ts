import { z } from "zod";
import { guiHarnessIdSchema } from "@traycer/protocol/persistence/epic/foundation";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

/**
 * Public sub-schemas of the agent-identity index doc.
 *
 * An identity's root Tiptap room holds ONE Y.Doc with three top-level types:
 *
 * | type        | shape                                          | written by |
 * | ----------- | ---------------------------------------------- | ---------- |
 * | `meta`      | the existing `room-metadata` record             | host       |
 * | `identity`  | a Y.Map matching {@link identityRecordSchema}   | host       |
 * | `documents` | a Y.Map of {@link identityDocumentEntrySchema}  | host       |
 * | `files`     | the file plane's manifest map                   | host       |
 *
 * Two of those are registered records and live here. `meta` reuses
 * `room-metadata` unchanged, and `files` is the file plane's own manifest -
 * neither is redefined in this module.
 *
 * ## Both maps are HOST-ONLY
 *
 * The GUI edits fragment BODIES directly over `agentIdentity.file.subscribe`,
 * but asks the host to add, rename or delete a path. That is what makes the
 * projection layer the single writer of file metadata, and it is why these two
 * shapes carry no client-authored fields: every value here is something the
 * host committed, not something a renderer proposed.
 *
 * ## Leniency is per ENTRY, never per map
 *
 * `documents` is a Y.Map any host of the account may write, so a reader parses
 * one key at a time and drops only the key it cannot parse. One malformed entry
 * must never stop an identity from opening. The fields a writer may
 * legitimately omit therefore carry defaults; the fields an entry is
 * meaningless without (`shardRoomId`, `fragmentName`) do not.
 */

/**
 * Which review agent the every-N-turns evolution pass runs as.
 *
 * All three selectors are NULLABLE and null means "same as the chat that
 * triggered the pass" - the product's default, and the reason none of them has
 * a sentinel string. A harness id that is present but unknown to the reading
 * host is a different failure and is handled by the enum below.
 *
 * `reviewHarnessId` binds the LIVE persisted harness enum
 * (`guiHarnessIdSchema`), not an open string, on the epic record's reasoning
 * rather than chat-sync's: this doc is written by a host and read by hosts, the
 * same population the epic Y.Doc has, and `chatRunSettingsSchema.harnessId`
 * beside it is closed for exactly that reason. The GUI never parses this map -
 * it reads the projection `agentIdentity.state.subscribe` serves, where the
 * host can gate emission on the negotiated minor. If identity docs ever grow a
 * reader on an independent release cadence, the remedy is the one
 * `COMPATIBILITY.md` §5 records for chat-sync: reopen the leaf to a checked
 * string in THAT reader's copy, never widen the persisted enum silently.
 */
export const identityEvolutionSettingsSchema = lazySchema(() =>
  z.object({
    /**
     * Clean completed turns between passes. `0` disables evolution for this
     * identity, which is why the counter's fire condition is stated as "reaches
     * the interval AND the interval is greater than zero" rather than as a
     * nullable field: "off" and "every zero turns" are the same intent, and one
     * representation of it is better than two.
     */
    intervalTurns: z.number().int().nonnegative().default(0),
    reviewHarnessId: guiHarnessIdSchema.nullable().default(null),
    /** Concrete model slug, as `chatRunSettingsSchema.model` is. */
    reviewModel: z.string().min(1).nullable().default(null),
    reviewReasoningEffort: z.string().nullable().default(null),
  }),
);
export type IdentityEvolutionSettings = z.infer<
  typeof identityEvolutionSettingsSchema
>;

/**
 * The `identity` map: an identity's own settings, as one record.
 *
 * `schemaVersion` is the IN-BAND stamp, and it is not a duplicate of the
 * registered record version. The registry version is the contract line a reader
 * negotiates; this is what a doc carries with it, so a reader that finds an
 * identity room detached from the cloud row that named it can still say which
 * shape it is looking at. `room-metadata` carries the same field for the same
 * reason.
 *
 * Defaulted rather than required, on the map's per-entry leniency rule: an
 * identity room written before a stamp existed still opens, and the value a
 * reader then assumes is this contract's own.
 */
export const IDENTITY_RECORD_SCHEMA_VERSION = 1;

export const identityRecordSchema = lazySchema(() =>
  z.object({
    title: z.string(),
    /**
     * Free text for the list row. Nullable AND defaulted: "never described" is
     * the ordinary state of a freshly created identity, and an empty string
     * would make "described as nothing" indistinguishable from it.
     */
    description: z.string().nullable().default(null),
    evolution: identityEvolutionSettingsSchema,
    schemaVersion: z
      .number()
      .int()
      .positive()
      .default(IDENTITY_RECORD_SCHEMA_VERSION),
  }),
);
export type IdentityRecord = z.infer<typeof identityRecordSchema>;

/**
 * Why a markdown file in an identity last changed.
 *
 * The ten artifact-history kinds plus `evolution`, which names a write made by
 * an identity's own evolution chat. The list is restated here rather than
 * imported because `host/epic/artifact-versions.ts` is an RPC module and
 * persistence must not depend on the host surface; `identity-provenance-parity`
 * fails if the two ever disagree about the shared ten, so the copy cannot
 * drift silently.
 *
 * CLOSED, deliberately. The history view renders one affordance per kind, so a
 * kind a reader cannot spell is a row it cannot explain - and unlike a harness
 * id, this vocabulary is Traycer's own and grows only when Traycer adds a way
 * to write a file.
 */
export const identityDocumentProvenanceKindSchema = lazySchema(() =>
  z.enum([
    "agent",
    "user_session",
    "multiple_agents",
    "external",
    "system",
    "remote_merge",
    "restore",
    "revive",
    "delete",
    "clobber",
    "evolution",
  ]),
);
export type IdentityDocumentProvenanceKind = z.infer<
  typeof identityDocumentProvenanceKindSchema
>;

/**
 * One entry of the `documents` map, keyed by the file's identity-root-relative
 * path.
 *
 * Only MARKDOWN files are in this map. Everything else is a blob and lives in
 * the file plane's manifest instead; `identityBodyKindForPath` is what decides
 * which map a path belongs to, and an entry appearing in both would be two
 * claims about one path.
 *
 * `fragmentName` is carried rather than derived from the key. The derivation is
 * `identity-file:<path>` today, but a renamed file is a NEW entry plus a
 * fragment copy, and a host mid-rename legitimately holds an entry whose
 * fragment still carries the old name. A reader that recomputed the name would
 * open the wrong fragment during exactly that window.
 */
export const identityDocumentEntrySchema = lazySchema(() =>
  z.object({
    /** The shard room holding this file's `Y.XmlFragment`. */
    shardRoomId: z.string().min(1),
    /** The fragment's name inside that room. See the note above. */
    fragmentName: z.string().min(1),
    /**
     * Wall-clock ms of the last committed write. DISPLAY metadata: no ordering
     * decision may read it, for the reason `epicLaneRowRevisionSchema` states
     * at length - a clock is not a revision.
     */
    updatedAt: z.number(),
    provenance: identityDocumentProvenanceKindSchema,
  }),
);
export type IdentityDocumentEntry = z.infer<typeof identityDocumentEntrySchema>;
