export const DIAGNOSTICS_CONFIG_VERSION = 1;

export const DIAGNOSTIC_LOG_LEVELS = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "off",
] as const;

export const HOST_DIAGNOSTIC_LOG_LEVELS = [
  "inherit",
  ...DIAGNOSTIC_LOG_LEVELS,
] as const;

export type DiagnosticLogLevel = (typeof DIAGNOSTIC_LOG_LEVELS)[number];
export type HostDiagnosticLogLevel =
  (typeof HOST_DIAGNOSTIC_LOG_LEVELS)[number];

export type DiagnosticsReadStatus = "ok" | "missing" | "corrupt";
export type DiagnosticsTemporaryScope = "general" | "host" | "all";

export type DiagnosticsEffectiveSource =
  | "temporary"
  | "temporary-inherited"
  | "permanent"
  | "permanent-inherited"
  | "default"
  | "unsupported-raw"
  | "invalid-raw"
  | "expired-ignored";

export type DiagnosticsStatusSource =
  | DiagnosticsEffectiveSource
  | "unsupported"
  | "unreachable"
  | "restart-required";

export interface TemporaryDiagnosticLogLevel {
  readonly level: DiagnosticLogLevel;
  readonly expiresAt: string;
  readonly reason: string | undefined;
}

export interface TemporaryHostDiagnosticLogLevel {
  readonly level: HostDiagnosticLogLevel;
  readonly expiresAt: string;
  readonly reason: string | undefined;
}

export interface DiagnosticsConfigV1 {
  readonly version: 1;
  readonly logLevel: DiagnosticLogLevel | undefined;
  readonly hostLogLevel: HostDiagnosticLogLevel | undefined;
  readonly temporaryLogLevel: TemporaryDiagnosticLogLevel | null | undefined;
  readonly temporaryHostLogLevel:
    | TemporaryHostDiagnosticLogLevel
    | null
    | undefined;
}

export interface DiagnosticsRawConfig {
  readonly raw: Record<string, unknown>;
  readonly readStatus: DiagnosticsReadStatus;
  readonly path: string;
  readonly mtimeMs: number | null;
}

export interface DiagnosticsEffectiveScope<TLevel extends string> {
  readonly level: TLevel;
  readonly source: DiagnosticsEffectiveSource;
  readonly expiresAt: string | null;
  readonly configuredValue: unknown;
}

export interface DiagnosticsEffectiveConfig {
  readonly general: DiagnosticsEffectiveScope<DiagnosticLogLevel>;
  readonly host: DiagnosticsEffectiveScope<DiagnosticLogLevel>;
  readonly rawHostSetting: HostDiagnosticLogLevel | "unsupported" | "invalid";
}

export interface DiagnosticsWriteResult {
  readonly path: string;
  readonly mtimeMs: number;
  readonly rawPreserved: true;
}

export interface DiagnosticsStatus {
  readonly supported: boolean;
  readonly configuredLevel: DiagnosticLogLevel | HostDiagnosticLogLevel | null;
  readonly effectiveLevel: DiagnosticLogLevel | null;
  readonly source: DiagnosticsStatusSource;
  readonly readStatus: DiagnosticsReadStatus | null;
  readonly configPath: string;
  readonly configMtimeMs: number | null;
  readonly appliedConfigMtimeMs: number | null;
  readonly appliedAt: string | null;
  readonly expiresAt: string | null;
  readonly hostVersion: string | null;
  readonly activeSlot: string | null;
  readonly logPath: string | null;
  readonly restartRequired: boolean;
}

/**
 * Build a placeholder {@link DiagnosticsStatus} for the cases where a real
 * effective level is not (yet) known: the host that does not support the
 * field (`unsupported`), an unreachable host (`unreachable`), or the v1.0->v1.1
 * upgrade stub. Centralizes the 14-field shape so adding a field updates every
 * producer at once instead of drifting across the host, CLI, and desktop copies.
 */
export function placeholderDiagnosticsStatus(args: {
  readonly supported: boolean;
  readonly source: DiagnosticsStatusSource;
  readonly readStatus: DiagnosticsReadStatus | null;
  readonly configPath: string;
  readonly configMtimeMs: number | null;
  readonly hostVersion: string | null;
  readonly activeSlot: string | null;
  readonly logPath: string | null;
}): DiagnosticsStatus {
  return {
    supported: args.supported,
    configuredLevel: null,
    effectiveLevel: null,
    source: args.source,
    readStatus: args.readStatus,
    configPath: args.configPath,
    configMtimeMs: args.configMtimeMs,
    appliedConfigMtimeMs: null,
    appliedAt: null,
    expiresAt: null,
    hostVersion: args.hostVersion,
    activeSlot: args.activeSlot,
    logPath: args.logPath,
    restartRequired: false,
  };
}

export interface DiagnosticsPatch {
  readonly logLevel: DiagnosticLogLevel | undefined;
  readonly hostLogLevel: HostDiagnosticLogLevel | undefined;
  readonly temporaryLogLevel: TemporaryDiagnosticLogLevel | null | undefined;
  readonly temporaryHostLogLevel:
    | TemporaryHostDiagnosticLogLevel
    | null
    | undefined;
  readonly resetGeneral: boolean;
  readonly resetHost: boolean;
}

export const EMPTY_DIAGNOSTICS_PATCH: DiagnosticsPatch = {
  logLevel: undefined,
  hostLogLevel: undefined,
  temporaryLogLevel: undefined,
  temporaryHostLogLevel: undefined,
  resetGeneral: false,
  resetHost: false,
};

export function isDiagnosticLogLevel(
  value: unknown,
): value is DiagnosticLogLevel {
  return (
    typeof value === "string" &&
    DIAGNOSTIC_LOG_LEVELS.some((level) => level === value)
  );
}

export function isHostDiagnosticLogLevel(
  value: unknown,
): value is HostDiagnosticLogLevel {
  return (
    typeof value === "string" &&
    HOST_DIAGNOSTIC_LOG_LEVELS.some((level) => level === value)
  );
}

export function compareDiagnosticLogLevels(
  candidate: DiagnosticLogLevel,
  threshold: DiagnosticLogLevel,
): number {
  return logLevelRank(candidate) - logLevelRank(threshold);
}

function logLevelRank(level: DiagnosticLogLevel): number {
  switch (level) {
    case "trace":
      return 0;
    case "debug":
      return 1;
    case "info":
      return 2;
    case "warn":
      return 3;
    case "error":
      return 4;
    case "off":
      return 5;
  }
}
