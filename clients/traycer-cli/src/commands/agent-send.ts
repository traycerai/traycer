import path from "node:path";
import {
  sendAgentMessageRequestSchemaV11,
  sendAgentMessageResponseSchema,
} from "@traycer/protocol/host/agent/shared";
import {
  callHostRpcWithDispatch,
  parseCanonicalHostResponse,
  parseUserInput,
  PLAIN_DISPATCH,
  toAgentCliError,
  type HostRpcDispatch,
} from "../internal/host-rpc";
import { resolveEpicId, resolveSenderAgentId } from "../internal/agent-context";
import { cliError, CliError, CLI_ERROR_CODES } from "../runner/errors";
import type { CommandFn } from "../runner/runner";

/**
 * `--workspace` rides `agent.sendMessage@1.1`. Below it the field is stripped
 * and the host acts on what is left - a send with no folder - so a send that
 * names one requires 1.1, and an older host refuses it before anything is
 * sent ("update the host").
 */
const WORKSPACE_SEND_DISPATCH: HostRpcDispatch = {
  ...PLAIN_DISPATCH,
  requiredHostMethodVersion: {
    method: "agent.sendMessage",
    version: { major: 1, minor: 1 },
  },
};

/**
 * `traycer agent send` - hand a prompt to another agent
 * (`agent.sendMessage`).
 *
 *   - `--expect-reply` opens (or reuses) a thread keyed on the
 *     (sender, receiver) pair; the host returns a `responseId` identifying
 *     that outgoing thread for follow-ups from this sender.
 *   - `--response-id <id>` on a send with `--expect-reply` omitted answers a
 *     request received from that recipient. It is not the outgoing thread ID
 *     returned by your own `--expect-reply` send; omit it on your own
 *     follow-ups. Omit both for a one-shot, no-reply message.
 *   - `--workspace <path>` names the folder, on the receiving agent's host, for
 *     a receiver that has no workspace yet. It is ignored when the receiver
 *     already has one.
 */
export function buildAgentSendCommand(opts: {
  readonly epicId: string | null;
  readonly senderAgentId: string | null;
  readonly to: string;
  readonly message: string;
  readonly expectReply: boolean;
  readonly responseId: string | null;
  readonly workspace: string | null;
}): CommandFn {
  return async () => {
    const workspace =
      opts.workspace === null ? null : requireWorkspacePath(opts.workspace);
    const request = parseUserInput(sendAgentMessageRequestSchemaV11, {
      senderAgentId: resolveSenderAgentId(opts.senderAgentId),
      epicId: resolveEpicId(opts.epicId),
      receiverAgentId: opts.to,
      prompt: opts.message,
      responseId: opts.responseId,
      expectReply: opts.expectReply,
      workspace,
    });
    const result = await toAgentCliError(
      callHostRpcWithDispatch(
        "agent.sendMessage",
        request,
        workspace === null ? PLAIN_DISPATCH : WORKSPACE_SEND_DISPATCH,
      ),
    ).catch((error: unknown) => {
      throw withWorkspaceHint(error, workspace);
    });
    const { responseId } = parseCanonicalHostResponse(
      "agent.sendMessage",
      sendAgentMessageResponseSchema,
      result,
    );
    // Success means the host accepted the message, not that the receiver has
    // it: an agent on another host may be offline, and a same-host send gets
    // the same response, so the line claims neither "delivered" nor "queued".
    const human =
      responseId === null
        ? `Message accepted for ${opts.to}`
        : `Message accepted for ${opts.to} (responseId: ${responseId})`;
    return { data: { responseId }, human, exitCode: 0 };
  };
}

/**
 * A Windows path that names its drive (`C:\work`, `C:/work`) or a UNC share
 * (`\\server\share`). `path.win32.isAbsolute` also accepts `\work`, which is
 * rooted only on whatever drive the receiving process happens to be on.
 */
const WINDOWS_FULLY_QUALIFIED = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/;

/**
 * The folder is on the RECEIVING agent's host, which may run another
 * platform, so it is checked as absolute in either form and passed through
 * as written rather than resolved against this machine. A Windows path must
 * name its drive or share, so its meaning cannot depend on the receiver's
 * current drive. Nothing is trimmed: a folder name may end in whitespace, and
 * a blank or space-led value is simply not absolute.
 */
function requireWorkspacePath(rawPath: string): string {
  if (
    !(path.posix.isAbsolute(rawPath) || WINDOWS_FULLY_QUALIFIED.test(rawPath))
  ) {
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message:
        "agent send: --workspace must be an absolute path to a folder on the receiving agent's host.",
      details: { value: rawPath },
      exitCode: 1,
    });
  }
  return rawPath;
}

/**
 * The receiver has no folder to run in. The host's refusal says so; on this
 * command the person can fix it, so say how.
 */
function withWorkspaceHint(error: unknown, workspace: string | null): unknown {
  if (
    !(error instanceof CliError) ||
    error.code !== CLI_ERROR_CODES.WORKSPACE_BINDING_REQUIRED
  ) {
    return error;
  }
  const hint =
    workspace === null
      ? "Pass --workspace <path> to choose the folder it runs in on its host."
      : "Check that the --workspace folder exists on the receiving agent's host.";
  return cliError({
    code: CLI_ERROR_CODES.WORKSPACE_BINDING_REQUIRED,
    message: `${error.message} ${hint}`,
    details: error.details,
    exitCode: error.exitCode,
  });
}
