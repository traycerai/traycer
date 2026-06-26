import type { CommandFn, CommandResult } from "../runner/runner";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import { readonlyEnv } from "../runner/runtime";
import { resolveCliVersion } from "../cli-version";
import { callHostRpcFastFail } from "../internal/host-rpc";
import {
  clearTemporaryDiagnosticsLogLevelScope,
  EMPTY_DIAGNOSTICS_PATCH,
  isDiagnosticLogLevel,
  isHostDiagnosticLogLevel,
  patchDiagnosticsConfig,
  placeholderDiagnosticsStatus,
  readDiagnosticsRaw,
  resetDiagnosticsConfig,
  resolveDiagnosticsEffective,
  type DiagnosticLogLevel,
  type DiagnosticsEffectiveConfig,
  type DiagnosticsRawConfig,
  type DiagnosticsStatus,
  type DiagnosticsTemporaryScope,
  type HostDiagnosticLogLevel,
} from "../store/config-store";

const DEBUG_DEFAULT_DURATION_MS = 30 * 60 * 1000;
const TRACE_DEFAULT_DURATION_MS = 10 * 60 * 1000;
const DEBUG_MAX_DURATION_MS = 2 * 60 * 60 * 1000;
const TRACE_MAX_DURATION_MS = 30 * 60 * 1000;

export interface ConfigDiagnosticsSetArgs {
  readonly level: string | null;
  readonly hostLevel: string | null;
}

export interface ConfigDiagnosticsTemporaryArgs {
  readonly level: string | null;
  readonly hostLevel: string | null;
  readonly duration: string | null;
}

export interface ConfigDiagnosticsClearTemporaryArgs {
  readonly scope: string | null;
}

export interface DiagnosticsConfigSnapshot {
  readonly raw: DiagnosticsRawConfig;
  readonly effective: DiagnosticsEffectiveConfig;
  readonly hostStatus: DiagnosticsStatus;
  readonly cliVersion: string;
}

export const configDiagnosticsGetCommand: CommandFn = async (
  ctx,
): Promise<CommandResult> => {
  const snapshot = await readDiagnosticsConfigSnapshot(ctx.runtime.environment);
  return {
    data: snapshot,
    human: ctx.runtime.json ? null : renderSnapshot(snapshot),
    exitCode: 0,
  };
};

export function buildConfigDiagnosticsSetCommand(
  args: ConfigDiagnosticsSetArgs,
): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    const level = parseDiagnosticLevel(args.level, "--level");
    const hostLevel = parseHostDiagnosticLevel(args.hostLevel, "--host-level");
    if (level === null && hostLevel === null) {
      throw cliError({
        code: CLI_ERROR_CODES.CONFIG_INVALID_VALUE,
        message: "config diagnostics set: pass --level, --host-level, or both.",
        details: null,
        exitCode: 1,
      });
    }
    await patchDiagnosticsConfig({
      ...EMPTY_DIAGNOSTICS_PATCH,
      logLevel: level ?? undefined,
      hostLogLevel: hostLevel ?? undefined,
    });
    const snapshot = await readDiagnosticsConfigSnapshot(
      ctx.runtime.environment,
    );
    return {
      data: snapshot,
      human: ctx.runtime.json ? null : renderSetConfirmation(snapshot),
      exitCode: 0,
    };
  };
}

export function buildConfigDiagnosticsTemporaryCommand(
  args: ConfigDiagnosticsTemporaryArgs,
): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    const level = parseDiagnosticLevel(args.level, "--level");
    const hostLevel = parseHostDiagnosticLevel(args.hostLevel, "--host-level");
    if (level === null && hostLevel === null) {
      throw cliError({
        code: CLI_ERROR_CODES.CONFIG_INVALID_VALUE,
        message:
          "config diagnostics temporary: pass --level, --host-level, or both.",
        details: null,
        exitCode: 1,
      });
    }

    const durationMs = parseDurationMs(
      args.duration,
      maxDurationMs(level, hostLevel),
      defaultDurationMs(level, hostLevel),
    );
    const expiresAt = new Date(Date.now() + durationMs).toISOString();
    await patchDiagnosticsConfig({
      ...EMPTY_DIAGNOSTICS_PATCH,
      temporaryLogLevel:
        level === null ? undefined : { level, expiresAt, reason: "support" },
      temporaryHostLogLevel:
        hostLevel === null
          ? undefined
          : { level: hostLevel, expiresAt, reason: "support" },
    });

    const snapshot = await readDiagnosticsConfigSnapshot(
      ctx.runtime.environment,
    );
    return {
      data: snapshot,
      human: ctx.runtime.json
        ? null
        : `temporary diagnostics level saved; expires at ${expiresAt}\n\n${renderSnapshot(snapshot)}`,
      exitCode: 0,
    };
  };
}

