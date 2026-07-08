import { z } from "zod";
import {
  agentModeSchema,
  tuiHarnessIdSchema,
} from "@traycer/protocol/host/agent/shared";
import { GENERATE_TITLE_SOURCE_TEXT_MAX_CHARS } from "@traycer/protocol/host/epic/unary-schemas";
import { worktreeBindingWorkspaceModeSchema } from "@traycer/protocol/host/worktree-schemas";

// ─── Catalog rows (per-surface) ───────────────────────────────────────────
//
// Each surface has its own listHarnesses RPC that returns harnesses
// installed/available for that surface. The id is narrowed to the surface's
// enum so the renderer never has to widen.

export const tuiHarnessOptionSchema = z.object({
  id: tuiHarnessIdSchema,
  label: z.string(),
  // Controls whether the harness is included in downstream filtering and shown
  // in the CLI. This is distinct from `available` and `availabilityPending`,
  // which describe the current host-side availability probe state.
  enabled: z.boolean().default(true),
  available: z.boolean(),
  error: z.string().nullable(),
  // True while the host's availability probe for this harness is still running
  // in the background (mirrors `guiHarnessOptionSchema`). A pending row carries
  // `available: false`; a TUI consumer should re-fetch until it flips false
  // rather than treat the harness as unavailable. `.catch(false)` tolerates old
  // host builds that omit the field.
  availabilityPending: z.boolean().catch(false),
});
export type TuiHarnessOption = z.infer<typeof tuiHarnessOptionSchema>;

// ─── `agent.tui.listHarnesses` ───────────────────────────────────────────

export const listTuiHarnessesRequestSchema = z.object({});
export type ListTuiHarnessesRequest = z.infer<
  typeof listTuiHarnessesRequestSchema
>;

export const listTuiHarnessesResponseSchema = z.object({
  harnesses: z.array(tuiHarnessOptionSchema),
});
export type ListTuiHarnessesResponse = z.infer<
  typeof listTuiHarnessesResponseSchema
>;

// ─── `agent.tui.prepareLaunch@1.0` - prepare a TUI-agent launch ───────────
//
// The renderer calls this on first launch and again on every reattach when
// the harness needs host-prepared launch state (today, only Codex;
// Claude/OpenCode reattach is reconstructed entirely renderer-side - see
// `tui-cli-invocation.ts`).
//
// Two identifiers travel together because two layers each need their own
// handle on the session:
//
//   • `tuiAgentId` - Traycer's artifact id for the tab (the row id in the
//     epic's `tuiAgents` Y.Map). Lets the resolver write a freshly-discovered
//     harness session id back onto the right record, and also serves as the
//     adapter-side per-tab key (e.g. the `codex app-server` instance map).
//     `null` only for one-shot probes called before any tab is persisted.
//
//   • `harnessSessionId` - the upstream harness's own CLI-resumable id,
//     used as the CLI resume key (`claude --resume <id>`, `codex resume
//     <id>`, `opencode --session <id>`). `null` ⇒ no upstream session yet,
//     allocate one; non-null ⇒ reattach the named upstream session.
//
//     Allocation is harness-specific:
//       - Claude/OpenCode allocate it synchronously inside prepareLaunch, so
//         the response always carries a non-null id.
//       - Codex's app-server allocates the CLI saved-session id only after
//         the user-facing CLI connects and emits `thread/started`. The first
//         call therefore returns `harnessSessionId: null`; once the session id
//         is observed it is back-filled onto the persisted record via the
//         host-side `onProviderSessionStarted` callback.
export const prepareTuiLaunchRequestSchema = z.object({
  harnessId: tuiHarnessIdSchema,
  epicId: z.string(),
  model: z.string().nullable(),
  reasoningEffort: z.string().nullable().default(null),
  agentMode: agentModeSchema,
  tuiAgentId: z.string().nullable(),
  harnessSessionId: z.string().nullable(),
  // Launch-time override for the extra CLI args appended to the spawned argv.
  // A string (including "") is used verbatim for this launch; `null` tells the
  // host to fall back to the provider's saved Settings default. Reopens pass
  // the persisted per-agent value, which is either that durable override or
  // `null` when no override was captured.
  terminalAgentArgs: z.string().nullable().default(null),
  workspaceMode: worktreeBindingWorkspaceModeSchema.optional(),
  // When non-null, prepare a fork from this upstream provider session and
  // return/open the newly forked session. This is distinct from
  // `harnessSessionId`: the source id must not be persisted on the new agent.
  forkSourceHarnessSessionId: z.string().nullable().default(null),
});
export type PrepareTuiLaunchRequest = z.infer<
  typeof prepareTuiLaunchRequestSchema
