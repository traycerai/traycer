import { mkdirSync, writeFileSync } from "node:fs";
import type { HostUpdateAttemptRecord } from "@traycer-clients/shared/host-update";
import type { Environment } from "../../runner/environment";

// Shared by `host-restart.test.ts` and `host-free-port-and-restart.test.ts`
// (CodeRabbit review of PR #1480): both suites drive
// `contenderContext.recoveryAction` through the real, unmocked shared
// contender layer by writing an attempt record directly to disk - the
// fixture is byte-identical between them, so it lives here once instead of
// as two copies free to drift.

// Mirrors `contender.test.ts`'s `record()` fixture (the shared package's own
// coverage of `recoveryActionFor`) - only the fields these tests override
// differ per case, everything else is a plain terminal-shaped default.
export function attemptRecord(
  overrides: Partial<HostUpdateAttemptRecord>,
): HostUpdateAttemptRecord {
  return {
    schemaVersion: 2,
    attemptId: "attempt-1",
    generation: 1,
    sequence: 1,
    trigger: "manual",
    targetVersion: "1.2.3",
    phase: "downloading",
    execution: "active",
    continuation: null,
    progress: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    error: null,
    ...overrides,
  };
}

// Writes the record directly to the SAME `updateAttemptRecordPath` the
// shared contender layer reads under its own lock - this is what makes
// `contenderContext.recoveryAction` resolve to something other than the
// default `restart-current` (no attempt) in these command-level tests.
// Dynamic imports (not static) deliberately: `store/paths` binds its home
// root from `os.homedir()` at module load, and each test's `beforeEach`
// calls `vi.resetModules()` so the mocked `osHome.current` for THIS test is
// what a fresh import sees - a static import here would be evaluated once,
// against whichever `workHome` happened to be current at file-load time.
export async function writeAttemptRecordForEnvironment(
  environment: Environment,
  overrides: Partial<HostUpdateAttemptRecord>,
): Promise<void> {
  const { hostHomeDir } = await import("../../store/paths");
  const { updateAttemptRecordPath } =
    await import("@traycer-clients/shared/host-update");
  const home = hostHomeDir(environment);
  mkdirSync(home, { recursive: true });
  writeFileSync(
    updateAttemptRecordPath(home),
    `${JSON.stringify(attemptRecord(overrides))}\n`,
  );
}
