/**
 * Shared wire shapes for the managed-command surface - the human half of the
 * subsystem whose agent half is the `traycer_*_monitor(s)` tool set. A managed
 * command is a supervised shell command owned by the host; its two kinds are a
 * `monitor` (meant to keep running) and a `shell` (runs once to completion).
 *
 * These schemas are shared by the unary lifecycle contracts in `./contracts.ts`
 * and the two streams in `./subscribe.ts`, the same way `terminalSessionInfo`
 * is shared across the terminal surface.
 */
import { z } from "zod";

export const managedCommandKindSchema = z.enum(["monitor", "shell"]);
export type ManagedCommandKind = z.infer<typeof managedCommandKindSchema>;

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
 * One managed command as a human surface sees it: enough to render a
 * kind-explicit row ("Monitor · deploy watcher"), a status dot, an activity
 * ordering, and the backlink to the chat that created it.
 *
 * Deliberately narrower than the agent's view: no `command`, `cwd`,
 * `interpreter` or `logDirectory`. The UI neither authors nor edits commands
 * (that is the agent's job) and reads output through `subscribeOutput` rather
 * than off the filesystem, so carrying the spec would only widen what a viewer
 * learns about the host's disk.
 */
export const managedCommandSchema = z.object({
  id: z.string(),
  kind: managedCommandKindSchema,
  /** The command's human label, shown as the row title. */
  description: z.string(),
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
