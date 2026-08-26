/**
 * Typed holder inventory carried on a `WORKTREE_BUSY` error (and on the
 * matching `worktree.deleteByPath` `failed` frame).
 *
 * Degrade story: the prose `message` on the error envelope is unchanged and
 * remains the only field a pre-holders client reads. `holders` is optional;
 * an older host omits it, an older client that still parses `{ code, message }`
 * strips it. New clients parse this schema when they need the confirm-dialog
 * inventory.
 *
 * `ownerKind` matches `worktreeBindingOwnerKindSchema` (`chat` |
 * `terminal-agent`). Kept here — next to the `WORKTREE_BUSY` wire code —
 * so the unary error envelope and the mux payload can name the shape
 * without importing host worktree schemas.
 */
import { z } from "zod";

export const worktreeBusyOwnerKindSchema = z.enum(["chat", "terminal-agent"]);
export type WorktreeBusyOwnerKind = z.infer<typeof worktreeBusyOwnerKindSchema>;

export const worktreeBusyHoldKindSchema = z.enum([
  "chat-turn",
  "terminal-agent-pty",
  "supervised-shell",
  "active-run-cwd",
]);
export type WorktreeBusyHoldKind = z.infer<typeof worktreeBusyHoldKindSchema>;

export const worktreeBusyHolderActivitySchema = z.enum(["working", "idle"]);
export type WorktreeBusyHolderActivity = z.infer<
  typeof worktreeBusyHolderActivitySchema
>;

export const worktreeBusyOwnerRefSchema = z.object({
  epicId: z.string(),
  ownerKind: worktreeBusyOwnerKindSchema,
  ownerId: z.string(),
});
export type WorktreeBusyOwnerRef = z.infer<typeof worktreeBusyOwnerRefSchema>;

export const worktreeBusyHolderSchema = z.object({
  ownerRef: worktreeBusyOwnerRefSchema,
  holdKind: worktreeBusyHoldKindSchema,
  activity: worktreeBusyHolderActivitySchema,
  label: z.string(),
});
export type WorktreeBusyHolder = z.infer<typeof worktreeBusyHolderSchema>;

export const worktreeBusyHoldersSchema = z.array(worktreeBusyHolderSchema);
export type WorktreeBusyHolders = z.infer<typeof worktreeBusyHoldersSchema>;

/**
 * Envelope-seam parse of `holders`. A valid list is typed; anything else
 * (absent, null, malformed) becomes `undefined` so adding this optional
 * field can never reject an envelope that parsed before the minor.
 */
export const worktreeBusyHoldersWireFieldSchema = worktreeBusyHoldersSchema
  .optional()
  .catch(undefined);

/**
 * `WORKTREE_BUSY` envelope a current client parses when it wants the typed
 * inventory. `holders` omitted = old host; the prose `message` still names
 * the refusal.
 */
export const worktreeBusyErrorDetailsSchema = z.object({
  code: z.literal("WORKTREE_BUSY"),
  message: z.string(),
  holders: worktreeBusyHoldersSchema.optional(),
});
export type WorktreeBusyErrorDetails = z.infer<
  typeof worktreeBusyErrorDetailsSchema
>;
