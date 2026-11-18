import type { AgentWorktreeCreatePolicy } from "@traycer/protocol/config/schema";
import { readWorktreesConfigSync } from "@traycer/protocol/config/store";
import { cliError, CLI_ERROR_CODES, type CliError } from "./runner/errors";

/**
 * How the user's Agent worktrees setting (Settings > Worktrees > Agent
 * worktrees: Allow / Ask first / Never) applies to `traycer worktree create`.
 *
 * The setting governs worktrees AGENTS create. An agent has two Traycer ways
 * to ask for one: the `traycer_create_worktree` tool, which the host gates,
 * and this command, typed in its own shell, which goes straight to the same
 * RPC a person's request does. So the command follows the setting whenever it
 * runs inside an agent session, and is untouched when a person types it.
 *
 * `ask` is refused as well as `never`: the question is put to the user through
 * the agent's chat, which a CLI process has no handle on. That is the same
 * outcome a terminal agent gets from the tool, and the refusal names the tool
 * for a session that does have it.
 *
 * WHAT THIS IS, AND IS NOT. Like `AgentCliSurface`, the signal is a variable in
 * the session's own environment (`TRAYCER_AGENT_ID`, set by the host on every
 * agent spawn), so it holds for an agent that does not go out of its way and is
 * not an authorization boundary against one that clears it. A plain
 * `git worktree add` is out of reach of either.
 *
 * A leaf module, like `agent-surface.ts`, so a command can import the predicate
 * without pulling in the program builder.
 */
export const WORKTREE_CREATE_COMMAND_PATH = "worktree create";

const STAY_IN_WORKSPACE =
  "Keep working in your current workspace, and don't create a worktree any other way (such as `git worktree add`).";

export function readAgentWorktreeCreatePolicy(): AgentWorktreeCreatePolicy {
  return readWorktreesConfigSync().agentCreate;
}

/** Whether this process was started inside an agent's session. */
export function isAgentSession(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const agentId = env.TRAYCER_AGENT_ID;
  return agentId !== undefined && agentId.trim().length > 0;
}

/**
 * The policy that governs this invocation, or `null` when a person is typing
 * and none does. `readPolicy` is only called for an agent session, so a
 * person's command never depends on the config file being readable.
 */
export function agentWorktreeCreatePolicyFor(
  env: Readonly<Record<string, string | undefined>>,
  readPolicy: () => AgentWorktreeCreatePolicy,
): AgentWorktreeCreatePolicy | null {
  return isAgentSession(env) ? readPolicy() : null;
}

/**
 * Whether help and hints may point at `traycer worktree create`. False only
 * for an agent session under `never`, where the command is hidden: text that
 * sends an agent to a command it is refused is worse than not mentioning it.
 */
export function agentWorktreeCreateOffered(
  env: Readonly<Record<string, string | undefined>>,
  readPolicy: () => AgentWorktreeCreatePolicy,
): boolean {
  return agentWorktreeCreatePolicyFor(env, readPolicy) !== "never";
}

export function agentWorktreeCreateRefusal(policy: "ask" | "never"): CliError {
  return cliError({
    code: CLI_ERROR_CODES.FORBIDDEN,
    message:
      policy === "never"
        ? `traycer: ${WORKTREE_CREATE_COMMAND_PATH} is turned off for agents on this host (Settings > Worktrees > Agent worktrees). ${STAY_IN_WORKSPACE}`
        : `traycer: ${WORKTREE_CREATE_COMMAND_PATH} needs the user's approval on this host (Settings > Worktrees > Agent worktrees), and this command cannot ask them. If you have the traycer_create_worktree tool, use it instead: it asks. Otherwise keep working in your current workspace, and don't create a worktree any other way (such as \`git worktree add\`).`,
    details: null,
    exitCode: 1,
  });
}

/**
 * The check itself, run by `withRunner` beside the readonly-surface check and
 * for the same reason: hiding a command is presentation only, and an agent
 * that types it anyway still reaches the action. A no-op for every other
 * command, for a person, and under `allow`.
 */
export function assertAgentWorktreeCreateAllowed(
  commandPath: string,
  env: Readonly<Record<string, string | undefined>>,
  readPolicy: () => AgentWorktreeCreatePolicy,
): void {
  if (commandPath !== WORKTREE_CREATE_COMMAND_PATH) return;
  const policy = agentWorktreeCreatePolicyFor(env, readPolicy);
  if (policy === null || policy === "allow") return;
  throw agentWorktreeCreateRefusal(policy);
}
