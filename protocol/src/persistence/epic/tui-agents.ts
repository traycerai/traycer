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
 * No transcript fields: TUI scrollback lives in the host's PTY buffer and
 * is not part of the cloud-synced epic record.
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

export const cursorTuiAgentSchema = z.object({
  harnessId: z.literal("cursor"),
  ...baseTuiAgentFields,
  // The chat id minted by `cursor-agent create-chat` and resumed with
  // `cursor-agent --resume <id>`. Minting is synchronous but can fail
  // (offline/unauthenticated); null then means "no chat yet - re-mint on the
  // next launch" rather than persisting a bogus, non-resumable id.
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
