import { configDefaults, defineConfig } from "vitest/config";
import os from "node:os";
import path from "path";

// Cap of 2, the same cap gui-app's config carries. A fork per core holds the
// whole contract in memory: a multi-file run on a 14-core laptop passed 50 GB
// and took the machine down.
//
// On the 2 vCPU pre-commit runner, `floor(availableParallelism / 2)` is 1, so
// the suite's import ran on one worker. Host shards on that runner pass
// `--maxWorkers=2`. CI uses the cap. Any other machine keeps the half-and-cap
// formula.
const availableParallelism =
  typeof os.availableParallelism === "function"
    ? os.availableParallelism()
    : os.cpus().length;
const CI = process.env.CI;
const IS_CI = CI !== undefined && CI !== "" && CI !== "false" && CI !== "0";
const MAX_TEST_WORKERS = IS_CI
  ? 2
  : Math.min(2, Math.max(1, Math.floor(availableParallelism / 2)));

// `isolate: false` failed 112 tests in these 15 files. They share the
// once-per-process data root, or they need a fresh module graph. Every other
// file shares a worker. Vite concatenates `include` arrays when a project
// extends this file, so the root sets no include and each project lists its own.
const FRESH_MODULE_FILES = [
  "**/src/config/__tests__/adversarial-store-fuzz.test.ts",
  "**/src/config/__tests__/adversarial-detect-shells.test.ts",
  "**/src/config/__tests__/apply-env-overrides.test.ts",
  "**/src/config/__tests__/data-root.test.ts",
  "**/src/config/__tests__/data-root-consumers.test.ts",
  "**/src/config/__tests__/store-concurrent-writes.test.ts",
  "**/src/config/__tests__/store-lock-breakers.test.ts",
  "**/src/config/__tests__/store-lock-deadlines.test.ts",
  "**/src/config/__tests__/store-lock-multiprocess.test.ts",
  "**/src/config/__tests__/store-lock-processes.test.ts",
  "**/src/config/__tests__/store-moved-data-root.test.ts",
  "**/src/framework/__tests__/lazy-schema-force-all.test.ts",
  "**/src/framework/__tests__/lazy-schema-import-builds-nothing.test.ts",
  "**/src/framework/__tests__/registry-import-no-schema-walk.test.ts",
  "**/src/host-transport/__tests__/chunking.test.ts",
];

// In-process lock waits. Child-process files stay on the real clock: a child
// does not see this process's timers, and its waits are the claim.
const LOCK_CLOCK_FILES = new Set([
  "**/src/config/__tests__/store-concurrent-writes.test.ts",
  "**/src/config/__tests__/store-lock-breakers.test.ts",
  "**/src/config/__tests__/store-lock-deadlines.test.ts",
]);

const freshIsolateFiles = FRESH_MODULE_FILES.filter(
  (file) => !LOCK_CLOCK_FILES.has(file),
);
const lockClockFiles = FRESH_MODULE_FILES.filter((file) =>
  LOCK_CLOCK_FILES.has(file),
);
if (freshIsolateFiles.length !== 12 || lockClockFiles.length !== 3) {
  throw new Error(
    `protocol vitest projects expected 12 fresh-isolate files and 3 lock-clock files, got ${freshIsolateFiles.length} and ${lockClockFiles.length}`,
  );
}

const projectExclude = [...configDefaults.exclude];

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@traycer\/protocol\/utils\/(.*)$/,
        replacement: path.resolve(__dirname, "./utils/$1"),
      },
      {
        find: /^@traycer\/protocol\/(.*)$/,
        replacement: path.resolve(__dirname, "./src/$1"),
      },
    ],
  },
  test: {
    // Vitest 5 flipped clearMocks to true; keep the v4 behavior (mock call history persists across tests).
    clearMocks: false,
    // Anchored to the package directory so siblings whose names merely
    // CONTAIN "zod" (`zod-to-json-schema`, `@hookform/resolvers/zod`) are
    // not dragged in. Full rationale for the workaround itself lives in
    // `clients/desktop/vitest.shared.ts`.
    server: { deps: { inline: [/[\\/]node_modules[\\/]zod[\\/]/] } },
    globals: false,
    maxWorkers: MAX_TEST_WORKERS,
    // What the host suite gives its tests. The 5 s default failed
    // auto-mode-contracts.test.ts on a loaded 2 vCPU runner on 2 Nov 2026 (the
    // internal merge run's pre-commit check, run 41490217671), over a synchronous
    // walk that takes about a second alone.
    testTimeout: 20_000,
    projects: [
      {
        extends: true,
        test: {
          name: "shared",
          isolate: false,
          maxWorkers: MAX_TEST_WORKERS,
          include: ["**/__tests__/**/*.test.ts"],
          exclude: [...projectExclude, ...FRESH_MODULE_FILES],
        },
      },
      {
        extends: true,
        test: {
          name: "isolated",
          isolate: true,
          maxWorkers: MAX_TEST_WORKERS,
          include: freshIsolateFiles,
          exclude: projectExclude,
        },
      },
      {
        extends: true,
        test: {
          name: "lock-clock",
          isolate: true,
          maxWorkers: MAX_TEST_WORKERS,
          include: lockClockFiles,
          exclude: projectExclude,
          setupFiles: [
            path.resolve(
              __dirname,
              "./src/config/__tests__/fast-lock-clock.setup.ts",
            ),
          ],
        },
      },
    ],
  },
});
