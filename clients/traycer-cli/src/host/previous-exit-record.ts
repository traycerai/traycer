import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  hostPreviousExitPath,
  type HostPreviousExit,
  type HostPreviousExitKind,
} from "@traycer/protocol/config/host-previous-exit";
import type { Environment } from "../runner/environment";
import { hostHomeDir } from "../store/paths";
import type { CrashReportMatch, StderrFatalKind } from "./crash-diagnostics";

// The supervisor's half of `@traycer/protocol/config/host-previous-exit`: one
// small record per child exit, replaced whole, so the next host can tell the
// person it restarted after running out of memory. Written beside the
// terminal marker and for the same reason synchronously: the supervisor may
// `process.exit()` right after it.

/** The record's path for `environment`: beside pid.json and supervisor.json. */
export function previousExitRecordPath(environment: Environment): string {
  return hostPreviousExitPath(hostHomeDir(environment));
}

/**
 * Whether an abnormal end was the V8 heap reaching its limit: the fatal line
 * the child printed says so, or the diagnostic report Node wrote at the abort
 * does (its trigger is `OOMError`). Either is enough: stderr can be lost to a
 * full pipe, and a report to a full disk.
 */
export function endedOutOfMemory(
  stderrFatal: StderrFatalKind,
  report: CrashReportMatch | null,
): boolean {
  return stderrFatal === "v8-heap-oom" || report?.heapOutOfMemory === true;
}

/** The kind of an abnormal end: out of memory, or any other crash. */
export function crashKind(
  stderrFatal: StderrFatalKind,
  report: CrashReportMatch | null,
): HostPreviousExitKind {
  return endedOutOfMemory(stderrFatal, report) ? "out-of-memory" : "crashed";
}

export interface PreviousExitInput {
  readonly attemptId: string;
  readonly endedAtMs: number;
  readonly kind: HostPreviousExitKind;
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** The report this exit left, `null` for none (heap numbers then `null`). */
  readonly report: CrashReportMatch | null;
}

export function buildPreviousExit(input: PreviousExitInput): HostPreviousExit {
  return {
    v: 1,
    attemptId: input.attemptId,
    endedAt: new Date(input.endedAtMs).toISOString(),
    kind: input.kind,
    exitCode: input.exitCode,
    signal: input.signal,
    heapLimitBytes: input.report?.memory.heapLimitBytes ?? null,
    heapUsedBytes: input.report?.memory.heapUsedBytes ?? null,
  };
}

/**
 * Replace the record with `record`: a temporary file renamed over the old
 * one, so a reader sees one exit or the other, never a torn mix. Throws on
 * failure; the caller logs and carries on, since the record is never the
 * marker's authority.
 */
export function writePreviousExitRecord(
  environment: Environment,
  record: HostPreviousExit,
): void {
  const path = previousExitRecordPath(environment);
  const temporary = join(
    dirname(path),
    `.previous-exit.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
