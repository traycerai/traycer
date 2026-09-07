/**
 * Shared wire shapes for the managed-command surface - the human half of the subsystem whose agent half is the `traycer_*_shell` tool set.
 */
import { z } from "zod";

/** The command's lifecycle, mirroring the supervisor's own status union. */
export const managedCommandStatusSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("running"),
    pid: z.number().int(),
    startedAtMs: z.number(),
  }),
  z.object({ state: z.literal("stopped"), stoppedAtMs: z.number() }),
  z.object({
    state: z.literal("exited"),
    // Both null when the process was lost without either being observable.
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    exitedAtMs: z.number(),
  }),
  // The host process died while this command was running; the child was reaped
  // on the next boot.
  z.object({ state: z.literal("interrupted"), interruptedAtMs: z.number() }),
]);
export type ManagedCommandStatus = z.infer<typeof managedCommandStatusSchema>;

export const managedCommandCadenceSchema = z.object({
  /** Quiet gap that completes a batch of output. */
  debounceMs: z.number().int(),
  /** Ceiling before output that never pauses is delivered anyway. */
  maxWaitMs: z.number().int(),
  /** Floor between consecutive deliveries from this one shell. */
  throttleMs: z.number().int(),
});
export type ManagedCommandCadence = z.infer<typeof managedCommandCadenceSchema>;

export const managedCommandSchema = z.object({
  id: z.string(),
  /** Output is delivered to the owning agent as it prints, not only at death. */
  monitoring: z.boolean(),
  /** The command's human label, shown as the row title. */
  description: z.string(),
  /**
   * The command line as the agent wrote it, verbatim.
   * Null - never `""` - when the host is too old to send it, so a surface can say "this host does not report it" instead of rendering an empty command line as fact.
   */
  command: z.string().nullable().default(null),
  /** Absolute working directory the command runs in; null on an old host. */
  cwd: z.string().nullable().default(null),
  /** How digests are paced; null unless `monitoring`. */
  cadence: managedCommandCadenceSchema.nullable().default(null),
  status: managedCommandStatusSchema,
  /** Whether a host restart brings this command back. */
  relaunchOnHostRestart: z.boolean().default(true),
  /** The chat that created the command - the row's backlink. */
  chatId: z.string(),
  createdAtMs: z.number(),
  /** Last lifecycle or spec change; the list's "most recent activity" order. */
  updatedAtMs: z.number(),
});
export type ManagedCommand = z.infer<typeof managedCommandSchema>;

/**
 * `managedCommand.start@1.0` - The command shape as it SHIPPED (cli-v1.2.0): everything above except `relaunchOnHostRestart`.
 */
export const managedCommandSchemaPreRelaunch = z.object({
  id: z.string(),
  monitoring: z.boolean(),
  description: z.string(),
  command: z.string().nullable().default(null),
  cwd: z.string().nullable().default(null),
  cadence: managedCommandCadenceSchema.nullable().default(null),
  status: managedCommandStatusSchema,
  chatId: z.string(),
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
});
export type ManagedCommandPreRelaunch = z.infer<
  typeof managedCommandSchemaPreRelaunch
>;

/** The live command as a peer on a pre-relaunch line receives it. */
export function managedCommandWithoutRelaunchFlag(
  command: ManagedCommand,
): ManagedCommandPreRelaunch {
  const { relaunchOnHostRestart: _relaunchOnHostRestart, ...rest } = command;
  return rest;
}

/**
 * Every id-addressed control names its epic.
 * Scoping is not advisory: a command in another epic is answered exactly as an id that never existed, so the surface cannot be used to probe for commands the caller may not see.
 */
export const managedCommandControlRequestSchema = z.object({
  epicId: z.string(),
  commandId: z.string(),
});
export type ManagedCommandControlRequest = z.infer<
  typeof managedCommandControlRequestSchema
>;

/** Start and stop answer with the command's post-transition state. */
export const managedCommandControlResponseSchema = z.object({
  command: managedCommandSchema,
});
export type ManagedCommandControlResponse = z.infer<
  typeof managedCommandControlResponseSchema
>;

/** The `@1.0` response: the shipped command shape, without the relaunch flag. */
export const managedCommandControlResponseSchemaV10 = z.object({
  command: managedCommandSchemaPreRelaunch,
});
export type ManagedCommandControlResponseV10 = z.infer<
  typeof managedCommandControlResponseSchemaV10
>;

export const managedCommandDeleteRequestSchema =
  managedCommandControlRequestSchema;