>;

export const prepareTuiLaunchResponseSchema = z.object({
  harnessId: tuiHarnessIdSchema,
  // `null` when the harness hasn't allocated a CLI-resumable id yet (Codex
  // first launch - back-filled async). Always non-null for Claude/OpenCode.
  harnessSessionId: z.string().nullable(),
  terminalShellCommand: z.string().nullable(),
  terminalShellArgs: z.array(z.string()).nullable(),
  hostId: z.string(),
  workingDirectory: z.string(),
  workspaceFolders: z.array(z.string()),
  // Concrete worktree paths the harness will hold open for the lifetime of
  // the visible PTY. Always populated from the binding's `worktreePath`
  // entries (deduped, primary first); empty in Local mode and when no
  // binding is in effect. The renderer threads this through `terminal.create`
  // so the host-side active-run busy registry can refuse `worktree.delete`
  // for any of these paths until the PTY exits - covering multi-repo
  // worktree bindings where the sibling worktree paths would otherwise be
  // missed by the single-cwd backstop. Local workspace rows and Traycer
  // support directories are intentionally excluded.
  worktreeBusyPaths: z.array(z.string()),
});
export type PrepareTuiLaunchResponse = z.infer<
  typeof prepareTuiLaunchResponseSchema
>;

// ─── `agent.tui.generateTitle@1.0` - hook-driven title generation ──────────
//
// Drives the same server endpoint chat titles use (`target: "chat"`) and
// writes the result onto the terminal-agent record in the epic's
// `tuiAgents` Y.Map. Called from the harness hook adapter on first user
// prompt; the resolver validates ownership/identity before any server call
// and falls back to a normalized slice of the prompt when generation fails.
//
// `harnessId` is the harness the hook is wired into. The resolver rejects
// mismatched-harness requests so a stale hook can't retitle an agent that
// has since been replaced by a different harness on the same id.

export const generateTuiAgentTitleRequestSchema = z.object({
  epicId: z.string().nullable().default(null),
  tuiAgentId: z.string().nullable().default(null),
  // OpenCode plugin events run inside the singleton `opencode serve` process,
  // not the per-agent attach PTY, so they identify the TUI agent by upstream
  // sessionID instead of TRAYCER_EPIC_ID / TRAYCER_AGENT_ID.
  harnessSessionId: z.string().nullable().default(null),
  harnessId: tuiHarnessIdSchema,
  promptText: z.string().min(1).max(GENERATE_TITLE_SOURCE_TEXT_MAX_CHARS),
});
export type GenerateTuiAgentTitleRequest = z.infer<
  typeof generateTuiAgentTitleRequestSchema
>;

export const generateTuiAgentTitleResponseSchema = z.object({
  // `accepted` is true when the resolver scheduled a title generation; it
  // is false when the request was a no-op (e.g. the title has already been
  // manually renamed or no longer matches the expected initial title).
  accepted: z.boolean(),
});
export type GenerateTuiAgentTitleResponse = z.infer<
  typeof generateTuiAgentTitleResponseSchema
>;

// ─── `agent.tui.turnEnded@1.0` - Stop-hook turn-completion signal ─────────
//
// Fired by the Claude Code `Stop` hook when a terminal-agent finishes a
// turn. The host resolver validates ownership/identity (mirroring
// generateTitle) and, on a clean check, tells the inter-agent broker the
// receiver's turn ended: any open thread that agent owed a reply on fires a
// `turn-ended` inactivity notice. This is the accurate, primary "done"
// signal - far better than waiting for raw PTY silence. `harnessId` lets
// the resolver reject a stale hook firing against a since-replaced harness.

