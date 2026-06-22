import { worktreeListBindingsForEpicResponseSchema } from "@traycer/protocol/host";
import {
  callHostRpc,
  parseHostResponse,
  toAgentCliError,
} from "../internal/host-rpc";
import { resolveEpicId } from "../internal/agent-context";
import type { CommandFn } from "../runner/runner";

export function buildWorkspaceListCommand(opts: {
  readonly epicId: string | null;
}): CommandFn {
  return async () => {
    const epicId = resolveEpicId(opts.epicId);
    const result = await toAgentCliError(
      callHostRpc("worktree.listBindingsForEpic", { epicId }),
    );
    const parsed = parseHostResponse(
      worktreeListBindingsForEpicResponseSchema,
      result,
    );
    return {
      data: parsed,
      human: JSON.stringify(parsed, null, 2),
      exitCode: 0,
    };
  };
}
