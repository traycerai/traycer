import { z } from "zod";
import {
  defineRpcContract,
  defineUpgradePath,
} from "@traycer/protocol/framework/index";
import {
  DIAGNOSTIC_LOG_LEVELS,
  HOST_DIAGNOSTIC_LOG_LEVELS,
  placeholderDiagnosticsStatus,
  type DiagnosticsStatus,
} from "@traycer/protocol/config/diagnostics-schema";

const hostStatusRequestSchema = z.object({});

const hostStatusBaseResponseSchema = z.object({
  ready: z.boolean(),
  hostVersion: z.string(),
  protocolVersion: z.object({
    major: z.number().int().nonnegative(),
    minor: z.number().int().nonnegative(),
  }),
});

const diagnosticsStatusSourceSchema = z.enum([
  "temporary",
  "temporary-inherited",
  "permanent",
  "permanent-inherited",
  "default",
  "unsupported-raw",
  "invalid-raw",
  "expired-ignored",
  "unsupported",
  "unreachable",
  "restart-required",
]);

export const diagnosticsStatusSchema = z.object({
  supported: z.boolean(),
  configuredLevel: z.enum(HOST_DIAGNOSTIC_LOG_LEVELS).nullable(),
  effectiveLevel: z.enum(DIAGNOSTIC_LOG_LEVELS).nullable(),
  source: diagnosticsStatusSourceSchema,
  readStatus: z.enum(["ok", "missing", "corrupt"]).nullable(),
  configPath: z.string(),
  configMtimeMs: z.number().nullable(),
  appliedConfigMtimeMs: z.number().nullable(),
  appliedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  hostVersion: z.string().nullable(),
  activeSlot: z.string().nullable(),
  logPath: z.string().nullable(),
  restartRequired: z.boolean(),
}) satisfies z.ZodType<DiagnosticsStatus>;

export const hostStatusV10 = defineRpcContract({
  method: "host.status",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostStatusRequestSchema,
  responseSchema: hostStatusBaseResponseSchema,
});

export const hostStatusV11 = defineRpcContract({
  method: "host.status",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: hostStatusRequestSchema,
  responseSchema: hostStatusBaseResponseSchema.extend({
    diagnostics: diagnosticsStatusSchema,
  }),
});

export const hostStatusUpgradeV10ToV11 = defineUpgradePath<
  typeof hostStatusV10,
  typeof hostStatusV11
>({
  from: hostStatusV10.schemaVersion,
  to: hostStatusV11.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    ...response,
    diagnostics: placeholderDiagnosticsStatus({
      supported: false,
      source: "unsupported",
      readStatus: null,
      configPath: "",
      configMtimeMs: null,
      hostVersion: response.hostVersion,
      activeSlot: null,
      logPath: null,
    }),
  }),
});