export function buildConfigDiagnosticsClearTemporaryCommand(
  args: ConfigDiagnosticsClearTemporaryArgs,
): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    const scope = parseTemporaryScope(args.scope);
    await clearTemporaryDiagnosticsLogLevelScope(scope);
    const snapshot = await readDiagnosticsConfigSnapshot(
      ctx.runtime.environment,
    );
    return {
      data: snapshot,
      human: ctx.runtime.json
        ? null
        : `temporary diagnostics overrides cleared (${scope})\n\n${renderSnapshot(snapshot)}`,
      exitCode: 0,
    };
  };
}

export const configDiagnosticsResetCommand: CommandFn = async (
  ctx,
): Promise<CommandResult> => {
  await resetDiagnosticsConfig();
  const snapshot = await readDiagnosticsConfigSnapshot(ctx.runtime.environment);
  return {
    data: snapshot,
    human: ctx.runtime.json
      ? null
      : `diagnostics config reset\n\n${renderSnapshot(snapshot)}`,
    exitCode: 0,
  };
};

export async function readDiagnosticsConfigSnapshot(
  environment: string,
): Promise<DiagnosticsConfigSnapshot> {
  const raw = await readDiagnosticsRaw();
  return {
    raw,
    effective: resolveDiagnosticsEffective(raw, new Date()),
    hostStatus: await readHostDiagnosticsStatus(raw, environment),
    // The published binary is launched directly, not via `npm/bun run`, so
    // `npm_package_version` is unset; use the same release-injected
    // `TRAYCER_CLI_VERSION` source that `traycer --version` advertises so the
    // support bundle/manifest identify the real CLI build.
    cliVersion: resolveCliVersion(readonlyEnv()),
  };
}

async function readHostDiagnosticsStatus(
  raw: DiagnosticsRawConfig,
  environment: string,
): Promise<DiagnosticsStatus> {
  try {
    const status = await callHostRpcFastFail("host.status", {});
    return {
      ...status.diagnostics,
      activeSlot: status.diagnostics.activeSlot ?? environment,
    };
  } catch {
    return placeholderDiagnosticsStatus({
      supported: false,
      source: "unreachable",
      readStatus: raw.readStatus,
      configPath: raw.path,
      configMtimeMs: raw.mtimeMs,
      hostVersion: null,
      activeSlot: environment,
      logPath: null,
    });
  }
}

function parseDiagnosticLevel(
  value: string | null,
  label: string,
): DiagnosticLogLevel | null {
  if (value === null) return null;
  if (isDiagnosticLogLevel(value)) return value;
  throw cliError({
    code: CLI_ERROR_CODES.CONFIG_INVALID_VALUE,
    message: `config diagnostics: ${label} must be one of trace, debug, info, warn, error, off.`,
    details: { value },
    exitCode: 1,
  });
}

function parseHostDiagnosticLevel(
  value: string | null,
  label: string,
): HostDiagnosticLogLevel | null {
  if (value === null) return null;
  if (isHostDiagnosticLogLevel(value)) return value;
  throw cliError({
    code: CLI_ERROR_CODES.CONFIG_INVALID_VALUE,
    message: `config diagnostics: ${label} must be inherit, trace, debug, info, warn, error, or off.`,
    details: { value },
    exitCode: 1,
  });
}

function parseDurationMs(
  value: string | null,
  maxMs: number,
  fallbackMs: number,
): number {
  if (value === null) return fallbackMs;
  const match = /^([1-9][0-9]*)(m|h)$/.exec(value);
  if (match === null) {
    throw cliError({
      code: CLI_ERROR_CODES.CONFIG_INVALID_VALUE,
      message:
        "config diagnostics: --duration must use minutes or hours, e.g. 30m or 2h.",
      details: { value },
      exitCode: 1,
    });
  }
  const amount = Number(match[1]);
  const unit = match[2];
  const durationMs = amount * (unit === "h" ? 60 * 60 * 1000 : 60 * 1000);
  if (durationMs > maxMs) {
    throw cliError({
      code: CLI_ERROR_CODES.CONFIG_INVALID_VALUE,
      message: `config diagnostics: --duration exceeds maximum ${formatDuration(maxMs)} for the requested level.`,
      details: { value, maxMs },
      exitCode: 1,
    });
  }
  return durationMs;
}

