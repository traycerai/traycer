import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

import { SIGNAL_EXIT_CODES } from "./signal-exit-codes.ts";

// The real-browser regressions are NOT run from here: they live in
// `run-browser-regressions.ts` and CI runs them in their own workflow
// (`.github/workflows/browser-regressions.yml`).

const testArgs = process.argv.slice(2);

/**
 * Vitest runs under **Node**, not under whichever runtime launched this
 * script.
 *
 * This file is started by `bun run test`, so `process.execPath` is the Bun
 * binary and the previous `spawnSync(process.execPath, ["x", "vitest", ...])`
 * ran Vitest's main process and its forked workers on Bun. That is the
 * least-hardened combination for Vitest's process management, and it matches
 * the CI shard failures exactly: the run dies with every visible test passing,
 * the log truncated mid-write, and exit 1 with no failure summary - a process
 * disappearing rather than an assertion failing.
 *
 * Pinning Node also restores the standard diagnostics for that class: V8 heap
 * caps (`NODE_OPTIONS=--max-old-space-size=...`) produce a real, attributable
 * OOM error naming the offending file, instead of a silent kill.
 *
 * The entry is resolved from Vitest's own `package.json` `bin` field rather
 * than a `.bin` shim (whose shebang would reintroduce the ambient runtime) or
 * a hardcoded path (which the store layout would break). `vitest.mjs` is not
 * reachable through the package's `exports`, so resolve the manifest and join.
 */
const requireFromHere = createRequire(import.meta.url);

function resolveVitestEntry(): string {
  const manifestPath = requireFromHere.resolve("vitest/package.json");
  const manifest = requireFromHere("vitest/package.json") as {
    readonly bin: Readonly<Record<string, string>>;
  };
  return path.resolve(path.dirname(manifestPath), manifest.bin.vitest);
}

function runVitest(configPath: string, filePath: string | undefined): number {
  const args = [resolveVitestEntry(), "run", "--config", configPath];
  if (filePath !== undefined) {
    args.push(filePath);
  }

  if (configPath === "vitest.config.ts") {
    args.push(...testArgs);
  }

  const result = spawnSync("node", args, { stdio: "inherit" });
  if (result.error !== undefined) {
    throw result.error;
  }

  // A child killed by a SIGNAL reports `status: null` with `signal` set. The
  // previous `result.status ?? 1` collapsed that to a bare exit 1, which is
  // why every shard death in CI has looked like an ordinary failure: an OOM
  // kill (137) and a segfault (139) were both reported as 1, with no summary
  // because the child never got to print one. Surface the signal explicitly
  // and return 128+n, the shell convention, so the next occurrence is
  // self-identifying instead of ambiguous. Do not exit here: a red main
  // suite used to skip the follow-up config.
  if (result.signal !== null) {
    const signalExit = SIGNAL_EXIT_CODES[result.signal] ?? 1;
    console.error(
      `[run-tests] vitest was killed by ${result.signal} (exiting ${signalExit}). ` +
        `No test failure was reported because the process did not exit normally.`,
    );
    return signalExit;
  }

  return result.status ?? 1;
}

function readShardValue(args: string[]): string | undefined {
  const equalsForm = args.find((arg) => arg.startsWith("--shard="));
  if (equalsForm !== undefined) {
    return equalsForm.slice("--shard=".length);
  }

  const flagIndex = args.indexOf("--shard");
  return flagIndex === -1 ? undefined : args[flagIndex + 1];
}

const shard = readShardValue(testArgs);
const runsFirstShard = shard === undefined || shard.split("/", 1)[0] === "1";

function firstFailure(current: number, next: number): number {
  return current !== 0 ? current : next;
}

let exitCode = 0;
exitCode = firstFailure(exitCode, runVitest("vitest.config.ts", undefined));
if (runsFirstShard) {
  exitCode = firstFailure(
    exitCode,
    runVitest(
      "vitest.react-compiler.config.ts",
      "src/components/epic-canvas/comm-graph/__tests__/use-comm-graph-snapshot-cloud-authority.test.tsx",
    ),
  );
  exitCode = firstFailure(
    exitCode,
    runVitest(
      "vitest.react-compiler.config.ts",
      "src/hooks/terminal/__tests__/use-epic-terminal-durable-create.test.tsx",
    ),
  );
}
process.exit(exitCode);
