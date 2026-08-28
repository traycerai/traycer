import { z } from "zod";
import { agentModeSchema } from "./foundation";
import { worktreeBindingWorkspaceModeSchema } from "../../host/worktree-schemas";

/**
 * Per-Epic record describing a TUI agent session. Stored in a separate
 * `tuiAgents` Y.Map (not in `chats`) so the gui chat schema stays focused
 * on UI-driven conversations and the renderer can dispatch tile renderers /
 * list views without needing to inspect a `surface` discriminator on every
 * chat.
 *
 * The record carries only metadata needed to resume the upstream harness
 * session in a PTY:
 *
 * - `harnessId` - discriminator that selects the SDK + CLI invocation,
 *   mirroring how `chatSessionAnchorSchema` discriminates per harness.
 * - `harnessSessionId` - the upstream harness's own session/thread id, which
 *   is the resume key fed back to the CLI. Claude and OpenCode allocate it
 *   synchronously when the session is created, so the field is always
 *   populated for those variants. Codex allocates the thread id only after
 *   its `app-server` emits `thread/started`, so the field is nullable on
 *   the codex variant and is back-filled by the host once discovered.
 * - `hostId` - device the session was minted on. TUI agents are bound to
 *   that host for life (see CLAUDE.md "tabs are bound to a host for
 *   life"); cross-device continuation is clone-not-migrate.
 * - `workspaceFolders` - multi-root array resolved at session-start time.
 * - `terminalAgentArgs` - optional per-agent CLI args override. `null` uses
 *   provider defaults; strings, including `""`, are used for this agent's
 *   launches.
 * - `terminalShellCommand` / `terminalShellArgs` - cached *computed* launch
 *   output from the last prepare (resolved argv, including dynamic
 *   resume/session/binding flags).
 *
 * The record stores an empty `title` ("no title yet") at create; the harness
 * label is a display-time fallback (`tuiAgentDisplayTitle`). Title generation
 * writes only while the title is still empty and `!isTitleEditedByUser`, so a
 * non-empty title is itself the "already titled" marker and is never
 * overwritten.
 *
 * No transcript fields: supported TUI transcripts are read from host-local
 * provider session history and are not part of the cloud-synced epic record.
 * Live terminal scrollback is a separate, ephemeral PTY concern.
 */