function parseTemporaryScope(value: string | null): DiagnosticsTemporaryScope {
  if (value === null) return "all";
  if (value === "general" || value === "host" || value === "all") {
    return value;
  }
  throw cliError({
    code: CLI_ERROR_CODES.CONFIG_INVALID_VALUE,
    message:
      "config diagnostics: --scope must be one of general, host, or all.",
    details: { value },
    exitCode: 1,
  });
}

function defaultDurationMs(
  level: DiagnosticLogLevel | null,
  hostLevel: HostDiagnosticLogLevel | null,
): number {
  return level === "trace" || hostLevel === "trace"
    ? TRACE_DEFAULT_DURATION_MS
    : DEBUG_DEFAULT_DURATION_MS;
}

function maxDurationMs(
  level: DiagnosticLogLevel | null,
  hostLevel: HostDiagnosticLogLevel | null,
): number {
  return level === "trace" || hostLevel === "trace"
    ? TRACE_MAX_DURATION_MS
    : DEBUG_MAX_DURATION_MS;
}

function renderSetConfirmation(snapshot: DiagnosticsConfigSnapshot): string {
  return `diagnostics config saved\n\n${renderSnapshot(snapshot)}`;
}

function renderSnapshot(snapshot: DiagnosticsConfigSnapshot): string {
  const rows: string[] = [];
  rows.push(`config: ${snapshot.raw.path} (${snapshot.raw.readStatus})`);
  rows.push(`cli version: ${snapshot.cliVersion}`);
  rows.push(
    `configured general: ${renderConfiguredValue(snapshot.raw.raw.logLevel)}`,
  );
  rows.push(
    `configured host: ${renderConfiguredValue(snapshot.raw.raw.hostLogLevel)}`,
  );
  rows.push(
    `general: ${snapshot.effective.general.level} (${snapshot.effective.general.source})`,
  );
  rows.push(
    `host: ${snapshot.effective.host.level} (${snapshot.effective.host.source})`,
  );
  if (snapshot.effective.general.expiresAt !== null) {
    rows.push(`general expires: ${snapshot.effective.general.expiresAt}`);
  }
  if (snapshot.effective.host.expiresAt !== null) {
    rows.push(`host expires: ${snapshot.effective.host.expiresAt}`);
  }
  rows.push(`running host: ${renderHostStatusLine(snapshot.hostStatus)}`);
  rows.push(`host version: ${renderNullable(snapshot.hostStatus.hostVersion)}`);
  rows.push(
    `host active slot: ${renderNullable(snapshot.hostStatus.activeSlot)}`,
  );
  rows.push(`host log path: ${renderNullable(snapshot.hostStatus.logPath)}`);
  rows.push(`host restart required: ${snapshot.hostStatus.restartRequired}`);
  rows.push(
    `config mtime: ${renderNullableNumber(snapshot.hostStatus.configMtimeMs)}`,
  );
  rows.push(
    `host applied mtime: ${renderNullableNumber(snapshot.hostStatus.appliedConfigMtimeMs)}`,
  );
  return rows.join("\n");
}

function renderHostStatusLine(status: DiagnosticsStatus): string {
  if (!status.supported) {
    return status.source === "unreachable" ? "unreachable" : "unsupported";
  }
  const applied =
    status.appliedConfigMtimeMs === null
      ? "not confirmed"
      : `applied ${status.effectiveLevel ?? "unknown"}`;
  return `${applied} (${status.source})`;
}

function renderConfiguredValue(value: unknown): string {
  if (value === undefined) return "unset";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function renderNullable(value: string | null): string {
  return value ?? "unknown";
}

function renderNullableNumber(value: number | null): string {
  return value === null ? "unknown" : String(value);
}

function formatDuration(ms: number): string {
  if (ms % (60 * 60 * 1000) === 0) {
    return `${ms / (60 * 60 * 1000)}h`;
  }
  return `${ms / (60 * 1000)}m`;
}
