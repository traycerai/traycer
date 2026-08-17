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

/**
 * One shell whose last batch of output a committed Stop fence captured and is
 * holding back. The hold is DURABLE and survives host restarts, which is the
 * whole reason this needs a surface: a shell that is still running releases its
 * own hold the moment it prints again, but one whose FINAL batch the Stop
 * caught will never produce later output, so nothing re-dirties it and only an
 * explicit Deliver can ever clear it.
 *
 * Deliberately narrow. `description` rides along so a surface can name the row
 * without joining, but everything else a viewer needs - status, monitoring, the
 * command line - is already on the chat's `managedCommands` entry under the
 * same `commandId`, and a held command is always still in that set (deleting
 * one cascades its hold away).
 *
 * The delivery-state revision carrying the hold is deliberately NOT here, for
 * the reason `managedCommandStatusSchema` leaves out `pidStartTimeMs`: it
 * settles an internal write race and is nothing a viewer can act on.
 *
 * SHARED BY TWO FAMILIES - `chat.subscribe` (snapshot + `heldUpdatesChanged`)
 * and `managedCommand.deliverHeld` both reference this object, so a field added
 * here lands on both surfaces at once. `chat.subscribe` freezes its released
 * minors against hand-written pre-images; when the next one freezes, this
 * object must be inlined into that pre-image rather than referenced, or the
 * freeze tracks this definition and stops being a freeze. That is exactly how
 * the 1.6 details widening leaked, and it is the reason the pre-image files are
 * literals rather than imports.
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
 * Deliver is chat-scoped, not command-scoped, because a hold is: the Stop that
 * installed it fenced a CHAT, and "deliver everything you are holding for me"
 * is the action a human actually takes. `commandIds` narrows it to specific
 * shells; null means every hold this chat owns.
 *
 * `epicId` is named for the same reason the id-addressed controls name it - a
 * chat in another epic is answered exactly as one that never existed. It is
 * also load-bearing for AUTHORIZATION: the host proves this chat belongs to
 * this epic before it scans, because the durable rows carry the chat and no
 * epic, so a scan keyed on the chat alone would answer for a chat the caller
 * named but has no rights to.
 */
export const managedCommandDeliverHeldRequestSchema = z.object({
  epicId: z.string(),
  chatId: z.string(),
  /**
   * The holds to deliver; null means every hold this chat owns.
   *
   * An EMPTY array is rejected rather than accepted as "deliver nothing".
   * Nothing a person can do produces it, so in practice it is a caller that
   * meant `null` and built the array from an empty selection - and answering
   * that with an empty, fully-successful response reads identically to a real
   * delivery. The narrow branch is the dangerous one to make silent.
   */
  commandIds: z.array(z.string()).min(1).nullable(),
});
export type ManagedCommandDeliverHeldRequest = z.infer<
  typeof managedCommandDeliverHeldRequestSchema
>;

/**
 * One hold the host could not prove it released.
 *
 * The host's own release path is all-or-nothing: it throws unless EVERY
 * in-scope durable row is provably hold-free, because resolution there means
 * "you may tell the user this output was delivered". That is the right
 * guarantee for a proof obligation and the wrong shape for a surface - a person
 * who asked to deliver four shells and got three should be told which one is
 * stuck, not that the whole action failed. So the RPC reports the split instead
 * of inheriting it (see `managedCommandDeliverHeldResponseSchema`).
 *
 * `retryable` is the ONLY field a client may branch on, and it is a boolean on
 * purpose: the one bit a surface acts on, in a shape that never needs widening.
 *
 * (An added enum value on a host->client payload IS a wire break at a released
 * version - `surface-compat.ts` - but that argument alone proves too much to
 * lean on here: this method has not shipped, so an enum would be free today,
 * and freezing-plus-bridging is a ritual this repo pays routinely elsewhere.
 * The boolean earns its place by being the whole decision a surface makes.)
 *
 * - `true`  - transient. The hold is real and this host process could still
 *   release it: the pair has not been materialized by a reconcile pass yet, or
 *   a later Stop re-installed the hold. Offer the action again.
 * - `false` - wedged for the life of this host process, and no amount of
 *   retrying changes it: a delivery row written by a NEWER build that this one
 *   cannot decode, or a boot record load that failed (the supervisor memoizes
 *   that rejection and never reloads). Say so - "this shell's output needs a
 *   newer/restarted host" - rather than offering a button that cannot work.
 *
 * `code` is a free-form string, NOT an enum, precisely so new failure modes can
 * be distinguished in logs and telemetry without a wire break. Clients must not
 * branch on it; it is for humans reading a report.
 */