export type ManagedCommandDeleteRequest = ManagedCommandControlRequest;

/** The one setting a human edits on a command: whether it comes back after a host restart. */
export const managedCommandConfigureRequestSchema = z.object({
  epicId: z.string(),
  commandId: z.string(),
  relaunchOnHostRestart: z.boolean(),
});
export type ManagedCommandConfigureRequest = z.infer<
  typeof managedCommandConfigureRequestSchema
>;

/** Delete has no post-state to report: the row, the process and the entire output history are gone. */
export const managedCommandDeleteResponseSchema = z.object({
  commandId: z.string(),
});
export type ManagedCommandDeleteResponse = z.infer<
  typeof managedCommandDeleteResponseSchema
>;

/**
 * One shell whose last batch of output a committed Stop fence captured and is holding back.
 * `chat.subscribe` freezes its released minors against hand-written pre-images; when the next one freezes, this object must be inlined into that pre-image rather than referenced, or the freeze tracks this definition and.
 */
export const heldManagedCommandUpdateSchema = z.object({
  commandId: z.string(),
  /** The command's human label, so the row reads without a join. */
  description: z.string(),
  /** When the Stop commit installed the hold. */
  heldAtMs: z.number(),
});
export type HeldManagedCommandUpdate = z.infer<
  typeof heldManagedCommandUpdateSchema
>;

/**
 * Deliver is chat-scoped, not command-scoped, because a hold is: the Stop that installed it fenced a CHAT, and "deliver everything you are holding for me" is the action a human actually takes.
 * `epicId` is named for the same reason the id-addressed controls name it - a chat in another epic is answered exactly as one that never existed.
 */
export const managedCommandDeliverHeldRequestSchema = z.object({
  epicId: z.string(),
  chatId: z.string(),
  /** The holds to deliver; null means every hold this chat owns. */
  commandIds: z.array(z.string()).min(1).nullable(),
});
export type ManagedCommandDeliverHeldRequest = z.infer<
  typeof managedCommandDeliverHeldRequestSchema
>;

/**
 * One hold the host could not prove it released.
 * Clients must not branch on it; it is for humans reading a report.
 */
export const managedCommandHeldReleaseFailureSchema = z.object({
  /**
   * The command this entry is about.
   * Always present: a failure the host cannot attribute to one command is reported in `unattributed` instead, so that `unresolved.length` is always a count of SHELLS and can be rendered as one.
   */
  commandId: z.string(),
  /** Stable identifier for logs and telemetry. Never branch on this. */
  code: z.string(),
  /** Whether retrying against THIS host process could ever succeed. */
  retryable: z.boolean(),
  /** Host-authored detail. */
  message: z.string(),
});
export type ManagedCommandHeldReleaseFailure = z.infer<
  typeof managedCommandHeldReleaseFailureSchema
>;

/**
 * A failure that belongs to the CALL, not to any one command.
 * Never render an empty `held` as "nothing is held" without checking this field first.
 */
export const managedCommandHeldReleaseUnattributedSchema = z.object({
  /** Stable identifier for logs and telemetry. Never branch on this. */
  code: z.string(),
  /** Whether retrying against THIS host process could ever succeed. */
  retryable: z.boolean(),
  /** Host-authored detail. Show it verbatim; see the per-command note. */
  message: z.string(),
});
export type ManagedCommandHeldReleaseUnattributed = z.infer<
  typeof managedCommandHeldReleaseUnattributedSchema
>;

/** Deliver answers with what actually happened, per command, and RESOLVES even when part of it failed. */
export const managedCommandDeliverHeldResponseSchema = z.object({
  /** Command ids whose hold this call proved gone. */
  released: z.array(z.string()),
  /**
   * In-scope commands whose release could not be proven, one entry per command.
   * `unresolved.length` is a SHELL COUNT and safe to render as one.
   */
  unresolved: z.array(managedCommandHeldReleaseFailureSchema),
  /** Failures belonging to the call rather than to any command. */
  unattributed: z.array(managedCommandHeldReleaseUnattributedSchema),
  /**
   * The holds the chat still owns once this call settled, as far as the host can SEE them - not a proof of completeness, and the difference matters.
   * An empty `held` alongside a non-empty `unresolved` never means "nothing is held".
   */
  held: z.array(heldManagedCommandUpdateSchema),
});
export type ManagedCommandDeliverHeldResponse = z.infer<
  typeof managedCommandDeliverHeldResponseSchema
>;
