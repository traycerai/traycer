import { defineRpcContract } from "@traycer/protocol/framework/index";
import {
  configEnvDeleteRequestSchema,
  configEnvDeleteResponseSchema,
  configEnvListRequestSchema,
  configEnvListResponseSchema,
  configEnvSetRequestSchema,
  configEnvSetResponseSchema,
  configLogLevelsGetRequestSchema,
  configLogLevelsResponseSchema,
  configLogLevelsSetRequestSchema,
  configLogLevelsSetResponseSchema,
  configShellAddRequestSchema,
  configShellAddResponseSchema,
  configShellGetRequestSchema,
  configShellGetResponseSchema,
  configShellListDetectedRequestSchema,
  configShellListDetectedResponseSchema,
  configShellProbeRequestSchema,
  configShellProbeResponseSchema,
  configShellRemoveRequestSchema,
  configShellRemoveResponseSchema,
  configShellResetRequestSchema,
  configShellResetResponseSchema,
  configShellRevertArgsRequestSchema,
  configShellRevertArgsResponseSchema,
  configShellSetRequestSchema,
  configShellSetResponseSchema,
} from "./schemas";

/** Machine-user-global shell configuration; never host-slot scoped. */
export const configShellGetV10 = defineRpcContract({
  method: "config.shell.get",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: configShellGetRequestSchema,
  responseSchema: configShellGetResponseSchema,
});

export const configShellSetV10 = defineRpcContract({
  method: "config.shell.set",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: configShellSetRequestSchema,
  responseSchema: configShellSetResponseSchema,
});

export const configShellResetV10 = defineRpcContract({
  method: "config.shell.reset",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: configShellResetRequestSchema,
  responseSchema: configShellResetResponseSchema,
});

export const configShellAddV10 = defineRpcContract({
  method: "config.shell.add",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: configShellAddRequestSchema,
  responseSchema: configShellAddResponseSchema,
});

export const configShellRemoveV10 = defineRpcContract({
  method: "config.shell.remove",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: configShellRemoveRequestSchema,
  responseSchema: configShellRemoveResponseSchema,
});

export const configShellRevertArgsV10 = defineRpcContract({
  method: "config.shell.revertArgs",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: configShellRevertArgsRequestSchema,
  responseSchema: configShellRevertArgsResponseSchema,
});

/** Shell discovery runs against the connected host's own filesystem. */
export const configShellListDetectedV10 = defineRpcContract({
  method: "config.shell.listDetected",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: configShellListDetectedRequestSchema,
  responseSchema: configShellListDetectedResponseSchema,
});

/** Shell executable probing runs against the connected host's filesystem. */
export const configShellProbeV10 = defineRpcContract({
  method: "config.shell.probe",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: configShellProbeRequestSchema,
  responseSchema: configShellProbeResponseSchema,
});

/** Machine-user-global host-process environment overrides. */
export const configEnvListV10 = defineRpcContract({
  method: "config.env.list",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: configEnvListRequestSchema,
  responseSchema: configEnvListResponseSchema,
});

export const configEnvSetV10 = defineRpcContract({
  method: "config.env.set",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: configEnvSetRequestSchema,
  responseSchema: configEnvSetResponseSchema,
});

export const configEnvDeleteV10 = defineRpcContract({
  method: "config.env.delete",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: configEnvDeleteRequestSchema,
  responseSchema: configEnvDeleteResponseSchema,
});

/** Reads machine-user-global CLI and host log thresholds; desktop is local-only. */
export const configLogLevelsGetV10 = defineRpcContract({
  method: "config.logLevels.get",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: configLogLevelsGetRequestSchema,
  responseSchema: configLogLevelsResponseSchema,
});

/** Writes one machine-user-global CLI or host log threshold; no desktop scope. */
export const configLogLevelsSetV10 = defineRpcContract({
  method: "config.logLevels.set",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: configLogLevelsSetRequestSchema,
  responseSchema: configLogLevelsSetResponseSchema,
});
