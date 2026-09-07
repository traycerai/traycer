import { formatTerminalOutputPointer } from "@traycer/protocol/host/terminal/output-format";
import { readTerminalOutputResponseSchema } from "@traycer/protocol/host/terminal/unary-schemas";
import {
  callHostRpc,
  parseCanonicalHostResponse,
  toAgentCliError,
} from "../internal/host-rpc";
import { resolveEpicId } from "../internal/agent-context";
import type { CommandFn } from "../runner/runner";

/** `traycer terminal output` - write one interactive terminal's output to a file on this host and print where it landed. Deliberately a POINTER, not the content: a terminal's scrollback is far larger than anything worth pushing through a command's stdout, and the caller is a coding agent that reads and greps files better than it reads a dump. */
export function buildTerminalOutputCommand(opts: {
  readonly epicId: string | null;
  readonly terminalId: string;
}): CommandFn {
  return async () => {
    const epicId = resolveEpicId(opts.epicId);
    const result = await toAgentCliError(
      callHostRpc("terminal.readOutput", {
        epicId,
        sessionId: opts.terminalId,
      }),
    );
    const { path } = parseCanonicalHostResponse(
      "terminal.readOutput",
      readTerminalOutputResponseSchema,
      result,
    );
    // The protocol owns the sentence, so an agent reads the same line whether
    // it came through this command or the injected `traycer_read_terminal`.
    return {
      data: { path },
      human: formatTerminalOutputPointer(path),
      exitCode: 0,
    };
  };
}
