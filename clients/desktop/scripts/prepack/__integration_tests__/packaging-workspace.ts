/**
 * Owns the on-disk setup and teardown of the real-pack integration test: the
 * fake CLI staged into the gitignored arch dirs, and the packaged output under
 * `release/`.
 *
 * Two invariants shape it:
 * - Guard: teardown restores or parks only what this run's `prepare` took
 *   over, so a setup that fails early never deletes a developer's untouched
 *   real CLI or their own `release/` output.
 * - Move: `afterAll` runs under vitest's 10 s hook timeout, which is checked
 *   after a synchronous hook returns, so the size-dependent recursive delete
 *   of two packed apps is kept out of that budget. Teardown renames
 *   `release/` into one parking dir instead, and the next `prepare` deletes
 *   that dir under the setup hook's own budget.
 */
import { existsSync, renameSync, rmSync } from "node:fs";

export interface CliDirTakeover {
  readonly dir: string;
  readonly stage: (dir: string) => void;
}

export interface PackagingWorkspacePaths {
  readonly releaseDir: string;
  readonly parkDir: string;
  readonly cliDirs: ReadonlyArray<CliDirTakeover>;
}

export interface PackagingWorkspace {
  prepare(): void;
  teardown(): void;
}

interface TakenOverDir {
  readonly dir: string;
  readonly backup: string;
}

const RECURSIVE_FORCE = { recursive: true, force: true };

export function createPackagingWorkspace(
  paths: PackagingWorkspacePaths,
): PackagingWorkspace {
  const takenOver: TakenOverDir[] = [];
  let releaseIsThisRuns = false;

  return {
    prepare(): void {
      rmSync(paths.parkDir, RECURSIVE_FORCE);
      rmSync(paths.releaseDir, RECURSIVE_FORCE);
      // Set only once the delete succeeded: until then `release/` may still
      // hold output that is not this run's to park.
      releaseIsThisRuns = true;

      // A developer may have a REAL staged CLI + host archive in the
      // (gitignored) arch dirs - e.g. from `make dev-desktop` or a local
      // install build. The test must not destroy it: the real content is
      // moved aside here and restored by `teardown`.
      for (const entry of paths.cliDirs) {
        const backup = `${entry.dir}.packaging-test-backup`;
        // Recover from a prior run that crashed between backup and restore:
        // the backup holds the developer's real content, so it wins.
        if (existsSync(backup)) {
          rmSync(entry.dir, RECURSIVE_FORCE);
          renameSync(backup, entry.dir);
        }
        if (existsSync(entry.dir)) renameSync(entry.dir, backup);
        // Recorded before `stage` runs, so a staging that fails halfway is
        // still undone.
        takenOver.push({ dir: entry.dir, backup });
        entry.stage(entry.dir);
      }
    },

    teardown(): void {
      const errors: unknown[] = [];
      const parkRelease = releaseIsThisRuns;
      releaseIsThisRuns = false;
      // Taking the records empties them: a second teardown restores nothing,
      // so it can never delete a CLI dir whose real content is already back.
      const entries = takenOver.splice(0);

      // A failed rename is never answered with a recursive delete: that is
      // the cost this step exists to keep out of the hook.
      if (parkRelease && existsSync(paths.releaseDir)) {
        try {
          renameSync(paths.releaseDir, paths.parkDir);
        } catch (error) {
          errors.push(error);
        }
      }

      for (const entry of entries) {
        try {
          rmSync(entry.dir, RECURSIVE_FORCE);
          if (existsSync(entry.backup)) renameSync(entry.backup, entry.dir);
        } catch (error) {
          errors.push(error);
        }
      }

      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, "packaging teardown failed");
      }
    },
  };
}
