import { resolve } from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import { defineConfig } from "vitest/config";

class ProbeSequencer extends BaseSequencer {
  override sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return Promise.resolve(
      [...files].sort((left, right) =>
        left.moduleId.localeCompare(right.moduleId),
      ),
    );
  }
}

export default defineConfig({
  root: import.meta.dirname,
  test: {
    setupFiles: [
      resolve(
        import.meta.dirname,
        "../../../../scripts/test-worker-environment.ts",
      ),
      resolve(import.meta.dirname, "later-setup.ts"),
    ],
    sequence: { setupFiles: "list", sequencer: ProbeSequencer },
    projects: [
      {
        extends: true,
        test: {
          name: "isolated-probe",
          include: ["probe-isolated.probe.ts"],
          isolate: true,
          maxWorkers: 1,
        },
      },
      {
        extends: true,
        test: {
          name: "shared-probe",
          include: ["probe-shared-*.probe.ts"],
          isolate: false,
          maxWorkers: 1,
        },
      },
    ],
  },
});
