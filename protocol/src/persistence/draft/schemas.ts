import { z } from "zod";
import { commonRecordRegistry } from "@traycer/protocol/common/registry";
import { getRecordSchema } from "@traycer/protocol/framework/index";
import { chatRunSettingsStrictSchema } from "@traycer/protocol/persistence/epic/foundation";
import { sha256HexSchema } from "@traycer/protocol/persistence/chat-sync/version";
import {
  DRAFT_HEAD_DIALECT,
  draftHeadSchemaVersionSchema,
} from "@traycer/protocol/persistence/draft/version";

const jsonContentSchema = getRecordSchema(
  commonRecordRegistry,
  "json-content",
  "latest",
);

/**
 * Target linkage is DATA inside the head, never the shard key. Personal
 * `drafts` scope holds every kind; epic/chat/block identity rides here so a
 * composer draft is not stored under its epic (collaborators would see
 * unsent text). Null means "this kind has no such target".
 */
export const draftTargetSchema = z.object({
  epicId: z.string().min(1).nullable(),
  chatId: z.string().min(1).nullable(),
  blockId: z.string().min(1).nullable(),
});
export type DraftTarget = z.infer<typeof draftTargetSchema>;

export const draftSelectionSchema = z.object({
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
});
export type DraftSelection = z.infer<typeof draftSelectionSchema>;

export const draftComposerModeSchema = z.enum(["chat", "terminal"]);
export type DraftComposerMode = z.infer<typeof draftComposerModeSchema>;

/**
 * Portable composer payload: ProseMirror JSON, caret, run settings, the
 * landing chat-vs-terminal switch, and tab-strip membership (`closed`).
 * Images are referenced by sha256 (`blobHashes`); bytes live in the
 * existing content-addressed blob store, never inline in this document.
 *
 * `closed` is landing-meaningful: a start-task draft put away from the
 * tab strip stays in the store (and on the host) until an explicit
 * delete. New-chat and chat-composer writers always send `false` — those
 * surfaces keep today's buffer lifecycle. Default `false` is the open
 * state so a 1.0 head written before this field still decodes as open
 * (the drafts minor is unreleased; this is an in-place dialect edit,
 * not a SQLite column / schema_version bump).
 *
 * Run settings are the STRICT tuple: every key required, explicit nulls.
 * There are no legacy draft rows to accommodate, so `.default(null)` would
 * only hide an omitting writer as a null-clobber.
 */
export const draftComposerPortableSchema = z.object({
  content: jsonContentSchema,
  selection: draftSelectionSchema.nullable(),
  runSettings: chatRunSettingsStrictSchema.nullable(),
  composerMode: draftComposerModeSchema,
  blobHashes: z.array(sha256HexSchema),
  closed: z.boolean().default(false),
});
export type DraftComposerPortable = z.infer<typeof draftComposerPortableSchema>;

/**
 * The same payload where a WRITER supplies it. The default above is a
 * reader-side courtesy to a 1.0 head written before the field existed; on
 * the write path it would silently turn an omitting client into a claim
 * that the draft is open, and because the host applies an upsert as a
 * whole-document LWW that write replaces a retained `closed: true` row.
 * Every write branch names the state explicitly.
 */
export const draftComposerPortableWriteSchema =
  draftComposerPortableSchema.extend({
    closed: z.boolean(),
  });
export type DraftComposerPortableWrite = z.infer<
  typeof draftComposerPortableWriteSchema
>;

/**
 * One interview answer as the draft carries it across devices.
 *
 * `selected` is the LABEL snapshot and is not enough on its own: labels
 * repeat, so a round-trip that keeps only labels turns an exact selection
 * into a legacy label-only row whose later settlement must be neutral
 * (`StoredInterviewDraftAnswer` documents that degradation). `questionIdentity`
 * and `selectedOptionIndices` carry the interaction-time evidence instead.
 *
 * Both are OPTIONAL because the label-only row is a REAL shape - an answer
 * drafted before indices existed - and requiring them here would force a
 * writer to manufacture evidence its row never held. The drafts minor is
 * unreleased and still pinned at {1,0}, so this is an in-place dialect edit,
 * not a new minor.
 */
export const draftInterviewAnswerSchema = z.object({
  questionIdentity: z.string().min(1).optional(),
  selected: z.array(z.string()),
  selectedOptionIndices: z.array(z.number().int().nonnegative()).optional(),
  otherText: z.string(),
  otherSelected: z.boolean(),
});
export type DraftInterviewAnswer = z.infer<typeof draftInterviewAnswerSchema>;

