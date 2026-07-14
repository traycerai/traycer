/**
 * Host ↔ client wire shapes for the `terminal.*` RPC surface.
 *
 * Terminal sessions are local to a host - they don't round-trip through
 * the cloud and have no Y.Doc projection. The host owns the live PTY plus
 * a rolling scrollback buffer in memory; renderers attach via the streaming
 * `terminal.subscribe` contract (see `protocol/stream/terminal-subscribe.ts`).
 *
 * Allowed dependencies: `zod` and other protocol modules only - this file
 * must stay browser-safe.
 */
import { z } from "zod";
import { tuiHarnessIdSchema } from "@traycer/protocol/host/agent/shared";

export const terminalSessionStatusSchema = z.enum(["running", "exited"]);
export type TerminalSessionStatus = z.infer<typeof terminalSessionStatusSchema>;

export const terminalSessionKindSchema = z.enum(["terminal", "terminal-agent"]);
export type TerminalSessionKind = z.infer<typeof terminalSessionKindSchema>;

// Why a session's PTY ended. `process-exit` is the process ending on its
// own; `killed` is an explicit kill (user close, stop, binding restart);
// `reaped` is the host's idle-reap of an unwatched `terminal-agent` -
// clients treat a reaped exit as lifecycle (revive silently), never as a
// crash to report.
export const terminalSessionExitReasonSchema = z.enum([
  "process-exit",
  "killed",
  "reaped",
]);
export type TerminalSessionExitReason = z.infer<
  typeof terminalSessionExitReasonSchema
>;

// Session scope: `{ kind: "epic" }` sessions belong to an epic; `{ kind:
// "independent" }` sessions are landing-scope (epic-less). A discriminated
// union rather than `epicId: string | null` - self-describing on the wire,
// and extensible to future scopes without another schema change. Used by the
// major-2 unary lines and `terminal.subscribe@1.4` (see
// `canonicalTerminalSessionInfoSchema` below); the frozen
// `terminalSessionInfoSchema` predates scoping and stays
// `epicId`. `scope` replacing `epicId` is a breaking change to the request
// shape - the unary framework's minor-additivity checker
// (`assertSchemaCompatibility` in `versioned-rpc.ts`) rejects a field rename
// within a minor line, so this rides a new major (`@2.0`), not a minor.
export const terminalScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("epic"), epicId: z.string() }),
  z.object({ kind: z.literal("independent") }),
]);
export type TerminalScope = z.infer<typeof terminalScopeSchema>;

// Frozen `epicId: string` session-info shape, shared by every RELEASED
// terminal contract (`create@1.0`/`list@1.0` responses; `subscribe@1.0`-
// `1.3` frames). Never mutate in place - replacing `epicId` with a scope
// union would change an already-shipped host->client slot, which the compat
// checker blocks. The major-2 unary lines (`create@2.0`, `list@2.0`) and
// `subscribe@1.4` use `canonicalTerminalSessionInfoSchema` below instead.
export const terminalSessionInfoSchema = z.object({
  sessionId: z.string(),
  epicId: z.string(),
  sessionKind: terminalSessionKindSchema,
  cwd: z.string(),
  shellCommand: z.string(),
  shellArgs: z.array(z.string()),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  status: terminalSessionStatusSchema,
  exitCode: z.number().int().nullable(),
  // `null` while running; set alongside `exitCode` when the session exits.
  // Optional so payloads from hosts predating the field still parse -
  // absent is equivalent to `process-exit` (the only pre-field behavior a
  // client could assume).
  exitReason: terminalSessionExitReasonSchema.nullable().optional(),
  createdAt: z.number(),
  // User-supplied display title. `null` means "use the default derived
  // label (basename of cwd / shellCommand)". Lifetime is the session's -
  // PTYs don't survive host restarts, so neither does the title.
  title: z.string().nullable(),
  // Host-observed foreground process name for the PTY. `null` means the
  // terminal is idle or the host cannot determine a foreground process.
  // Optional so clients remain compatible with already-shipped hosts.
  activeProcessName: z.string().nullable().optional(),
});
export type TerminalSessionInfo = z.infer<typeof terminalSessionInfoSchema>;

// Canonical session-info shape for the scope-bearing terminal lines: `scope`
// replaces `epicId` - `{ kind: "independent" }` denotes a landing-scope
// (epic-less) session. Every other field is identical to the frozen
// `terminalSessionInfoSchema` above - this is a parallel export, not a
// replacement, so released contracts keep parsing the frozen shape
// untouched.
export const canonicalTerminalSessionInfoSchema = z.object({
  sessionId: z.string(),
  scope: terminalScopeSchema,
  sessionKind: terminalSessionKindSchema,
  cwd: z.string(),
  shellCommand: z.string(),
  shellArgs: z.array(z.string()),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  status: terminalSessionStatusSchema,
  exitCode: z.number().int().nullable(),
  exitReason: terminalSessionExitReasonSchema.nullable().optional(),
  createdAt: z.number(),
  title: z.string().nullable(),
  activeProcessName: z.string().nullable().optional(),
});
export type CanonicalTerminalSessionInfo = z.infer<
  typeof canonicalTerminalSessionInfoSchema
