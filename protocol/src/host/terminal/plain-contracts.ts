import { defineRpcContract } from "@traycer/protocol/framework/index";
import {
  closePlainTerminalRequestSchema,
  closePlainTerminalResponseSchema,
  createPlainTerminalRequestSchema,
  createPlainTerminalResponseSchema,
  ensurePlainTerminalRunningRequestSchema,
  ensurePlainTerminalRunningResponseSchema,
  importLegacyPlainTerminalRequestSchema,
  importLegacyPlainTerminalResponseSchema,
  listPlainTerminalsRequestSchema,
  listPlainTerminalsResponseSchema,
  renamePlainTerminalRequestSchema,
  renamePlainTerminalResponseSchema,
} from "@traycer/protocol/host/terminal/plain-schemas";

// These initial contracts form a separate optional family so the released
// generic terminal contracts remain frozen for terminal-agent compatibility.
export const terminalPlainCreateV10 = defineRpcContract({
  method: "terminal.plain.create",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: createPlainTerminalRequestSchema,
  responseSchema: createPlainTerminalResponseSchema,
});

export const terminalPlainListV10 = defineRpcContract({
  method: "terminal.plain.list",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: listPlainTerminalsRequestSchema,
  responseSchema: listPlainTerminalsResponseSchema,
});

export const terminalPlainRenameV10 = defineRpcContract({
  method: "terminal.plain.rename",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: renamePlainTerminalRequestSchema,
  responseSchema: renamePlainTerminalResponseSchema,
});

export const terminalPlainEnsureRunningV10 = defineRpcContract({
  method: "terminal.plain.ensureRunning",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: ensurePlainTerminalRunningRequestSchema,
  responseSchema: ensurePlainTerminalRunningResponseSchema,
});

export const terminalPlainCloseV10 = defineRpcContract({
  method: "terminal.plain.close",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: closePlainTerminalRequestSchema,
  responseSchema: closePlainTerminalResponseSchema,
});

export const terminalPlainImportLegacyV10 = defineRpcContract({
  method: "terminal.plain.importLegacy",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: importLegacyPlainTerminalRequestSchema,
  responseSchema: importLegacyPlainTerminalResponseSchema,
});