export const tuiAgentTurnEndedRequestSchema = z.object({
  epicId: z.string(),
  tuiAgentId: z.string(),
  harnessId: tuiHarnessIdSchema,
});
export type TuiAgentTurnEndedRequest = z.infer<
  typeof tuiAgentTurnEndedRequestSchema
>;

export const tuiAgentTurnEndedResponseSchema = z.object({
  // `accepted` is true when the resolver recorded the turn-end edge; false
  // for a benign no-op (record missing, ownership/harness mismatch, broker
  // unavailable).
  accepted: z.boolean(),
});
export type TuiAgentTurnEndedResponse = z.infer<
  typeof tuiAgentTurnEndedResponseSchema
>;

// ─── `agent.tui.recordActivity@1.0` - hook-driven activity edges ──────────
//
// Provider hook/plugin configs call this when a terminal-agent turn starts or
// stops. The host validates the request against the persisted TUI agent
// before updating its in-memory activity oracle. This is intentionally a level
// signal: `event: "start"` means working until a matching `"stop"` or PTY exit.

export const recordTuiAgentActivityRequestSchema = z.object({
  epicId: z.string().nullable().default(null),
  tuiAgentId: z.string().nullable().default(null),
  // OpenCode plugin events run inside the singleton `opencode serve` process,
  // not the per-agent attach PTY, so they identify the TUI agent by upstream
  // sessionID instead of TRAYCER_EPIC_ID / TRAYCER_AGENT_ID.
  harnessSessionId: z.string().nullable().default(null),
  harnessId: tuiHarnessIdSchema,
  event: z.enum(["start", "stop"]),
});
export type RecordTuiAgentActivityRequest = z.infer<
  typeof recordTuiAgentActivityRequestSchema
>;

export const recordTuiAgentActivityResponseSchema = z.object({
  accepted: z.boolean(),
});
export type RecordTuiAgentActivityResponse = z.infer<
  typeof recordTuiAgentActivityResponseSchema
>;

// ─── `agent.tui.recordActivity@1.1` - + observed session-id resync ────────
//
// Additive minor bump over v1.0. Two changes, both driven by the Claude TUI
// session-id resync (Claude implicitly re-ids its session on Esc-Esc rewind,
// `/clear`, fork-after-`/btw`, etc.; the stored `harnessSessionId` must follow
// what the user currently sees in the PTY):
//
//   • `observedHarnessSessionId` - the live `session_id` Claude stamps on every
//     hook's stdin payload. The resolver writes it back onto the record's
//     `harnessSessionId` when it drifts (claude-gated). This is DISTINCT from
//     the existing `harnessSessionId` request field, which stays an OpenCode
//     match-or-reject identity guard - never overloaded here. `null` (the
//     v1.0-upgraded default) means "no observed id / nothing to resync".
//
//   • `event: "resync"` - a pure resync edge that is NOT an activity edge: the
//     resolver performs the session write-back but does NOT touch the activity
//     oracle. Fired by the Claude `SessionStart` hook (a dedicated CLI command),
//     which reports the fresh id at the drift moment even when the user rewinds
//     then immediately closes/forks the tab without another prompt. The existing
//     `start`/`stop` edges (UserPromptSubmit/Stop) also carry
//     `observedHarnessSessionId`, so drift on a normal turn resyncs too.
//
// A new capability MUST ride a new `{ major, minor }` of an existing method,
// never a new method name (a new name fatally fails the equal-set `/rpc`
// handshake against a shipped v1.0.0 host). Adding the `"resync"` enum value is
// additive-advisory growth: a v1.0 host only ever meets it via the new
// SessionStart flow it does not have.

export const recordTuiAgentActivityRequestSchemaV11 =
  recordTuiAgentActivityRequestSchema.extend({
    event: z.enum(["start", "stop", "resync"]),
    observedHarnessSessionId: z.string().nullable().default(null),
  });
export type RecordTuiAgentActivityRequestV11 = z.infer<
  typeof recordTuiAgentActivityRequestSchemaV11
>;
