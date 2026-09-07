/**
 * The shapes `sessionImport.scan` and `sessionImport.run` both speak: one native session the user could bring into Traycer, and the repo folder it was run in.
 * Kept in its own module because the scan describes candidates and the run consumes selections of them - two contracts, one vocabulary, and a drift between them would show up as a wizard that cannot name what it submits.
 */
import { z } from "zod";
import { guiHarnessIdSchema } from "@traycer/protocol/persistence/epic/foundation";

/** Identifies one native session end to end. */
export const sessionImportSelectionSchema = z.object({
  harness: guiHarnessIdSchema,
  nativeSessionId: z.string().min(1),
});
export type SessionImportSelection = z.infer<
  typeof sessionImportSelectionSchema
>;

/**
 * Closed set of import failure causes, one per seam the import can fail at, shared by the scan and the run.
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
 * The subset of {@link sessionImportFailureReasonSchema} a DISCOVERED session can be refused with.
 * Validating that here is what turns such a bug into a rejected frame instead of a row the wizard renders but cannot explain.
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
 * The variant stays in the schema because an older host still emits it, and a client must be able to parse - and then discard - those rows.
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
 * Everything here is cheap to read: the scan deliberately never parses a transcript (that happens once, at import).
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

/** Where a group of sessions was run. */
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
  // Whether the folder is a git checkout.
  gitBacked: z.boolean(),
  sessions: z.array(sessionImportCandidateSchema),
});
export type SessionImportGroup = z.infer<typeof sessionImportGroupSchema>;
