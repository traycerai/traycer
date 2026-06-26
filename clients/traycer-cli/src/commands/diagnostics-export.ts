import { open, mkdir, stat, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  DIAGNOSTICS_REDACTION_POLICY_VERSION,
  redactDiagnosticsLogTail,
} from "@traycer/protocol/config";
import type { CommandFn, CommandResult } from "../runner/runner";
import type { Environment } from "../runner/environment";
import { cliHomeDir, cliLogPath, hostLogPath } from "../store/paths";
import {
  readDiagnosticsConfigSnapshot,
  type DiagnosticsConfigSnapshot,
} from "./config-diagnostics";

const MAX_TOTAL_BUNDLE_BYTES = 25 * 1024 * 1024;
const MAX_LOG_FILE_BYTES = 5 * 1024 * 1024;
const DEFAULT_TAIL_BYTES = 5 * 1024 * 1024;

export interface DiagnosticsExportArgs {
  readonly outputPath: string | null;
  readonly tailBytes: number;
}

interface DiagnosticsExportLog {
  readonly surface: "host" | "cli" | "desktop";
  readonly label: string;
  readonly path: string;
  readonly content: string;
}

interface DiagnosticsExportFileManifest {
  readonly surface: "host" | "cli" | "desktop";
  readonly label: string;
  readonly path: string;
  readonly status: "included" | "missing" | "unreadable" | "omitted";
  readonly originalBytes: number | null;
  readonly includedBytes: number;
  readonly truncated: boolean;
  readonly redacted: boolean;
  readonly reason: string | null;
}

interface DiagnosticsExportManifest {
  readonly createdAt: string;
  readonly redactionPolicyVersion: string;
  readonly limits: {
    readonly maxTotalBundleBytes: number;
    readonly maxLogFileBytes: number;
    readonly requestedTailBytes: number;
  };
  readonly cliVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly activeSlot: string;
  readonly diagnosticsConfigPath: string;
  readonly hostLogPath: string | null;
  readonly files: readonly DiagnosticsExportFileManifest[];
}

interface DiagnosticsExportBundle {
  readonly version: 1;
  readonly manifest: DiagnosticsExportManifest;
  readonly diagnostics: DiagnosticsConfigSnapshot;
  readonly logs: readonly DiagnosticsExportLog[];
}

interface LogCandidate {
  readonly surface: "host" | "cli" | "desktop";
  readonly label: string;
  readonly path: string;
}

interface LogReadResult {
  readonly manifest: DiagnosticsExportFileManifest;
  readonly log: DiagnosticsExportLog | null;
}

