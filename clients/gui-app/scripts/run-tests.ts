import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

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

function runVitest(configPath: string, filePath: string | undefined): void {
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
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
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

runVitest("vitest.config.ts", undefined);
if (runsFirstShard) {
  runVitest(
    "vitest.react-compiler.config.ts",
    "src/components/epic-canvas/comm-graph/__tests__/use-comm-graph-snapshot-cloud-authority.test.tsx",
  );
}