export const managedCommandHeldReleaseFailureSchema = z.object({
  /**
   * The command this entry is about. Always present: a failure the host cannot
   * attribute to one command is reported in `unattributed` instead, so that
   * `unresolved.length` is always a count of SHELLS and can be rendered as one.
   */
  commandId: z.string(),
  /** Stable identifier for logs and telemetry. Never branch on this. */
  code: z.string(),
  /** Whether retrying against THIS host process could ever succeed. */
  retryable: z.boolean(),
  /**
   * Host-authored detail. Show it verbatim rather than composing copy from
   * `retryable` alone: `false` covers two different human remedies - a row a
   * NEWER build wrote (upgrade this host) and a boot load that failed (restart
   * it) - and only this string distinguishes them, since `code` is not
   * branchable.
   */
  message: z.string(),
});
export type ManagedCommandHeldReleaseFailure = z.infer<
  typeof managedCommandHeldReleaseFailureSchema
>;

/**
 * A failure that belongs to the CALL, not to any one command.
 *
 * Three of the host's proof arms - a disposed router, a delivery-state table it
 * could not read, and a boot record load that failed - fail BEFORE anything is
 * enumerated, so there is no id to name. The last is the sharp one: with
 * `commandIds: null` the in-scope set IS the owned-record set, which is exactly
 * what the failed load did not produce.
 *
 * This is its own field rather than a null `commandId` inside `unresolved`
 * because the two answer different questions and callers kept conflating them.
 * `unresolved` is "which shells are stuck", and its length is a shell count a
 * surface can put in a sentence. An un-attributed failure is "this Deliver
 * proved NOTHING about this chat" - it says nothing about how many holds stand,
 * and a chat with four holds produces exactly one of these. Sharing one array
 * made `unresolved.length` mean neither reliably, and the first client to read
 * it got "1 shell can't be delivered" for a chat holding four.
 *
 * A non-empty `unattributed` also disarms the rest of the response: `released`
 * and `held` are empty because nothing could be determined, NOT because there
 * was nothing to determine. Never render an empty `held` as "nothing is held"
 * without checking this field first.
 *
 * Same `retryable`/`code`/`message` contract as the per-command failure.
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

/**
 * Deliver answers with what actually happened, per command, and RESOLVES even
 * when part of it failed. A non-empty `unresolved` is a normal, expected
 * outcome - not an error channel - so a caller can render "3 delivered, 1 still
 * held" in one pass. The RPC itself rejects only for the ordinary reasons any
 * other control does: an epic/chat the caller may not touch, or a transport
 * failure.
 *
 * `held` is the post-state, the same way start and stop answer with the
 * command's post-transition state: the chat's REMAINING holds after the call.
 * On a fully successful Deliver of every hold it is empty. It is not derivable
 * from `released` + `unresolved` - a hold installed by a Stop that landed
 * concurrently belongs in it and in neither of the others - which is why it is
 * reported at all rather than left to the stream. Read it as the host's best
 * current view, NOT as authority to clear a row you did not name; the field's
 * own note says why, and this sentence used to say the opposite.
 *
 * Read the fields in this order: `unattributed` first (a non-empty one means
 * nothing else here was determined), then `released`/`unresolved` for the rows
 * you named, then `held` as context.
 */
export const managedCommandDeliverHeldResponseSchema = z.object({
  /** Command ids whose hold this call proved gone. */
  released: z.array(z.string()),
  /**
   * In-scope commands whose release could not be proven, one entry per command.
   * `unresolved.length` is a SHELL COUNT and safe to render as one.
   */
  unresolved: z.array(managedCommandHeldReleaseFailureSchema),
  /**
   * Failures belonging to the call rather than to any command. Check this
   * BEFORE reading anything else: while it is non-empty, `released` and `held`
   * are empty because nothing was determined, not because nothing was there.
   */
  unattributed: z.array(managedCommandHeldReleaseUnattributedSchema),
  /**
   * The holds the chat still owns once this call settled, as far as the host
   * can SEE them - not a proof of completeness, and the difference matters.
   *
   * Its producer is derived from the host's in-memory pair set, and a delivery
   * row this build cannot decode never becomes a pair (the reconcile pass skips
   * it), so such a hold can never appear here. It surfaces in `unresolved`
   * instead whenever it is in scope - but `held` is chat-wide while the proof is
   * scoped to `commandIds`, so a narrowed Deliver can leave an undecodable hold
   * on a SIBLING shell in neither list.
   *
   * So: settle the rows you asked about from `released`/`unresolved`, and treat
   * `held` as the best current view rather than as authority to clear a row you
   * did not name. An empty `held` alongside a non-empty `unresolved` never means
   * "nothing is held".
   */
  held: z.array(heldManagedCommandUpdateSchema),
});
export type ManagedCommandDeliverHeldResponse = z.infer<
  typeof managedCommandDeliverHeldResponseSchema
>;
