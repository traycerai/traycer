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
 *
 * A failed replacement (the directory, the temporary write or the rename)
 * also tries to remove the old record: left in place, it describes an older
 * attempt, and the next host would read that as how its predecessor ended.
 * What the next host then knows:
 *
 *  - the removal succeeded: no record, so the predecessor's exit is unknown
 *    ("nothing known");
 *  - the removal ALSO failed: the old record survives, and the next host reads
 *    an older attempt's exit as its predecessor's. Nothing here can prevent
 *    that; the caller's WARN is its only trace.
 *
 * The original error is the one thrown, whatever the cleanup does.
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
    for (const stale of [temporary, path]) {
      try {
        rmSync(stale, { force: true });
      } catch {
        // The write's own error is the one the caller logs.
      }
    }
    throw error;
  }
}
