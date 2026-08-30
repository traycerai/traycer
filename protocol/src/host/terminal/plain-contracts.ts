import {
  defineContextualUpgradePath,
  defineDowngradePath,
  defineRpcContract,
  defineUpgradePath,
  type SchemaVersion,
} from "@traycer/protocol/framework/index";
import {
  closePlainTerminalRequestSchemaV10,
  closePlainTerminalResponseSchemaV10,
  createPlainTerminalRequestSchemaV10,
  createPlainTerminalResponseSchemaV10,
  ensurePlainTerminalRunningRequestSchemaV10,
  ensurePlainTerminalRunningResponseSchemaV10,
  importLegacyPlainTerminalRequestSchemaV10,
  importLegacyPlainTerminalResponseSchemaV10,
  listPlainTerminalsRequestSchemaV10,
  listPlainTerminalsResponseSchemaV10,
  renamePlainTerminalRequestSchemaV10,
  renamePlainTerminalResponseSchemaV10,
} from "@traycer/protocol/host/terminal/plain-v1-schemas";
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

export const PLAIN_TERMINAL_UNARY_METHODS = [
  "terminal.plain.create",
  "terminal.plain.list",
  "terminal.plain.rename",
  "terminal.plain.ensureRunning",
  "terminal.plain.close",
  "terminal.plain.importLegacy",
] as const;

export type PlainTerminalUnaryMethod =
  (typeof PLAIN_TERMINAL_UNARY_METHODS)[number];

export const PLAIN_TERMINAL_STREAM_METHODS = [
  "terminal.plain.subscribeList",
] as const;

export type PlainTerminalStreamMethod =
  (typeof PLAIN_TERMINAL_STREAM_METHODS)[number];

export const PLAIN_TERMINAL_FAMILY_METHODS = [
  ...PLAIN_TERMINAL_UNARY_METHODS,
  ...PLAIN_TERMINAL_STREAM_METHODS,
] as const;

export type PlainTerminalFamilyMethod =
  (typeof PLAIN_TERMINAL_FAMILY_METHODS)[number];

export const PLAIN_TERMINAL_FAMILY_VERSION = {
  major: 2,
  minor: 1,
} as const satisfies SchemaVersion;
export const PLAIN_TERMINAL_LOCAL_FAMILY_VERSION = {
  major: 1,
  minor: 0,
} as const satisfies SchemaVersion;

export type PlainTerminalFamilyCapability =
  | { readonly status: "unknown" }
  | { readonly status: "unsupported" }
  | {
      readonly status: "capable";
      readonly schemaVersion:
        | typeof PLAIN_TERMINAL_LOCAL_FAMILY_VERSION
        | typeof PLAIN_TERMINAL_FAMILY_VERSION;
      readonly topology: "local" | "fleet";
    };

/**
 * Resolves the optional family as a unit. A partial or mixed v1/v2
 * family is unsupported rather than a license to compose incompatible
 * semantics method by method.
 */
export function resolvePlainTerminalFamilyCapability(input: {
  readonly manifestKnown: boolean;
  readonly versionFor: (
    method: PlainTerminalFamilyMethod,
  ) => SchemaVersion | null;
}): PlainTerminalFamilyCapability {
  if (!input.manifestKnown) {
    return { status: "unknown" };
  }
  for (const candidate of [
    { version: PLAIN_TERMINAL_FAMILY_VERSION, topology: "fleet" as const },
    {
      version: PLAIN_TERMINAL_LOCAL_FAMILY_VERSION,
      topology: "local" as const,
    },
  ]) {
    let matches = true;
    for (const method of PLAIN_TERMINAL_FAMILY_METHODS) {
      const version = input.versionFor(method);
      if (
        version === null ||
        version.major !== candidate.version.major ||
        version.minor !== candidate.version.minor
      ) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return {
        status: "capable",
        schemaVersion: candidate.version,
        topology: candidate.topology,
      };
    }
  }
  return { status: "unsupported" };
}