const baseTuiAgentFields = {
  id: z.string(),
  parentId: z.string().nullable(),
  title: z.string(),
  isTitleEditedByUser: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
  hostId: z.string(),
  userId: z.string(),
  workspaceFolders: z.array(z.string()),
  workspaceMode: worktreeBindingWorkspaceModeSchema.optional(),
  model: z.string().nullable(),
  reasoningEffort: z.string().nullable().default(null),
  agentMode: agentModeSchema,
  terminalAgentArgs: z.string().nullable().default(null).catch(null),
  terminalShellCommand: z.string().nullable().catch(null),
  terminalShellArgs: z.array(z.string()).nullable().catch(null),
  // Which of the harness's logged-in profiles (subscriptions) this agent
  // runs on. `null` = the ambient/host login, so records persisted before
  // profiles existed still parse cleanly. See the multi-profile decision log.
  profileId: z.string().nullable().default(null).catch(null),
  // Wall-clock ms when this terminal-agent session was archived, or `null`
  // while active. Same host-backed archive flag as `chatSchema.archivedAt`;
  // a single `epic.setChatArchived` RPC keyed by id covers chats and TUI
  // agents alike. Defaulted so records persisted before archiving existed
  // parse unchanged.
  archivedAt: z.number().nullable().default(null),
  // Durable native-fork provenance: the SOURCE harness session id an
  // `agent.fork`-created record must resume-and-fork from on its FIRST real
  // launch (headless A2A send or GUI open), since the fork service persists
  // this record before any provider fork actually runs - `terminalShellArgs`
  // above is only a cache of that prepare call, never executed. `null` for
  // an ordinary (non-fork) agent, and once again once the destination
  // session's provider transcript is observed to exist on disk - the
  // provider-observable signal that establishment happened, so a launch
  // path stops re-forking into an already-diverged session. Retained across
  // a spawn/provider failure (no transcript yet) so a retry always re-forks
  // instead of silently starting fresh. Additive/defaulted so records
  // persisted before this field existed still parse. See the durable-fork
  // decision log (tech plan governing mechanism 1).
  pendingForkSourceHarnessSessionId: z
    .string()
    .nullable()
    .default(null)
    .catch(null),
  // The user-facing provider handle, pinned once and rendered from this
  // record forever (see the prompt-freeze decision log). Tristate, and the
  // two "unset" states are NOT equivalent: ABSENT (the raw persisted key is
  // missing - records written before this field existed) means "not pinned
  // yet", read lazily and pinned on the next prompt build; an explicit
  // `null` means "resolve failed at creation" and is final - render no
  // handle sentence for this agent, permanently, never retried. A fork
  // copies the source record's value rather than re-resolving. Defaulted
  // (not just nullable) so an absent key still parses.
  pinnedUserProviderHandle: z.string().nullable().default(null).catch(null),
  // Digest cursor for the role-registry delivery channel (see
  // roles-snapshot-delivery): the hash of the canonically-serialized claims
  // last delivered to this agent. Unlike `pinnedUserProviderHandle`, an
  // absent key and an explicit `null` are equivalent here - both read as
  // "never delivered" (a brand-new agent, or a record persisted before this
  // field existed). Compared against the current registry's digest to
  // decide whether the next prompt pull owes a fresh snapshot. A third
  // value is possible: the host may stamp a reserved sentinel string that
  // can never equal a real content digest, meaning "a push was attempted
  // but not confirmed delivered" - the next pull must treat the cursor as
  // behind and deliver a fresh truth snapshot before stamping a clean
  // digest again. The sentinel's literal value is host-owned, not part of
  // this contract.
  lastDeliveredRolesDigest: z.string().nullable().default(null).catch(null),
} as const;

export const claudeTuiAgentSchema = z.object({
  harnessId: z.literal("claude"),
  ...baseTuiAgentFields,
  // SDK-minted via `unstable_v2_createSession`; CLI resumes it with
  // `claude --resume <harnessSessionId>`.
  harnessSessionId: z.string(),
});
export type ClaudeTuiAgent = z.infer<typeof claudeTuiAgentSchema>;

export const codexTuiAgentSchema = z.object({
  harnessId: z.literal("codex"),
  ...baseTuiAgentFields,
  // Codex app-server thread id captured from `thread/started`. Null until
  // the first run of the CLI hands the host a thread id; reattach then
  // starts a fresh app-server and launches `codex resume <harnessSessionId>
  // --remote`. The renderer keys per-tab adapter state off `id` (the
  // artifact id), so no separate Traycer-side stable key is needed.
  harnessSessionId: z.string().nullable().catch(null),
});
export type CodexTuiAgent = z.infer<typeof codexTuiAgentSchema>;

export const opencodeTuiAgentSchema = z.object({
  harnessId: z.literal("opencode"),
  ...baseTuiAgentFields,
  // SDK-minted via `client.session.create()`; ids are `ses_…`-prefixed.
  // CLI resumes it with `opencode --session <harnessSessionId>`.
  harnessSessionId: z.string(),
});
export type OpencodeTuiAgent = z.infer<typeof opencodeTuiAgentSchema>;

// Reserved for backward compatibility with the previously released persisted
// union and for planned Cursor TUI support. Current runtime catalogs do not
// advertise this surface, so normal product flows do not create these records.
export const cursorTuiAgentSchema = z.object({
  harnessId: z.literal("cursor"),
  ...baseTuiAgentFields,
  harnessSessionId: z.string().nullable().catch(null),
});
export type CursorTuiAgent = z.infer<typeof cursorTuiAgentSchema>;

export const tuiAgentSchema = z.discriminatedUnion("harnessId", [
  claudeTuiAgentSchema,
  codexTuiAgentSchema,
  opencodeTuiAgentSchema,
  cursorTuiAgentSchema,
]);
export type TuiAgent = z.infer<typeof tuiAgentSchema>;
