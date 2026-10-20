import {
  acquireMigrationCoordinatorLock,
  MigrationAdmissionError,
  type CoordinatorLockResult,
  type MigrationCoordinatorLock,
} from "@traycer/protocol/config/data-migration-admission";
import { BootstrapRecordError } from "@traycer/protocol/config/data-bootstrap-records";
import { dataBootstrapDir } from "@traycer/protocol/config/data-root";
import { assertCallerPreconditions } from "./caller-preconditions";
import type { MigrationEngineDeps } from "./engine-deps";
import {
  EngineStop,
  engineBlocker,
  stopped,
  type EngineResult,
} from "./engine-types";

export type CoordinatorLockRefusal = Extract<
  CoordinatorLockResult,
  { readonly acquired: false }
>["reason"];

/** What the person is told when the coordinator lock is refused, per reason. */
export function coordinatorLockRefusalMessage(
  reason: CoordinatorLockRefusal,
): string {
  switch (reason) {
    case "held":
      return "another Traycer data migration, recovery or cleanup is running";
    case "ambiguous":
      return "a previous migration process may still be running and could not be proven gone";
    case "corrupt":
      return "the migration lock is unreadable; it is never taken over automatically";
    case "identity-unavailable":
      return "this process cannot read its own process identity";
  }
}

export type HeldCoordinatorLock = {
  readonly lock: MigrationCoordinatorLock;
  readonly bootstrapDir: string;
};

/**
 * Runs `fn` as the migration coordinator: acquires the lock (a refusal is a
 * `blocked` result naming the reason and holder), checks the caller
 * preconditions, converts an operational stop into a result, and always
 * releases the lock.
 */
export async function withCoordinatorLock(
  deps: MigrationEngineDeps,
  fn: (held: HeldCoordinatorLock) => Promise<EngineResult>,
): Promise<EngineResult> {
  const bootstrapDir = dataBootstrapDir(deps.homeDir);
  const acquired = await acquireMigrationCoordinatorLock({
    bootstrapDir,
    probe: deps.probe,
  });
  if (!acquired.acquired) {
    return stopped(
      "blocked",
      null,
      [
        engineBlocker(
          `coordinator-${acquired.reason}`,
          acquired.holder === null ? null : String(acquired.holder.pid),
          coordinatorLockRefusalMessage(acquired.reason),
        ),
      ],
      null,
    );
  }
  try {
    await assertCallerPreconditions({
      bootstrapDir,
      probe: deps.probe,
      selfPid: process.pid,
    });
    return await fn({ lock: acquired.lock, bootstrapDir });
  } catch (error) {
    if (error instanceof EngineStop) {
      return stopped(error.reason, null, error.blockers, error.impact);
    }
    if (error instanceof MigrationAdmissionError) {
      return stopped(
        error.code === "record-damaged" ? "damaged" : "blocked",
        null,
        [engineBlocker(`admission-${error.code}`, null, error.message)],
        null,
      );
    }
    if (error instanceof BootstrapRecordError) {
      return stopped(
        error.code === "record-damaged" ? "damaged" : "conflict",
        null,
        [
          engineBlocker(
            `bootstrap-${error.code}`,
            error.recordPath,
            error.message,
          ),
        ],
        null,
      );
    }
    throw error;
  } finally {
    await acquired.lock.release();
  }
}
