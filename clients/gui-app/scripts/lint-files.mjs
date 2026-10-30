// Lint the given paths with both of gui-app's linters: `bun run lint:files
// <paths...>`. `bun run lint` passes `.`, the whole project.
//
// Oxlint (type-aware, through tsrslint) owns every rule it can express; ESLint
// keeps the repository-specific selectors and boundaries. Both flags that
// tolerate ignored paths are load-bearing for the changed-files lint in
// scripts/lint-changed-files.mjs: an explicitly passed ignored file (for
// example src/routeTree.gen.ts) is otherwise an oxlint error and an ESLint
// warning, and --max-warnings 0 turns the warning into a failure.
//
// A script rather than a shell one-liner because `bun run` appends arguments
// to the LAST command of a script only, and both linters need the paths.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const paths = process.argv.length > 2 ? process.argv.slice(2) : ["."];

// Oxlint runs its type-aware rules in a separate backend process. tsrslint
// (tsgolint's rules on tsrs) peaks near 3 GB on this project where the stock
// tsgolint peaks near 11 GB. It ships no Windows binary, so where
// binaryPath() throws, oxlint falls back to the oxlint-tsgolint package.
function oxlintEnv() {
  if (process.env.OXLINT_TSGOLINT_PATH !== undefined) {
    return process.env;
  }
  try {
    const tsrslint = createRequire(import.meta.url)("@maschwenk/tsrslint");
    return { ...process.env, OXLINT_TSGOLINT_PATH: tsrslint.binaryPath() };
  } catch {
    return process.env;
  }
}

function run(args, env) {
  const result = spawnSync("bun", ["x", ...args], { stdio: "inherit", env });
  if (result.error !== undefined) {
    console.error(
      `lint-files: cannot run bun x ${args[0]}: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run(
  [
    "oxlint",
    "-c",
    "oxlint.config.ts",
    "--fix",
    "--deny-warnings",
    "--no-error-on-unmatched-pattern",
    ...paths,
  ],
  oxlintEnv(),
);
run(
  [
    "eslint",
    "--cache",
    "--fix",
    "--max-warnings",
    "0",
    "--no-warn-ignored",
    ...paths,
  ],
  { ...process.env, NODE_OPTIONS: "--max-old-space-size=6144" },
);
