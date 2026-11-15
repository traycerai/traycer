import { existsSync } from "node:fs";
import { expect, inject, it } from "vitest";
import {
  createCaseWorkDir,
  endCaseWorkDir,
  recordWorker,
} from "../../credentials-run-root";

it("ends a case without removing its directory", () => {
  const workDir = createCaseWorkDir("fixture-case-");
  endCaseWorkDir(workDir);
  expect(existsSync(workDir)).toBe(true);

  const extraWorker = inject("runRootExtraWorker");
  if (extraWorker !== null) {
    recordWorker(inject("credentialsTestRoot"), extraWorker);
  }
});