>;

// `terminal.create@1.0` - spawns a new PTY-backed session for the given epic.
// `sessionKind` distinguishes user terminal tabs from terminal-agent backing
// PTYs so UI surfaces can list only the sessions they own. `cwd` is the
// renderer-selected working directory; `shellCommand` and `shellArgs` remain
// nullable so interactive terminals can use the host's configured shell.
// `desiredSessionId` is the renderer-authoritative id (typically the canvas
// node id), kept stable across reconnect attempts within one tile lifetime.
export const createTerminalRequestSchema = z.object({
  epicId: z.string(),
  sessionKind: terminalSessionKindSchema,
  // Present for terminal-agent sessions so the host can apply
  // harness-specific activity semantics. Plain terminal tabs pass null.
  tuiHarnessId: tuiHarnessIdSchema.nullable().default(null),
  cwd: z.string().min(1),
  shellCommand: z.string().nullable(),
  shellArgs: z.array(z.string()).nullable(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  desiredSessionId: z.string(),
  // Worktree paths the launching caller is committing the PTY to using for
  // its lifetime. Forwarded verbatim to the host-side active-run busy
  // registry so a multi-repo terminal-agent launch can hold the busy mark
  // for every bound worktree path, not just `cwd`. Plain `terminal` shells
  // (and terminal-agent launches with no worktree binding) pass an empty
  // array.
  worktreeBusyPaths: z.array(z.string()),
});
export type CreateTerminalRequest = z.infer<typeof createTerminalRequestSchema>;

export const createTerminalResponseSchema = z.object({
  session: terminalSessionInfoSchema,
});
export type CreateTerminalResponse = z.infer<
  typeof createTerminalResponseSchema
>;

// `terminal.create@2.0` - `scope: { kind: "independent" }` requests a
// landing-scope (epic-less) session; every other field is unchanged from
// `@1.0`. The response's `session` carries the canonical (scope-bearing)
// session info instead of the frozen `@1.0` shape.
export const createTerminalRequestSchemaV20 = z.object({
  scope: terminalScopeSchema,
  sessionKind: terminalSessionKindSchema,
  tuiHarnessId: tuiHarnessIdSchema.nullable().default(null),
  cwd: z.string().min(1),
  shellCommand: z.string().nullable(),
  shellArgs: z.array(z.string()).nullable(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  desiredSessionId: z.string(),
  worktreeBusyPaths: z.array(z.string()),
});
export type CreateTerminalRequestV20 = z.infer<
  typeof createTerminalRequestSchemaV20
>;

export const createTerminalResponseSchemaV20 = z.object({
  session: canonicalTerminalSessionInfoSchema,
});
export type CreateTerminalResponseV20 = z.infer<
  typeof createTerminalResponseSchemaV20
>;

// `terminal.kill@1.0` - terminates a session and evicts it from the host's
// in-memory map. Returns `killed: false` only if the session was already
// missing or had completed its grace period.
export const killTerminalRequestSchema = z.object({
  sessionId: z.string(),
});
export type KillTerminalRequest = z.infer<typeof killTerminalRequestSchema>;

export const killTerminalResponseSchema = z.object({
  killed: z.boolean(),
});
export type KillTerminalResponse = z.infer<typeof killTerminalResponseSchema>;

// `terminal.list@1.0` - lists sessions the host currently knows about for
// the given epic, including ones in the post-exit grace window (so the
// renderer can show "Process exited (code N) - Restart" instead of silently
// reattaching to a fresh shell).
export const listTerminalsRequestSchema = z.object({
  epicId: z.string(),
});
export type ListTerminalsRequest = z.infer<typeof listTerminalsRequestSchema>;

export const listTerminalsResponseSchema = z.object({
  sessions: z.array(terminalSessionInfoSchema),
});
export type ListTerminalsResponse = z.infer<typeof listTerminalsResponseSchema>;

// `terminal.list@2.0` - `scope: { kind: "independent" }` lists landing-scope
// (epic-less) sessions instead of an epic's. Sessions carry the canonical
// (scope-bearing) session info instead of the frozen `@1.0` shape.
export const listTerminalsRequestSchemaV20 = z.object({
  scope: terminalScopeSchema,
});
export type ListTerminalsRequestV20 = z.infer<
  typeof listTerminalsRequestSchemaV20
>;

export const listTerminalsResponseSchemaV20 = z.object({
  sessions: z.array(canonicalTerminalSessionInfoSchema),
});
export type ListTerminalsResponseV20 = z.infer<
  typeof listTerminalsResponseSchemaV20
>;

// `terminal.rename@1.0` - overrides the session's display title. Title
// lives on the in-memory session record only; it does not persist across
// host restarts (PTYs themselves don't either). `updated: false` means
// the session was missing or already had the requested title.
export const renameTerminalRequestSchema = z.object({
  sessionId: z.string(),
  title: z.string(),
});
export type RenameTerminalRequest = z.infer<typeof renameTerminalRequestSchema>;

export const renameTerminalResponseSchema = z.object({
  updated: z.boolean(),
});
export type RenameTerminalResponse = z.infer<
  typeof renameTerminalResponseSchema
>;
