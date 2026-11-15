import type { TestProject } from "vitest/node";
import {
  createRunRoot,
  removeRunRootOnceWorkersGone,
} from "./credentials-run-root";

export function setup(project: TestProject): void {
  const root = createRunRoot();
  project.provide("credentialsTestRoot", root);
  // A global teardown would run while workers are still alive: vitest runs it
  // before it closes the pool. `onClose` runs after that close.
  project.vitest.onClose(() => {
    const result = removeRunRootOnceWorkersGone(root);
    if (!result.removed) {
      console.warn(`credentials test root ${root} kept: ${result.reason}`);
    }
  });
}
