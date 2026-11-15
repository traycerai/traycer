import { existsSync, watch, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { expect, it } from "vitest";
import { createCaseWorkDir, endCaseWorkDir } from "../../credentials-run-root";

it("ends a case without removing its directory", () => {
  const stopLog = process.env.CREDENTIALS_RUN_ROOT_STOP_LOG;
  const releaseFile = process.env.CREDENTIALS_RUN_ROOT_RELEASE_FILE;
  if (stopLog === undefined || releaseFile === undefined) {
    throw new Error("the fixture's log and release paths are not in the env");
  }
  const workDir = createCaseWorkDir("fixture-case-");
  endCaseWorkDir(workDir);
  expect(existsSync(workDir)).toBe(true);

  // Vitest stops a forks worker with SIGTERM when its run ends. This worker
  // stays up until the release file appears, which the fixture's second global
  // setup writes after the run root's own teardown has run, and then logs
  // whether the case directory was still there.
  process.once("SIGTERM", () => {
    const stop = (): void => {
      writeFileSync(stopLog, existsSync(workDir) ? "present" : "gone");
      process.exit(0);
    };
    const watcher = watch(dirname(releaseFile), (_event, name) => {
      if (name !== basename(releaseFile)) return;
      watcher.close();
      stop();
    });
    if (existsSync(releaseFile)) {
      watcher.close();
      stop();
    }
  });
});
