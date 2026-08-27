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

// Latest canonical session-info shape. `cwd` remains the immutable launch
// directory; `currentCwd` tracks the shell's live working directory when the
// terminal reports it via a supported OSC sequence. Current hosts initialize
// it to `cwd`, so it is also the explicit fallback when live discovery is
// absent. The wire schema accepts an empty compatibility value because the
// frozen v2.1 `cwd` field did; clients treat it as unavailable.
//
// This is a parallel schema rather than an in-place edit of
// `canonicalTerminalSessionInfoSchema`: the latter already shipped in
// `terminal.list@2.0`/`@2.1`, `terminal.create@2.0`, and
// `terminal.subscribe@1.4` and must remain frozen.
export const canonicalTerminalSessionInfoWithCurrentCwdSchema =
  canonicalTerminalSessionInfoSchema.extend({
    currentCwd: z.string(),
  });
export type CanonicalTerminalSessionInfoWithCurrentCwd = z.infer<
  typeof canonicalTerminalSessionInfoWithCurrentCwdSchema
>;

// Who owns the session's lifetime. `registry` is a persistent plain-terminal
// record (a `terminal.list` shadow of `terminal.plain.*`); `manager` is a
// TerminalSessionManager session such as setup or provider-login. Updated
// hosts tag every `terminal.list@2.3` row from the actual list composition,
// not from title, cwd, or session kind. This is a parallel schema: the v2.2
// currentCwd shape already shipped and stays frozen.
export const terminalLifecycleOwnerSchema = z.enum(["registry", "manager"]);
export type TerminalLifecycleOwner = z.infer<
  typeof terminalLifecycleOwnerSchema
>;

export const canonicalTerminalSessionInfoWithLifecycleOwnerSchema =
  canonicalTerminalSessionInfoWithCurrentCwdSchema.extend({
    lifecycleOwner: terminalLifecycleOwnerSchema,
  });
export type CanonicalTerminalSessionInfoWithLifecycleOwner = z.infer<
  typeof canonicalTerminalSessionInfoWithLifecycleOwnerSchema
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

// Spawning client's resolved terminal appearance, carried on
// `terminal.create@2.1` so the host can answer a TUI's OSC 10/11
// foreground/background queries (which otherwise time out - no client is
// subscribed yet when a TUI probes at startup, and the snapshot emulator
// deliberately never records queries). The hint is a HEURISTIC, not a truth:
// a session outlives and outspans any single viewer, so the host answers
// with the spawner's theme and a cross-theme second viewer sees a
// mismatched-but-readable TUI (the renderer's minimumContrastRatio carries
// readability). Colors are strict lowercase-or-uppercase `#rrggbb` because
// the host interpolates them into an escape sequence written to the PTY -
// nothing wider than a hex literal may cross this boundary.
export const terminalThemeHintColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/);
export const terminalThemeHintSchema = z.object({
  appearance: z.enum(["light", "dark"]),
  foreground: terminalThemeHintColorSchema,
  background: terminalThemeHintColorSchema,
});
export type TerminalThemeHint = z.infer<typeof terminalThemeHintSchema>;

// `terminal.create@2.1` - additive request-side `themeHint`. `null` - the
// v2.0-upgraded default - means "no spawner theme known" and the host falls
// back to a fixed dark answer (what a TUI assumes on query timeout anyway).
// The response is unchanged from `@2.0`.
export const createTerminalRequestSchemaV21 =
  createTerminalRequestSchemaV20.extend({
    themeHint: terminalThemeHintSchema.nullable().default(null),
  });
export type CreateTerminalRequestV21 = z.infer<
  typeof createTerminalRequestSchemaV21
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

// `terminal.list@2.1` - additive `homeCwd` on the response. A current host
// returns the process-account home directory (non-empty string). `null` is
// reserved for compatibility: the v2.0 → v2.1 response upgrade supplies
// `homeCwd: null` because an older host cannot authoritatively provide it.
// Request shape is unchanged from `@2.0`.
export const listTerminalsResponseSchemaV21 = z.object({
  sessions: z.array(canonicalTerminalSessionInfoSchema),
  homeCwd: z.string().min(1).nullable(),
});
export type ListTerminalsResponseV21 = z.infer<
  typeof listTerminalsResponseSchemaV21
>;

// `terminal.list@2.2` - additive live `currentCwd` on every session. An older
// host upgraded from v2.1 fills it from the immutable launch `cwd`. That frozen
// field allowed an empty compatibility value, which current clients interpret
// as "directory unavailable" rather than inventing a path.
export const listTerminalsResponseSchemaV22 = z.object({
  sessions: z.array(canonicalTerminalSessionInfoWithCurrentCwdSchema),
  homeCwd: z.string().min(1).nullable(),
});
export type ListTerminalsResponseV22 = z.infer<
  typeof listTerminalsResponseSchemaV22
>;

// `terminal.list@2.3` - additive lifetime-owner discriminator on every
// session. A v2.2 host upgraded to v2.3 fills `lifecycleOwner: "registry"`
// so a capable client fail-closes missing origin as a durable shadow rather
// than promoting it. Genuinely older hosts remain full `terminal.list`
// after positive legacy negotiation and do not consult the field.
export const listTerminalsResponseSchemaV23 = z.object({
  sessions: z.array(canonicalTerminalSessionInfoWithLifecycleOwnerSchema),
  homeCwd: z.string().min(1).nullable(),
});
export type ListTerminalsResponseV23 = z.infer<
  typeof listTerminalsResponseSchemaV23
>;

// `terminal.readOutput@1.0` - read-only access to one session's output for a
// caller that is an AGENT rather than a renderer. The host materializes the
// session's scrollback, current screen and a short metadata header to a file
// and returns that path; the caller reads or greps the file with its own
// tools. A path rather than the text itself because a terminal's scrollback
// is far larger than an RPC response should carry, and the reader is already
// on this host - the same shape the managed-command log directory takes.
//
// The file is a regenerable projection of live emulator state, rewritten on
// every call, so a path is never worth caching past the read that returned
// it. Only plain `terminal` sessions are readable; a `terminal-agent`
// session's conversation is `agent.getTranscript`'s job.
//
// Addressed to an epic like `agent.getTranscript` is, and for the same
// reason: the host resolves `sessionId` among that epic's terminals only, so
// what an agent can read is exactly what `terminal.list` shows it for the
// same epic. A session in another epic is not readable here even for its
// owner.
export const readTerminalOutputRequestSchema = z.object({
  epicId: z.string(),
  // An unambiguous session-id prefix of at least 4 characters is accepted,
  // matching the abbreviation rule the agent-facing id surfaces share.
  sessionId: z.string().min(1),
});
export type ReadTerminalOutputRequest = z.infer<
  typeof readTerminalOutputRequestSchema
>;

export const readTerminalOutputResponseSchema = z.object({
  path: z.string().min(1),
});
export type ReadTerminalOutputResponse = z.infer<
  typeof readTerminalOutputResponseSchema
>;

// `terminal.rename@1.0` - overrides the session's display title. New hosts may
// durably persist it for registry-owned plain terminals; manager-owned legacy
// sessions retain the released in-memory lifetime. The wire schema and
// `updated` response semantics remain frozen.
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
