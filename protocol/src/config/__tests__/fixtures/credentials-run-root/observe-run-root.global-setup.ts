import { existsSync } from "node:fs";
import type { TestProject } from "vitest/node";
import { processExists, workerRecords } from "../../credentials-run-root";

export type RunRootObservations = {
  /** Whether the run root existed when global teardown ran; null until then. */
  rootAtGlobalTeardown: boolean | null;
  /**
   * The recorded worker pids still running and whether the run root existed at
   * the first `onClose` callback, before the run root's own cleanup; null until
   * then.
   */
  atClose: { alive: number[]; rootExists: boolean } | null;
};

declare module "vitest" {
  export interface ProvidedContext {
    runRootObservations: RunRootObservations;
  }
}

// Listed before the run root's setup, so its `onClose` callback is registered
// first and its global teardown runs last. The nested run's main process is the
// process of the test that started it, which reads the object provided here.
export function setup(project: TestProject): () => void {
  const observations: RunRootObservations = {
    rootAtGlobalTeardown: null,
    atClose: null,
  };
  project.provide("runRootObservations", observations);
  const runRoot = (): string =>
    project.getProvidedContext().credentialsTestRoot;
  project.vitest.onClose(() => {
    const root = runRoot();
    const rootExists = existsSync(root);
    observations.atClose = {
      alive: rootExists
        ? workerRecords(root)
            .map(Number)
            .filter((pid) => processExists(pid) !== false)
        : [],
      rootExists,
    };
  });
  return () => {
    observations.rootAtGlobalTeardown = existsSync(runRoot());
  };
}
