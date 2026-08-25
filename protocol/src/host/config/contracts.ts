import {
  defineRpcContract,
  defineUpgradePath,
} from "@traycer/protocol/framework/index";
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
  configShellListDetectedResponseSchemaV10,
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
  responseSchema: configShellListDetectedResponseSchemaV10,
});

// v1.1 adds the optional `wslHealth` annotation to each row (a Windows
// wsl.exe that cannot host a terminal: the installer stub, or no registered
// distribution). Shipped as a minor rather than an in-place change to v1.0
// because cli-v1.2.0 released the v1.0 response shape: a released peer never
// sends the key, so it may only exist at a version that peer does not
// negotiate. The extra object key is strippable by the within-major skew
// handler, so a v1.1 host answering a v1.0 client drops it on the wire. See
// the RPC backward-compat decision log.
export const configShellListDetectedV11 = defineRpcContract({
  method: "config.shell.listDetected",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: configShellListDetectedRequestSchema,
  responseSchema: configShellListDetectedResponseSchema,
});

// The request is empty either way, and a v1.0 response is already a valid
// v1.1 response - `wslHealth` is optional and its absence means "no verdict",
// exactly what a host that never probed should express - so both upgrades are
// the identity.
export const configShellListDetectedUpgradeV10ToV11 = defineUpgradePath<
  typeof configShellListDetectedV10,
  typeof configShellListDetectedV11
>({
  from: configShellListDetectedV10.schemaVersion,
  to: configShellListDetectedV11.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
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