// v1.0 shipped in desktop/host v1.2.0-rc.1 and remains frozen as the local-only
// durable line. v2.1 adds fleet replacement state and `unknown` runtime.
export const terminalPlainCreateV10 = defineRpcContract({
  method: "terminal.plain.create",
  schemaVersion: PLAIN_TERMINAL_LOCAL_FAMILY_VERSION,
  requestSchema: createPlainTerminalRequestSchemaV10,
  responseSchema: createPlainTerminalResponseSchemaV10,
});
export const terminalPlainListV10 = defineRpcContract({
  method: "terminal.plain.list",
  schemaVersion: PLAIN_TERMINAL_LOCAL_FAMILY_VERSION,
  requestSchema: listPlainTerminalsRequestSchemaV10,
  responseSchema: listPlainTerminalsResponseSchemaV10,
});
export const terminalPlainRenameV10 = defineRpcContract({
  method: "terminal.plain.rename",
  schemaVersion: PLAIN_TERMINAL_LOCAL_FAMILY_VERSION,
  requestSchema: renamePlainTerminalRequestSchemaV10,
  responseSchema: renamePlainTerminalResponseSchemaV10,
});
export const terminalPlainEnsureRunningV10 = defineRpcContract({
  method: "terminal.plain.ensureRunning",
  schemaVersion: PLAIN_TERMINAL_LOCAL_FAMILY_VERSION,
  requestSchema: ensurePlainTerminalRunningRequestSchemaV10,
  responseSchema: ensurePlainTerminalRunningResponseSchemaV10,
});
export const terminalPlainCloseV10 = defineRpcContract({
  method: "terminal.plain.close",
  schemaVersion: PLAIN_TERMINAL_LOCAL_FAMILY_VERSION,
  requestSchema: closePlainTerminalRequestSchemaV10,
  responseSchema: closePlainTerminalResponseSchemaV10,
});
export const terminalPlainImportLegacyV10 = defineRpcContract({
  method: "terminal.plain.importLegacy",
  schemaVersion: PLAIN_TERMINAL_LOCAL_FAMILY_VERSION,
  requestSchema: importLegacyPlainTerminalRequestSchemaV10,
  responseSchema: importLegacyPlainTerminalResponseSchemaV10,
});

export const terminalPlainCreateV21 = defineRpcContract({
  method: "terminal.plain.create",
  schemaVersion: { major: 2, minor: 1 } as const,
  requestSchema: createPlainTerminalRequestSchema,
  responseSchema: createPlainTerminalResponseSchema,
});

export const terminalPlainListV21 = defineRpcContract({
  method: "terminal.plain.list",
  schemaVersion: { major: 2, minor: 1 } as const,
  requestSchema: listPlainTerminalsRequestSchema,
  responseSchema: listPlainTerminalsResponseSchema,
});

export const terminalPlainRenameV21 = defineRpcContract({
  method: "terminal.plain.rename",
  schemaVersion: { major: 2, minor: 1 } as const,
  requestSchema: renamePlainTerminalRequestSchema,
  responseSchema: renamePlainTerminalResponseSchema,
});

export const terminalPlainEnsureRunningV21 = defineRpcContract({
  method: "terminal.plain.ensureRunning",
  schemaVersion: { major: 2, minor: 1 } as const,
  requestSchema: ensurePlainTerminalRunningRequestSchema,
  responseSchema: ensurePlainTerminalRunningResponseSchema,
});

export const terminalPlainCloseV21 = defineRpcContract({
  method: "terminal.plain.close",
  schemaVersion: { major: 2, minor: 1 } as const,
  requestSchema: closePlainTerminalRequestSchema,
  responseSchema: closePlainTerminalResponseSchema,
});

export const terminalPlainImportLegacyV21 = defineRpcContract({
  method: "terminal.plain.importLegacy",
  schemaVersion: { major: 2, minor: 1 } as const,
  requestSchema: importLegacyPlainTerminalRequestSchema,
  responseSchema: importLegacyPlainTerminalResponseSchema,
});

const runtimeUnavailableDowngrade = {
  code: "DOWNGRADE_UNSUPPORTED",
  message: "The terminal runtime is unavailable to this older app.",
} as const;

export const terminalPlainCreateUpgradeV10ToV21 = defineUpgradePath<
  typeof terminalPlainCreateV10,
  typeof terminalPlainCreateV21
>({
  from: terminalPlainCreateV10.schemaVersion,
  to: terminalPlainCreateV21.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});
export const terminalPlainCreateDowngradeV21ToV10 = defineDowngradePath<
  typeof terminalPlainCreateV21,
  typeof terminalPlainCreateV10
>({
  from: terminalPlainCreateV21.schemaVersion,
  to: terminalPlainCreateV10.schemaVersion,
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => {
    const parsed = createPlainTerminalResponseSchemaV10.safeParse(response);
    return parsed.success
      ? { ok: true, value: parsed.data }
      : { ok: false, error: runtimeUnavailableDowngrade };
  },
});

export const terminalPlainListUpgradeV10ToV21 = defineContextualUpgradePath<
  typeof terminalPlainListV10,
  typeof terminalPlainListV21
