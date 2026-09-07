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
  /**
   * Stable identity of this holder for the lifetime of the actor. Opaque
   * to clients; unique within a host. Optional so a pre-holderId host's
   * inventory still parses; a current host always emits it.
   */
  holderId: z.string().optional(),
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
 * Host-computed SHA-256 hex digest of a holder inventory. Shared by
 * consent (`expectedHoldersRevision`), listHolders, and failure-frame
 * wire fields so a value that parses on read can be echoed as consent.
 */
export const HOLDERS_REVISION_DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

/**
 * Host-computed digest of the actor-grouped inventory. Optional so a
 * pre-revision host still parses; a current host always emits it next
 * to `holders`. Non-digest and malformed values sanitize to absent
 * rather than rejecting the envelope — leniency on the failure path,
 * never a string that would fail consent echo.
 */
export const holdersRevisionWireFieldSchema = z
  .string()
  .regex(HOLDERS_REVISION_DIGEST_PATTERN)
  .optional()
  .catch(undefined);

/**
 * `WORKTREE_BUSY` envelope a current client parses when it wants the typed
 * inventory. `holders` omitted = old host; the prose `message` still names
 * the refusal. `holdersRevision` is the digest of that inventory — a
 * non-digest sanitizes to absent so a GUI that echoes it as
 * `expectedHoldersRevision` cannot be handed a value the request schema
 * rejects.
 */
export const worktreeBusyErrorDetailsSchema = z.object({
  code: z.literal("WORKTREE_BUSY"),
  message: z.string(),
  holders: worktreeBusyHoldersSchema.optional(),
  holdersRevision: holdersRevisionWireFieldSchema,
});
export type WorktreeBusyErrorDetails = z.infer<
  typeof worktreeBusyErrorDetailsSchema
>;

/**
 * Released unary failure envelope retained for wire compatibility. Hosts no
 * longer emit `WORKTREE_HOLDERS_CHANGED` or its `holdersRevision` because
 * consent now covers whichever owners are active when deletion runs. Remove
 * these fields only after the protocol minor-removal window permits it. The
 * digest still sanitizes to absent so a malformed legacy envelope cannot make
 * the whole error fail parsing.
 */
export const worktreeHoldersChangedErrorDetailsSchema = z.object({
  code: z.literal("WORKTREE_HOLDERS_CHANGED"),
  message: z.string(),
  holders: worktreeBusyHoldersSchema.optional(),
  holdersRevision: holdersRevisionWireFieldSchema,
});
export type WorktreeHoldersChangedErrorDetails = z.infer<
  typeof worktreeHoldersChangedErrorDetailsSchema
>;
