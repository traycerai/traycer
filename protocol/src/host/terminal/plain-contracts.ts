import {
  defineRpcContract,
  type SchemaVersion,
} from "@traycer/protocol/framework/index";
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

export type PlainTerminalFamilyCapability =
  | { readonly status: "unknown" }
  | { readonly status: "unsupported" }
  | {
      readonly status: "capable";
      readonly schemaVersion: typeof PLAIN_TERMINAL_FAMILY_VERSION;
    };

/**
 * Resolves the optional family as a unit. A partial, v1, or mixed v1/v2
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
  for (const method of PLAIN_TERMINAL_FAMILY_METHODS) {
    const version = input.versionFor(method);
    if (
      version === null ||
      version.major !== PLAIN_TERMINAL_FAMILY_VERSION.major ||
      version.minor !== PLAIN_TERMINAL_FAMILY_VERSION.minor
    ) {
      return { status: "unsupported" };
    }
  }
  return {
    status: "capable",
    schemaVersion: PLAIN_TERMINAL_FAMILY_VERSION,
  };
}

// Unreleased family: staging app and hosts move together onto v2.1. The
// runtime `unknown` state was added before release, so the incomplete 2.0
// draft is deliberately not registered or bridged. There is no mixed-family
// line and no downgrade into either 2.0 or the superseded 1.0 shapes.
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
