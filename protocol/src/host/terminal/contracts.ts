import { defineRpcContract } from "@traycer/protocol/framework/index";
import {
  createTerminalRequestSchema,
  createTerminalResponseSchema,
  killTerminalRequestSchema,
  killTerminalResponseSchema,
  listTerminalsRequestSchema,
  listTerminalsResponseSchema,
  renameTerminalRequestSchema,
  renameTerminalResponseSchema,
  terminalDefaultCwdRequestSchema,
  terminalDefaultCwdResponseSchema,
} from "@traycer/protocol/host/terminal/unary-schemas";
import {
  terminalSubscribeV10,
  terminalSubscribeV11,
  terminalSubscribeV12,
  terminalSubscribeV13,
} from "@traycer/protocol/host/terminal/subscribe";

// Terminal sessions live entirely in the host's memory; these contracts
// expose the unary lifecycle (create/kill/list). The actual byte stream is
// carried by `terminal.subscribe` co-located in `./subscribe.ts`.
export const terminalCreateV10 = defineRpcContract({
  method: "terminal.create",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: createTerminalRequestSchema,
  responseSchema: createTerminalResponseSchema,
});

export const terminalKillV10 = defineRpcContract({
  method: "terminal.kill",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: killTerminalRequestSchema,
  responseSchema: killTerminalResponseSchema,
});

export const terminalDefaultCwdV10 = defineRpcContract({
  method: "terminal.defaultCwd",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: terminalDefaultCwdRequestSchema,
  responseSchema: terminalDefaultCwdResponseSchema,
});

export const terminalListV10 = defineRpcContract({
  method: "terminal.list",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: listTerminalsRequestSchema,
  responseSchema: listTerminalsResponseSchema,
});

export const terminalRenameV10 = defineRpcContract({
  method: "terminal.rename",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: renameTerminalRequestSchema,
  responseSchema: renameTerminalResponseSchema,
});

export {
  terminalSubscribeV10,
  terminalSubscribeV11,
  terminalSubscribeV12,
  terminalSubscribeV13,
};