export const draftInterviewPortableSchema = z.object({
  pageIndex: z.number().int().nonnegative(),
  answers: z.array(draftInterviewAnswerSchema),
});
export type DraftInterviewPortable = z.infer<
  typeof draftInterviewPortableSchema
>;

/**
 * Stash entries are immutable by construction (save / restore-consume /
 * delete). `createdAt` is the capture time; `blobHashes` are the same
 * sha256 identity the local stash repository already uses.
 */
export const draftStashPortableSchema = z.object({
  content: jsonContentSchema,
  blobHashes: z.array(sha256HexSchema),
  createdAt: z.number().int().nonnegative(),
});
export type DraftStashPortable = z.infer<typeof draftStashPortableSchema>;

/**
 * One folder in a host-tagged workspace snapshot. `hostId` is the host
 * that prepared the path; a claim by a different host drops/re-resolves
 * the snapshot rather than trusting foreign paths. Null only for a
 * legacy row that predates host stamping.
 */
export const draftWorkspaceFolderInfoSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1),
  repoIdentifier: z
    .object({
      owner: z.string().min(1),
      repo: z.string().min(1),
    })
    .nullable(),
  hostId: z.string().min(1).nullable(),
});
export type DraftWorkspaceFolderInfo = z.infer<
  typeof draftWorkspaceFolderInfoSchema
>;

export const draftWorkspaceSnapshotSchema = z.object({
  folders: z.array(z.string().min(1)),
  folderInfoByPath: z.record(z.string(), draftWorkspaceFolderInfoSchema),
  primaryPath: z.string().min(1).nullable(),
});
export type DraftWorkspaceSnapshot = z.infer<
  typeof draftWorkspaceSnapshotSchema
>;

/**
 * Host-local state. Meaningful on the owning host only. `workspace` is
 * the host-tagged snapshot (decision log #11); a foreign claim must not
 * project it as universal.
 */
export const draftHostLocalSchema = z.object({
  hostId: z.string().min(1),
  workspace: draftWorkspaceSnapshotSchema.nullable(),
});
export type DraftHostLocal = z.infer<typeof draftHostLocalSchema>;

/**
 * Dialect `kind` answers "which head codec is this", not "which screen
 * opened it". The five UI surfaces collapse to these three: landing /
 * new-chat / chat-composer are all `draft` and keep their screen identity
 * in `surfaceKind`.
 */
export const draftDialectKindSchema = z.enum([
  "draft",
  "stash-entry",
  "interview",
]);
export type DraftDialectKind = z.infer<typeof draftDialectKindSchema>;

export const draftSurfaceKindSchema = z.enum([
  "landing",
  "new-chat",
  "chat-composer",
]);
export type DraftSurfaceKind = z.infer<typeof draftSurfaceKindSchema>;

const draftHeadCommonFields = {
  dialect: z.literal(DRAFT_HEAD_DIALECT),
  lastTouchedAt: z.number().int().nonnegative(),
  target: draftTargetSchema,
  hostLocal: draftHostLocalSchema,
} as const;

/**
 * Writer-side payload: pinned `schemaVersion`, no `parts` key (that key is
 * reserved for the tenant envelope the document codec derives).
 */
export const draftHeadSchema = z.discriminatedUnion("kind", [
  z.object({
    ...draftHeadCommonFields,
    schemaVersion: draftHeadSchemaVersionSchema,
    kind: z.literal("draft"),
    surfaceKind: draftSurfaceKindSchema,
    portable: draftComposerPortableSchema,
  }),
  z.object({
    ...draftHeadCommonFields,
    schemaVersion: draftHeadSchemaVersionSchema,
    kind: z.literal("interview"),
    portable: draftInterviewPortableSchema,
  }),
  z.object({
    ...draftHeadCommonFields,
    schemaVersion: draftHeadSchemaVersionSchema,
    kind: z.literal("stash-entry"),
    portable: draftStashPortableSchema,
  }),
]);
export type DraftHeadRecord = z.infer<typeof draftHeadSchema>;

/**
 * Reader-side payload: identical to the writer. A newer minor is refused
 * at parse (`schema-rejected`), never lossily stripped.
 */
export const draftHeadReaderSchema = draftHeadSchema;
export type DraftHeadReaderRecord = DraftHeadRecord;
