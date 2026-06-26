import { RunnerHostInvoke } from "../../ipc-contracts/ipc-channels";
import type { TraycerDiagnosticsConfigSnapshot } from "@traycer-clients/shared/platform/runner-host";
import {
  isDiagnosticLogLevel,
  isHostDiagnosticLogLevel,
  type DiagnosticLogLevel,
  type DiagnosticsTemporaryScope,
  type HostDiagnosticLogLevel,
} from "@traycer/protocol/config/diagnostics-schema";
import { refreshDesktopDiagnosticsLogLevel } from "../app/logger";
import { runTraycerCliJson } from "../cli/traycer-cli";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwnField(raw: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(raw, key);
}

function requireString(raw: unknown, key: string, channel: string): string {
  if (!isPlainObject(raw) || typeof raw[key] !== "string") {
    throw new Error(`${channel}: missing or non-string '${key}'`);
  }
  return raw[key];
}

function requireStringOrNull(
  raw: unknown,
  key: string,
  channel: string,
): string | null {
  if (!isPlainObject(raw)) {
    throw new Error(`${channel}: missing object payload`);
  }
  if (!hasOwnField(raw, key)) {
    throw new Error(`${channel}: missing '${key}'`);
  }
  const value = raw[key];
  if (typeof value === "string" || value === null) return value;
  throw new Error(`${channel}: '${key}' must be a string or null`);
}

function optionalDiagnosticLevel(
  raw: unknown,
  key: string,
  channel: string,
): DiagnosticLogLevel | null {
  const value = requireStringOrNull(raw, key, channel);
  if (value === null) return null;
  if (isDiagnosticLogLevel(value)) return value;
  throw new Error(`${channel}: '${key}' must be a diagnostic log level`);
}

function optionalHostDiagnosticLevel(
  raw: unknown,
  key: string,
  channel: string,
): HostDiagnosticLogLevel | null {
  const value = requireStringOrNull(raw, key, channel);
  if (value === null) return null;
  if (isHostDiagnosticLogLevel(value)) return value;
  throw new Error(`${channel}: '${key}' must be a host diagnostic log level`);
}

function optionalTemporaryScope(raw: unknown): DiagnosticsTemporaryScope {
  if (!isPlainObject(raw)) {
    throw new Error(
      "traycerConfigDiagnosticsClearTemporary: missing object payload",
    );
  }
  if (!hasOwnField(raw, "scope")) {
    throw new Error("traycerConfigDiagnosticsClearTemporary: missing 'scope'");
  }
  const value = raw.scope;
  if (value === "general" || value === "host" || value === "all") {
    return value;
  }
  throw new Error(
    "traycerConfigDiagnosticsClearTemporary: 'scope' must be general, host, or all",
  );
}

function diagnosticsConfigOptionArgs(
  raw: unknown,
  channel: string,
): readonly string[] {
  const level = optionalDiagnosticLevel(raw, "level", channel);
  const hostLevel = optionalHostDiagnosticLevel(raw, "hostLevel", channel);
  const args = [] as string[];
  if (level !== null) args.push("--level", level);
  if (hostLevel !== null) args.push("--host-level", hostLevel);
  return args;
}

export function registerDiagnosticsConfigIpc(bridge: RunnerIpcBridge): void {
  bridge.handleInvoke(
    RunnerHostInvoke.traycerConfigDiagnosticsGet,
    async () => {
      return runTraycerCliJson<TraycerDiagnosticsConfigSnapshot>([
        "config",
        "diagnostics",
        "get",
      ]);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.traycerConfigDiagnosticsSet,
    async (_event, raw: unknown) => {
      const snapshot =
        await runTraycerCliJson<TraycerDiagnosticsConfigSnapshot>([
          "config",
          "diagnostics",
          "set",
          ...diagnosticsConfigOptionArgs(raw, "traycerConfigDiagnosticsSet"),
        ]);
      refreshDesktopDiagnosticsLogLevel();
      return snapshot;
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.traycerConfigDiagnosticsTemporary,
    async (_event, raw: unknown) => {
      const duration = requireString(
        raw,
        "duration",
        "traycerConfigDiagnosticsTemporary",
      );
      const snapshot =
        await runTraycerCliJson<TraycerDiagnosticsConfigSnapshot>([
          "config",
          "diagnostics",
          "temporary",
          ...diagnosticsConfigOptionArgs(
            raw,
            "traycerConfigDiagnosticsTemporary",
          ),
          "--duration",
          duration,
        ]);
      refreshDesktopDiagnosticsLogLevel();
      return snapshot;
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.traycerConfigDiagnosticsClearTemporary,
    async (_event, raw: unknown) => {
      const scope = optionalTemporaryScope(raw);
      const snapshot =
        await runTraycerCliJson<TraycerDiagnosticsConfigSnapshot>([
          "config",
          "diagnostics",
          "clear-temporary",
          "--scope",
          scope,
        ]);
      refreshDesktopDiagnosticsLogLevel();
      return snapshot;
    },
  );
}
