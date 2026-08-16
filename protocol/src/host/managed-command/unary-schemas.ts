/**
 * Shared wire shapes for the managed-command surface - the human half of the
 * subsystem whose agent half is the `traycer_*_shell` tool set. A managed
 * command is a supervised shell command owned by the host. There is ONE entity
 * and no kinds: a shell either notifies its owning agent as it prints
 * (`monitoring`) or only when it dies, and that flag is live-tunable, so it is
 * state to render rather than a second sort of thing.
 *
 * These schemas are shared by the unary lifecycle contracts in `./contracts.ts`
 * and the two streams in `./subscribe.ts`, the same way `terminalSessionInfo`
 * is shared across the terminal surface.
 */
import { z } from "zod";

/**
 * The command's lifecycle, mirroring the supervisor's own status union. There
 * is no `desiredState` here for the same reason there is none in the host: a
 * process that dies on its own is `exited`, and restarting is an explicit act.
 *
 * The supervisor's orphan-verification fingerprint (`pidStartTimeMs`) is
 * deliberately NOT carried - it exists to prove a pid still belongs to the same
 * process across a host restart, which is nothing a viewer can act on.
 */
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

/**
 * The cadence a monitoring shell's digests are paced at - the agent's own
 * `debounceMs`/`maxWaitMs`/`throttleMs`, echoed back so a human can read why a
 * watcher is quiet. Null on a shell that is not monitoring, where the timings
 * govern nothing and reporting them would describe a policy with no effect.
 */
export const managedCommandCadenceSchema = z.object({
  /** Quiet gap that completes a batch of output. */
  debounceMs: z.number().int(),
  /** Ceiling before output that never pauses is delivered anyway. */
  maxWaitMs: z.number().int(),
  /** Floor between consecutive deliveries from this one shell. */
  throttleMs: z.number().int(),
});
export type ManagedCommandCadence = z.infer<typeof managedCommandCadenceSchema>;

/**
 * One managed command as a human surface sees it: enough to render a row
 * ("Shell · deploy watcher"), a status dot, an activity ordering, the backlink
 * to the chat that created it, and the details a person debugging one asks for.
 *
 * This used to be deliberately narrower than the agent's view, carrying no
 * `command`, `cwd` or cadence on the reasoning that the UI neither authors nor
 * edits commands. That held only while the human surface was a list of rows.
 * The output window's details popover is the case it does not survive: someone
 * reading a shell's log and asking "what exactly ran, and where?" is not
 * authoring anything, and answering "open the agent's transcript and find the
 * tool call" is the surface refusing to say what it plainly knows. Product
 * decision, 2026-08-13.
 *
 * `interpreter` and `logDirectory` stay OUT, and that half of the original
 * reasoning is unchanged: which shell binary resolved and where the log file
 * sits are facts about the host's disk, not about the work, and no human
 * surface has a question they answer.
 *
 * Everything added since the first shipped shape is DEFAULTED, so a host too
 * old to send it still parses.
 */
export const managedCommandSchema = z.object({
  id: z.string(),
  /** Output is delivered to the owning agent as it prints, not only at death. */
  monitoring: z.boolean(),
  /** The command's human label, shown as the row title. */
  description: z.string(),
  /**
   * The command line as the agent wrote it, verbatim. Null - never `""` - when
   * the host is too old to send it, so a surface can say "this host does not
   * report it" instead of rendering an empty command line as fact.
   */
  command: z.string().nullable().default(null),
  /** Absolute working directory the command runs in; null on an old host. */
  cwd: z.string().nullable().default(null),
  /** How digests are paced; null unless `monitoring`. */
  cadence: managedCommandCadenceSchema.nullable().default(null),
  status: managedCommandStatusSchema,
  /**
   * The chat that created the command - the row's backlink. This is the
   * creating agent's id, which for a chat-hosted agent IS its chat id; the same
   * equivalence the delivery path relies on to route a digest back.
   */
  chatId: z.string(),
  createdAtMs: z.number(),
  /** Last lifecycle or spec change; the list's "most recent activity" order. */
  updatedAtMs: z.number(),
});
export type ManagedCommand = z.infer<typeof managedCommandSchema>;

/**
 * Wire-freeze copy of `managedCommandSchema` from before the details widening
 * (`command`/`cwd`/`cadence`). Bound to `chat.subscribe@1.6` - the released
 * line the whole Shells surface arrived on - so that line can never observe the
 * new fields. Hand-frozen, NOT derived from the live shape via `.omit()`, so a
 * future field added to the live schema cannot silently leak onto it. Same
 * discipline, and the same reason, as `toolCallBlockSchemaPreImage`.
 */
export const managedCommandSchemaPreImage = z.object({
  id: z.string(),
  monitoring: z.boolean(),
  description: z.string(),
  status: managedCommandStatusSchema,
  chatId: z.string(),
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
});

/**
 * Every id-addressed control names its epic. Scoping is not advisory: a command
 * in another epic is answered exactly as an id that never existed, so the
 * surface cannot be used to probe for commands the caller may not see.
 */
export const managedCommandControlRequestSchema = z.object({
  epicId: z.string(),
  commandId: z.string(),
});
export type ManagedCommandControlRequest = z.infer<
  typeof managedCommandControlRequestSchema
>;

/**
 * Start and stop answer with the command's post-transition state. The list
 * stream pushes the same change to every subscriber; this is what lets the
 * caller that pressed the button settle its own row without waiting for it.
 */
export const managedCommandControlResponseSchema = z.object({
  command: managedCommandSchema,
});
export type ManagedCommandControlResponse = z.infer<
  typeof managedCommandControlResponseSchema
>;

export const managedCommandDeleteRequestSchema =
  managedCommandControlRequestSchema;
export type ManagedCommandDeleteRequest = ManagedCommandControlRequest;

/**
 * Delete has no post-state to report: the row, the process and the entire
 * output history are gone. The echoed id is what lets a caller match the
 * result to the window it should now tear down.
 */
export const managedCommandDeleteResponseSchema = z.object({
  commandId: z.string(),
});
export type ManagedCommandDeleteResponse = z.infer<
  typeof managedCommandDeleteResponseSchema
>;