export function buildDiagnosticsExportCommand(
  args: DiagnosticsExportArgs,
): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    const now = new Date();
    const tailBytes = clampTailBytes(args.tailBytes);
    const diagnostics = await readDiagnosticsConfigSnapshot(
      ctx.runtime.environment,
    );
    const exportPath =
      args.outputPath ?? defaultExportPath(ctx.runtime.environment, now);
    const selectedHostLogPath =
      diagnostics.hostStatus.logPath ?? hostLogPath(ctx.runtime.environment);
    const candidates = diagnosticsLogCandidates({
      environment: ctx.runtime.environment,
      hostLogPath: selectedHostLogPath,
    });
    const files: DiagnosticsExportFileManifest[] = [];
    const logs: DiagnosticsExportLog[] = [];
    let remainingBytes = MAX_TOTAL_BUNDLE_BYTES;

    for (const candidate of candidates) {
      const readBudget = Math.min(
        tailBytes,
        MAX_LOG_FILE_BYTES,
        remainingBytes,
      );
      if (readBudget <= 0) {
        files.push(omittedManifest(candidate, "bundle-size-limit"));
        continue;
      }
      const result = await readLogCandidate(candidate, readBudget);
      files.push(result.manifest);
      if (result.log !== null) {
        logs.push(result.log);
        remainingBytes -= Buffer.byteLength(result.log.content, "utf8");
      }
    }

    const manifest: DiagnosticsExportManifest = {
      createdAt: now.toISOString(),
      redactionPolicyVersion: DIAGNOSTICS_REDACTION_POLICY_VERSION,
      limits: {
        maxTotalBundleBytes: MAX_TOTAL_BUNDLE_BYTES,
        maxLogFileBytes: MAX_LOG_FILE_BYTES,
        requestedTailBytes: tailBytes,
      },
      cliVersion: diagnostics.cliVersion,
      platform: process.platform,
      arch: process.arch,
      activeSlot: diagnostics.hostStatus.activeSlot ?? ctx.runtime.environment,
      diagnosticsConfigPath: diagnostics.raw.path,
      hostLogPath: selectedHostLogPath,
      files,
    };
    const bundle: DiagnosticsExportBundle = {
      version: 1,
      manifest,
      diagnostics,
      logs,
    };
    const encodedBundle = encodeBundleWithinLimit(bundle, files, logs);

    await mkdir(dirname(exportPath), { recursive: true });
    await writeFile(exportPath, encodedBundle, "utf8");

    return {
      data: { bundlePath: exportPath, manifest: bundle.manifest },
      human: ctx.runtime.json
        ? null
        : `diagnostics bundle written: ${exportPath}`,
      exitCode: 0,
    };
  };
}

export function parseDiagnosticsExportTailBytes(value: string | null): number {
  if (value === null) return DEFAULT_TAIL_BYTES;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TAIL_BYTES;
}

function clampTailBytes(value: number): number {
  return Math.min(Math.max(Math.trunc(value), 1), MAX_LOG_FILE_BYTES);
}

function defaultExportPath(environment: Environment, now: Date): string {
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  return join(
    cliHomeDir(environment),
    "diagnostics",
    `traycer-diagnostics-${timestamp}.json`,
  );
}

function diagnosticsLogCandidates(args: {
  readonly environment: Environment;
  readonly hostLogPath: string;
}): readonly LogCandidate[] {
  return [
    ...rotatedCandidates("host", "Host Log", args.hostLogPath),
    ...rotatedCandidates("cli", "CLI Log", cliLogPath(args.environment)),
    ...desktopLogCandidates(),
  ];
}

function rotatedCandidates(
  surface: "host" | "cli" | "desktop",
  label: string,
  path: string,
): readonly LogCandidate[] {
  return [
    { surface, label, path },
    { surface, label: `${label} .1`, path: `${path}.1` },
    { surface, label: `${label} .2`, path: `${path}.2` },
  ];
}

function desktopLogCandidates(): readonly LogCandidate[] {
  const path = desktopLogPath();
  return path === null ? [] : rotatedCandidates("desktop", "Desktop Log", path);
}

function desktopLogPath(): string | null {
  if (process.platform === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      "Traycer",
      "traycer-desktop.log",
    );
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? null;
    return appData === null
      ? null
      : join(appData, "Traycer", "traycer-desktop.log");
  }
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(configHome, "Traycer", "traycer-desktop.log");
}

