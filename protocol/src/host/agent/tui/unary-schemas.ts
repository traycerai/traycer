import { z } from "zod";
import {
  agentModeSchema,
  tuiHarnessIdSchema,
} from "@traycer/protocol/host/agent/shared";
import { GENERATE_TITLE_SOURCE_TEXT_MAX_CHARS } from "@traycer/protocol/host/epic/unary-schemas";
import {
  worktreeBindingWorkspaceModeSchema,
  worktreeIntentSchema,
} from "@traycer/protocol/host/worktree-schemas";

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
  // the last settled verdict for `available` - `false` only when the host has
  // never settled one; a TUI consumer should re-fetch until it flips false
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
  // Which of the harness's logged-in profiles (subscriptions) to spawn this
  // launch's adapter with. `null` = the ambient/host login, so older clients
  // that predate profiles keep today's exact behavior. Carried here (rather
  // than only read from the persisted `tuiAgents` record) because a brand-new
  // agent's *first* prepareLaunch fires before `epic.createTuiAgent` persists
  // that record - the resolver has nothing to look up yet. See the
  // multi-profile decision log.
  profileId: z.string().nullable().default(null),
});
export type PrepareTuiLaunchRequest = z.infer<
  typeof prepareTuiLaunchRequestSchema
>;

// ─── `agent.tui.prepareLaunch@1.1` - + stable fork-source agent id ────────
//
// Additive minor bump (tech plan governing mechanism 2, "source identity"
// decision). `forkSourceTuiAgentId` lets a new client name the fork source by
// its own stable artifact id, so the resolver can validate the exact tuple
// `{id, epic, harness, session, user, host}` directly instead of scanning
// every TUI agent in the epic for a `(harnessId, harnessSessionId, hostId,
// userId)` match (`resolveForkSourceTuiAgentStrict`). `null` - the
// v1.0-upgraded default - keeps that strict-scan fallback for old clients;
// never the fail-open missing⇒ambient shape. The response is unchanged.
export const prepareTuiLaunchRequestSchemaV11 =
  prepareTuiLaunchRequestSchema.extend({
    forkSourceTuiAgentId: z.string().nullable().default(null),
  });
export type PrepareTuiLaunchRequestV11 = z.infer<
  typeof prepareTuiLaunchRequestSchemaV11
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

// ─── `agent.tui.validateForkProfile@1.0` - preflight fork-profile admission ─
//
// Optional (non-floor) capability: read-only admission check that runs the
// SAME continuation-scope guard core `agent.tui.prepareLaunch` enforces
// authoritatively (`tui-fork-scope-guard.ts`) ahead of any client-side
// worktree/binding work, so a doomed cross-profile fork can be rejected
// before the client does anything it would need to roll back. This call is
// advisory only - prepareLaunch re-runs the same guard at the top of its own
// resolver (TOCTOU-safe) and remains the sole authority.
//
// Its negotiated presence in the RPC manifest IS the capability signal for
// cross-profile fork UI (see `useHostSupportsMethod`) - there is no separate
// capability flag to check. A caller sends every candidate target profile it
// wants a verdict for in one round trip, so the SAME call serves both a
// single pre-submit check (a one-element array) and the profile picker's
// per-row admission (many elements) without a second wire method.
export const validateTuiForkProfileRequestSchema = z.object({
  epicId: z.string(),
  sourceTuiAgentId: z.string(),
  targetProfileIds: z.array(z.string().nullable()).min(1),
});
export type ValidateTuiForkProfileRequest = z.infer<
  typeof validateTuiForkProfileRequestSchema
>;

// Mirrors `TuiForkScopeGuardSubcode` in the host's `tui-fork-scope-guard.ts`
// (kept as an independent literal union here - the wire schema must not
// import host domain code), plus `TARGET_PROFILE_UNAVAILABLE` for a
// candidate-specific profile-lifecycle rejection (unknown/tombstoned/
// setup-pending/unsupported-provider) that is NOT a `TuiForkScopeGuardError` -
// the bulk resolver reshapes that error family into its own verdict row
// (amend-01, T3 review) rather than aborting the whole batch.
//
// `SOURCE_NOT_READY` (follow-up fix): a Claude source's `harnessSessionId` is
// minted synchronously at launch, before any turn writes its transcript to
// disk - `--resume <source> --fork-session` needs that transcript to exist,
// so forking a source with zero turns hard-fails the spawned CLI. Fires
// regardless of whether the target profile matches the source's own (a
// same-profile plain Fork is exactly the reachable repro), so it is asserted
// ahead of the scope-equality check rather than folded into a "profiles
// differ" branch.
export const tuiForkProfileAdmissionSubcodeSchema = z.enum([
  "SCOPE_MISMATCH",
  "FORK_SOURCE_NOT_FOUND",
  "FORK_SOURCE_AMBIGUOUS",
  "TARGET_PROFILE_UNAVAILABLE",
  "SOURCE_NOT_READY",
]);
export type TuiForkProfileAdmissionSubcode = z.infer<
  typeof tuiForkProfileAdmissionSubcodeSchema
