/**
 * The shapes `sessionImport.scan` and `sessionImport.run` both speak: one
 * native session the user could bring into Traycer, and the repo folder it
 * was run in.
 *
 * Kept in its own module because the scan describes candidates and the run
 * consumes selections of them - two contracts, one vocabulary, and a drift
 * between them would show up as a wizard that cannot name what it submits.
 */
import { z } from "zod";
import { guiHarnessIdSchema } from "@traycer/protocol/persistence/epic/foundation";

/**
 * Identifies one native session end to end. `(harness, nativeSessionId)` is
 * the import's idempotency key: the chat a session materializes into has a
 * deterministic id derived from this pair, so re-running the wizard over the
 * same session finds the existing chat instead of making a second one.
 */
export const sessionImportSelectionSchema = z.object({
  harness: guiHarnessIdSchema,
  nativeSessionId: z.string().min(1),
});
export type SessionImportSelection = z.infer<
  typeof sessionImportSelectionSchema
>;

/**
 * Closed set of import failure causes, one per seam the import can fail at,
 * shared by the scan and the run.
 *
 * Closed rather than free text so the completion summary can group failures and
 * the wizard can say something specific about each ("2 sessions could not be
 * read"). The free-text half lives beside it in `detail`, which is for the
 * human reading it and is additionally logged host-side under a fixed prefix so
 * a support report carries it even when the wizard was closed.
 *
 * - `source_unreadable`     - the vendor's session file / database could not
 *                             be read at all: gone, unreadable, or corrupt.
 * - `source_empty`          - it read, but yielded no message worth a chat.
 * - `workspace_bind_failed` - the session's `cwd` could not be resolved to a
 *                             workspace (and folderless import also failed).
 * - `creation_failed`       - epic or chat creation / seeding failed.
 * - `internal_error`        - anything else; `detail` carries the message.
 *
 * A discovered session can only ever carry the first, the second, or the last:
 * the other two name work only a run does. That half is not left to this
 * comment - {@link sessionImportUnreadableReasonSchema} enforces it.
 */
export const sessionImportFailureReasonSchema = z.enum([
  "source_unreadable",
  "source_empty",
  "workspace_bind_failed",
  "creation_failed",
  "internal_error",
]);
export type SessionImportFailureReason = z.infer<
  typeof sessionImportFailureReasonSchema
>;

/**
 * The subset of {@link sessionImportFailureReasonSchema} a DISCOVERED session
 * can be refused with.
 *
 * A scan only ever reads: it opens the vendor's session file and either
 * understands it or does not. `workspace_bind_failed` and `creation_failed`
 * name work that only a run performs, so a candidate carrying one is a host
 * bug rather than a state the wizard has a row treatment for. Validating that
 * here is what turns such a bug into a rejected frame instead of a row the
 * wizard renders but cannot explain.
 *
 * Deliberately NOT reused by the scan's `providerFailed` frame: that frame
 * reports a whole provider giving up rather than one session being unreadable,
 * and it classifies its reason from a thrown error, so it keeps the full enum.
 */
export const sessionImportUnreadableReasonSchema = z.enum([
  "source_unreadable",
  "source_empty",
  "internal_error",
]);
export type SessionImportUnreadableReason = z.infer<
  typeof sessionImportUnreadableReasonSchema
>;

/**
 * Why a discovered session cannot be offered as-is.
 *
 * `already_in_traycer` is legacy: current hosts hide an already-imported
 * session from the scan entirely (the native-session index is what enforces
 * import-once, so the wizard's second visit shows only what is new). The
 * variant stays in the schema because an older host still emits it, and a
 * client must be able to parse - and then discard - those rows.
 *
 * `unreadable` carries the same closed reason + free-text `detail` pair the
 * run reports, so a session that fails at discovery and one that fails at
 * import are described in the same vocabulary rather than in two - narrowed to
 * the reasons a read alone can reach.
 */
export const sessionImportCandidateStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("importable") }),
  z.object({
    kind: z.literal("already_in_traycer"),
    epicId: z.string().min(1),
    chatId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("unreadable"),
    reason: sessionImportUnreadableReasonSchema,
    detail: z.string(),
  }),
]);
export type SessionImportCandidateState = z.infer<
  typeof sessionImportCandidateStateSchema
>;

/**
 * One row in the wizard, described from the native session's own metadata.
 *
 * Everything here is cheap to read: the scan deliberately never parses a
 * transcript (that happens once, at import). `messageCount` is therefore
 * nullable - some providers publish it in an index, others would need the
 * full file - and the wizard renders the row without a count rather than
 * paying for one.
 */
export const sessionImportCandidateSchema = z.object({
  harness: guiHarnessIdSchema,
  nativeSessionId: z.string().min(1),
  title: z.string().nullable(),
  firstPrompt: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  messageCount: z.number().int().nonnegative().nullable(),
  hasSubagents: z.boolean(),
  state: sessionImportCandidateStateSchema,
});
export type SessionImportCandidate = z.infer<
  typeof sessionImportCandidateSchema
>;

/**
 * Where a group of sessions was run.
 *
 * `missing_folder` is a first-class location rather than a flag, because the
 * wizard treats it as one: those sessions still import, just without a
 * workspace, and the group carries the warning marker. The path is kept
 * either way - it is the only human-readable name that group has.
 *
 * `workspaceId` is null for a folder Traycer does not know yet; the import
 * decides whether to adopt it as a workspace, so the wizard does not have to
 * expose that mapping.
 */
export const sessionImportGroupLocationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("folder"),
    path: z.string(),
    workspaceId: z.string().nullable(),
  }),
  z.object({ kind: z.literal("missing_folder"), path: z.string() }),
]);
export type SessionImportGroupLocation = z.infer<
  typeof sessionImportGroupLocationSchema
>;

export const sessionImportGroupSchema = z.object({
  location: sessionImportGroupLocationSchema,
  // Whether the folder is a git checkout. Carried so the wizard can rank
  // repos above loose folders - that ordering is the host's knowledge (it
  // resolved the repo root during grouping), not something a path reveals.
  gitBacked: z.boolean(),
  sessions: z.array(sessionImportCandidateSchema),
});
export type SessionImportGroup = z.infer<typeof sessionImportGroupSchema>;