>({
  from: terminalPlainListV10.schemaVersion,
  to: terminalPlainListV21.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response, context) => {
    if (context === undefined) {
      throw new Error(
        "terminal.plain.list v1 responses require request context when upgraded to v2",
      );
    }
    if (context.request.scope.kind === "epic") {
      return {
        coverage: "partial-serving-host",
        scope: context.request.scope,
        servingHostId: context.hostId,
        terminals: response.terminals,
      };
    }
    return {
      coverage: "complete-local",
      scope: { kind: "independent" },
      terminals: response.terminals,
    };
  },
});
export const terminalPlainListDowngradeV21ToV10 = defineDowngradePath<
  typeof terminalPlainListV21,
  typeof terminalPlainListV10
>({
  from: terminalPlainListV21.schemaVersion,
  to: terminalPlainListV10.schemaVersion,
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => {
    if (response.coverage === "complete-fleet") {
      return { ok: false, error: runtimeUnavailableDowngrade };
    }
    const parsed = listPlainTerminalsResponseSchemaV10.safeParse({
      terminals: response.terminals,
    });
    return parsed.success
      ? { ok: true, value: parsed.data }
      : { ok: false, error: runtimeUnavailableDowngrade };
  },
});

export const terminalPlainRenameUpgradeV10ToV21 = defineUpgradePath<
  typeof terminalPlainRenameV10,
  typeof terminalPlainRenameV21
>({
  from: terminalPlainRenameV10.schemaVersion,
  to: terminalPlainRenameV21.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});
export const terminalPlainRenameDowngradeV21ToV10 = defineDowngradePath<
  typeof terminalPlainRenameV21,
  typeof terminalPlainRenameV10
>({
  from: terminalPlainRenameV21.schemaVersion,
  to: terminalPlainRenameV10.schemaVersion,
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => {
    const parsed = renamePlainTerminalResponseSchemaV10.safeParse(response);
    return parsed.success
      ? { ok: true, value: parsed.data }
      : { ok: false, error: runtimeUnavailableDowngrade };
  },
});
export const terminalPlainEnsureRunningUpgradeV10ToV21 = defineUpgradePath<
  typeof terminalPlainEnsureRunningV10,
  typeof terminalPlainEnsureRunningV21
>({
  from: terminalPlainEnsureRunningV10.schemaVersion,
  to: terminalPlainEnsureRunningV21.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});
export const terminalPlainEnsureRunningDowngradeV21ToV10 = defineDowngradePath<
  typeof terminalPlainEnsureRunningV21,
  typeof terminalPlainEnsureRunningV10
>({
  from: terminalPlainEnsureRunningV21.schemaVersion,
  to: terminalPlainEnsureRunningV10.schemaVersion,
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => {
    const parsed =
      ensurePlainTerminalRunningResponseSchemaV10.safeParse(response);
    return parsed.success
      ? { ok: true, value: parsed.data }
      : { ok: false, error: runtimeUnavailableDowngrade };
  },
});
export const terminalPlainCloseUpgradeV10ToV21 = defineUpgradePath<
  typeof terminalPlainCloseV10,
  typeof terminalPlainCloseV21
>({
  from: terminalPlainCloseV10.schemaVersion,
  to: terminalPlainCloseV21.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});
export const terminalPlainCloseDowngradeV21ToV10 = defineDowngradePath<
  typeof terminalPlainCloseV21,
  typeof terminalPlainCloseV10
>({
  from: terminalPlainCloseV21.schemaVersion,
  to: terminalPlainCloseV10.schemaVersion,
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => ({ ok: true, value: response }),
});
export const terminalPlainImportLegacyUpgradeV10ToV21 = defineUpgradePath<
  typeof terminalPlainImportLegacyV10,
  typeof terminalPlainImportLegacyV21
>({
  from: terminalPlainImportLegacyV10.schemaVersion,
  to: terminalPlainImportLegacyV21.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});
export const terminalPlainImportLegacyDowngradeV21ToV10 = defineDowngradePath<
  typeof terminalPlainImportLegacyV21,
  typeof terminalPlainImportLegacyV10
>({
  from: terminalPlainImportLegacyV21.schemaVersion,
  to: terminalPlainImportLegacyV10.schemaVersion,
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => {
    if (response.status === "deleted") {
      return { ok: true, value: response };
    }
    const parsed =
      importLegacyPlainTerminalResponseSchemaV10.safeParse(response);
    return parsed.success
      ? { ok: true, value: parsed.data }
      : { ok: false, error: runtimeUnavailableDowngrade };
  },
});