>;

// One verdict per requested `targetProfileId`, same order as the request.
// `subcode`/`message` are non-null only when `admitted` is false - the same
// subcode/message pair `TuiForkScopeGuardError` throws with, reshaped as data
// instead of an exception since the bulk picker needs N independent verdicts
// rather than a single throw.
export const tuiForkProfileAdmissionVerdictSchema = z.object({
  targetProfileId: z.string().nullable(),
  admitted: z.boolean(),
  subcode: tuiForkProfileAdmissionSubcodeSchema.nullable(),
  message: z.string().nullable(),
});
export type TuiForkProfileAdmissionVerdict = z.infer<
  typeof tuiForkProfileAdmissionVerdictSchema
>;

export const validateTuiForkProfileResponseSchema = z.object({
  verdicts: z.array(tuiForkProfileAdmissionVerdictSchema),
});
export type ValidateTuiForkProfileResponse = z.infer<
  typeof validateTuiForkProfileResponseSchema
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

// ─── `agent.tui.promptSubmitted@1.0` - prompt-submit activity + roles pull ─
//
// New optional unary method (roles-snapshot-delivery pull point 1): the
// `UserPromptSubmit` hook chain's one call, replacing the start-edge
// `recordActivity` call for peers that support it. Request shape mirrors the
// `recordActivity@1.1` prompt-submit payload (epicId, tuiAgentId,
// harnessSessionId, harnessId, observedHarnessSessionId) - same fields, same
// resync semantics on `observedHarnessSessionId` - but drops `event` (this
// method IS the start/prompt-submit edge, never stop/resync).
//
// Adding a response field to unary `recordActivity` would be a breaking
// change (new major + bridges); this new method is the sanctioned
// evolution instead. Host side: record the activity edge, then run the
// role-registry digest-cursor check (`lastDeliveredRolesDigest`) - behind
// renders the snapshot and stamps the new digest; current returns `null`.
// Degrade story: method absent on an older host, or an older CLI against a
// newer host, both fall back to plain `recordActivity` - roles then only
// reachable via the static prompt's `role list` instruction.

export const tuiAgentPromptSubmittedRequestSchema = z.object({
  epicId: z.string().nullable().default(null),
  tuiAgentId: z.string().nullable().default(null),
  harnessSessionId: z.string().nullable().default(null),
  harnessId: tuiHarnessIdSchema,
  observedHarnessSessionId: z.string().nullable().default(null),
});
export type TuiAgentPromptSubmittedRequest = z.infer<
  typeof tuiAgentPromptSubmittedRequestSchema
>;

/**
 * `agent.tui.promptSubmitted@1.1` - optional submit-time workspace-binding
 * intent, same `worktreeIntent` shape the rebind mutations (`worktree.create`
 * folder intents) already use and that `chat.subscribe` `send` /
 * `editUserMessage` already carry. Applied at commit per W5; absent/`null`
 * ⇒ binding-as-stored (today).
 *
 * Degrade: a 1.0 host's request schema strips `worktreeIntent`, so an old
 * host keeps binding-as-stored. A 1.0 client talking to a 1.1 host is
 * upgraded with `worktreeIntent: null`. The method stays
 * `degrade: unsupported` on the floor — absence of the method itself still
 * falls back to `recordActivity`.
 */
export const tuiAgentPromptSubmittedRequestSchemaV11 =
  tuiAgentPromptSubmittedRequestSchema.extend({
    // Optional (not defaulted) so a 1.0-shaped constructor — the CLI hook
    // that predates this field — remains assignable to the latest request
    // type. Absent/undefined/`null` all mean binding-as-stored.
    worktreeIntent: worktreeIntentSchema.nullable().optional(),
  });
export type TuiAgentPromptSubmittedRequestV11 = z.infer<
  typeof tuiAgentPromptSubmittedRequestSchemaV11
>;

export const tuiAgentPromptSubmittedResponseSchema = z.object({
  // Mirrors `recordActivity`'s `accepted` semantics: true when the resolver
  // recorded the activity edge; false for a benign no-op (record missing,
  // ownership/harness mismatch).
  accepted: z.boolean(),
  // Non-null only when the agent's `lastDeliveredRolesDigest` cursor was
  // behind the current claims registry at call time: a rendered snapshot
  // block for the CLI hook to emit as the `UserPromptSubmit`
  // `additionalContext` envelope. `null` when current (nothing to deliver)
  // or on a benign no-op.
  pendingPromptContext: z.string().nullable(),
});
export type TuiAgentPromptSubmittedResponse = z.infer<
  typeof tuiAgentPromptSubmittedResponseSchema
>;