async function readLogCandidate(
  candidate: LogCandidate,
  maxBytes: number,
): Promise<LogReadResult> {
  let fileStat: Stats;
  try {
    fileStat = await stat(candidate.path);
  } catch (err) {
    return {
      manifest: unavailableManifest(candidate, unavailableStatus(err), err),
      log: null,
    };
  }

  if (!fileStat.isFile()) {
    return {
      manifest: unavailableManifest(candidate, "unreadable", "not-a-file"),
      log: null,
    };
  }

  const bytesToRead = Math.min(fileStat.size, maxBytes);
  const start = Math.max(fileStat.size - bytesToRead, 0);
  let raw: string;
  try {
    raw = await readFileRange(candidate.path, start, bytesToRead);
  } catch (err) {
    return {
      manifest: unavailableManifest(candidate, "unreadable", err),
      log: null,
    };
  }

  const truncated = fileStat.size > bytesToRead;
  const marker = truncated
    ? `[truncated: showing last ${bytesToRead} of ${fileStat.size} bytes]\n`
    : "";
  // Drop the partial first line of a truncated tail before redacting so a
  // header split across the byte-window boundary (e.g. `Authorization: Basic …`)
  // can't slip past the line-anchored header redaction.
  const content = `${marker}${redactDiagnosticsLogTail(raw, truncated)}`;
  return {
    manifest: {
      surface: candidate.surface,
      label: candidate.label,
      path: candidate.path,
      status: "included",
      originalBytes: fileStat.size,
      includedBytes: Buffer.byteLength(content, "utf8"),
      truncated,
      redacted: true,
      reason: null,
    },
    log: {
      surface: candidate.surface,
      label: candidate.label,
      path: candidate.path,
      content,
    },
  };
}

async function readFileRange(
  path: string,
  start: number,
  length: number,
): Promise<string> {
  if (length === 0) return "";
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const result = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, result.bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function encodeBundleWithinLimit(
  bundle: DiagnosticsExportBundle,
  files: DiagnosticsExportFileManifest[],
  logs: DiagnosticsExportLog[],
): string {
  let encoded = JSON.stringify(bundle, null, 2);
  while (
    Buffer.byteLength(encoded, "utf8") > MAX_TOTAL_BUNDLE_BYTES &&
    logs.length > 0
  ) {
    const removed = logs.pop();
    if (removed !== undefined) {
      markLogOmitted(files, removed, "final-bundle-size-limit");
    }
    encoded = JSON.stringify(bundle, null, 2);
  }
  if (Buffer.byteLength(encoded, "utf8") > MAX_TOTAL_BUNDLE_BYTES) {
    throw new Error("diagnostics bundle exceeds the maximum size without logs");
  }
  return encoded;
}

function markLogOmitted(
  files: DiagnosticsExportFileManifest[],
  log: DiagnosticsExportLog,
  reason: string,
): void {
  let index = -1;
  for (
    let candidateIndex = files.length - 1;
    candidateIndex >= 0;
    candidateIndex -= 1
  ) {
    const file = files[candidateIndex];
    if (file === undefined) continue;
    if (
      file.status === "included" &&
      file.surface === log.surface &&
      file.label === log.label &&
      file.path === log.path
    ) {
      index = candidateIndex;
      break;
    }
  }
  if (index === -1) return;
  const original = files[index];
  if (original === undefined) return;
  files[index] = {
    surface: log.surface,
    label: log.label,
    path: log.path,
    status: "omitted",
    originalBytes: original.originalBytes,
    includedBytes: 0,
    truncated: false,
    redacted: false,
    reason,
  };
}

function unavailableManifest(
  candidate: LogCandidate,
  status: "missing" | "unreadable",
  reason: unknown,
): DiagnosticsExportFileManifest {
  return {
    surface: candidate.surface,
    label: candidate.label,
    path: candidate.path,
    status,
    originalBytes: null,
    includedBytes: 0,
    truncated: false,
    redacted: false,
    reason: describeReason(reason),
  };
}

function omittedManifest(
  candidate: LogCandidate,
  reason: string,
): DiagnosticsExportFileManifest {
  return {
    surface: candidate.surface,
    label: candidate.label,
    path: candidate.path,
    status: "omitted",
    originalBytes: null,
    includedBytes: 0,
    truncated: false,
    redacted: false,
    reason,
  };
}

function unavailableStatus(reason: unknown): "missing" | "unreadable" {
  return errorCode(reason) === "ENOENT" ? "missing" : "unreadable";
}

function describeReason(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return String(reason);
}

function errorCode(reason: unknown): string | null {
  if (reason !== null && typeof reason === "object" && "code" in reason) {
    const value = reason.code;
    return typeof value === "string" ? value : null;
  }
  return null;
}
