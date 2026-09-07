import { z } from "zod";
import { agentModeSchema } from "./foundation";
import { worktreeBindingWorkspaceModeSchema } from "../../host/worktree-schemas";

/**
 * Per-Epic record describing a TUI agent session.
 * Title generation writes only while the title is still empty and `!isTitleEditedByUser`, so a non-empty title is itself the "already titled" marker and is never overwritten.
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
  // Which of the harness's logged-in profiles (subscriptions) this agent runs on.
  profileId: z.string().nullable().default(null).catch(null),
  // Wall-clock ms when this terminal-agent session was archived, or `null` while active.
  archivedAt: z.number().nullable().default(null),
  // Durable native-fork provenance: the SOURCE harness session id an `agent.fork`-created record must resume-and-fork from on its FIRST real launch (headless A2A send or GUI open), since the fork service persists this.
  // Retained across a spawn/provider failure (no transcript yet) so a retry always re-forks instead of silently starting fresh.
  pendingForkSourceHarnessSessionId: z
    .string()
    .nullable()
    .default(null)
    .catch(null),
  // The user-facing provider handle, pinned once and rendered from this record forever (see the prompt-freeze decision log).
  // Defaulted (not just nullable) so an absent key still parses.
  pinnedUserProviderHandle: z.string().nullable().default(null).catch(null),
  // Digest cursor for the role-registry delivery channel (see roles-snapshot-delivery): the hash of the canonically-serialized claims last delivered to this agent.
  // Unlike `pinnedUserProviderHandle`, an absent key and an explicit `null` are equivalent here - both read as "never delivered" (a brand-new agent, or a record persisted before this field existed).
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
  // Codex app-server thread id captured from `thread/started`.
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

// Reserved for backward compatibility with the previously released persisted union and for planned Cursor TUI support.
// Current runtime catalogs do not advertise this surface, so normal product flows do not create these records.
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
