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
/**
 * Exit codes for the signals a killed Vitest run realistically reports.
 * 128+n is the shell convention, so 137 reads as SIGKILL (the OOM killer's
 * signal) and 139 as SIGSEGV without needing a lookup.
 */
const SIGNAL_EXIT_CODES: Readonly<Record<string, number>> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGQUIT: 131,
  SIGABRT: 134,
  SIGBUS: 138,
  SIGFPE: 136,
  SIGKILL: 137,
  SIGSEGV: 139,
  SIGTERM: 143,
};

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

  // A child killed by a SIGNAL reports `status: null` with `signal` set. The
  // previous `result.status ?? 1` collapsed that to a bare exit 1, which is
  // why every shard death in CI has looked like an ordinary failure: an OOM
  // kill (137) and a segfault (139) were both reported as 1, with no summary
  // because the child never got to print one. Surface the signal explicitly
  // and exit 128+n, the shell convention, so the next occurrence is
  // self-identifying instead of ambiguous.
  if (result.signal !== null) {
    const signalExit = SIGNAL_EXIT_CODES[result.signal] ?? 1;
    console.error(
      `[run-tests] vitest was killed by ${result.signal} (exiting ${signalExit}). ` +
        `No test failure was reported because the process did not exit normally.`,
    );
    process.exit(signalExit);
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
const shardValueArgs = new Set<string>(
  shard !== undefined && testArgs.includes("--shard") ? [shard] : [],
);
const runsWholeSuite = !testArgs.some(
  (arg) => !arg.startsWith("-") && !shardValueArgs.has(arg),
);
// The env var keeps its original name because CI sets it by that name
// (`test.yml`); it now gates every browser regression, not just the diff-edit
// one. Renaming it would be a workflow change riding inside an unrelated fix.
const runsBrowserRegressions =
  runsWholeSuite && process.env.RUN_DIFF_EDIT_BROWSER_REGRESSION === "1";

runVitest("vitest.config.ts", undefined);
if (runsFirstShard) {
  runVitest(
    "vitest.react-compiler.config.ts",
    "src/components/epic-canvas/comm-graph/__tests__/use-comm-graph-snapshot-cloud-authority.test.tsx",
  );
  if (runsBrowserRegressions) {
    runBrowserRegression("scripts/diff-edit-browser-regression.mjs");
    // Same gate, same reason: the claim is "after Cancel the window is usable
    // again", and jsdom has no hit testing, so only a real layout engine can
    // tell a released modal from a modal that merely stopped being asserted
    // about. Runs behind the same env flag rather than a second one - a browser
    // check nobody enables is a coverage gap wearing a test's name.
    runBrowserRegression("scripts/quit-intercept-cancel-browser.mjs");
    runBrowserRegression("scripts/destructive-dialog-focus-browser.mjs");
    // NOT here, deliberately, and each for its own reason:
    // - `scripts/window-host-modal-alignment-browser.mjs` measures the
    //   local-bootstrap body against ONE LEFT EDGE (A1/A2/A5/PC4) - the design
    //   `HostBootCard` superseded when the boot card became a CENTRED surface
    //   (`local-host-loading.tsx`: "the card is centred now"). Run against the
    //   current component it reports the centring as a 58px misalignment. It
    //   is a manual instrument for the left-aligned arrangement it was written
    //   for, not a gate on the current one; re-base it before wiring it here.
    // - `scripts/toast-over-modal-hittest.mjs` prints hit-test figures and
    //   asserts nothing, so a gate on it would be a gate on a number nobody
    //   reads - run it by hand.
  }
}

function runBrowserRegression(scriptPath: string): void {
  const result = spawnSync(process.execPath, [scriptPath], {
    stdio: "inherit",
  });
  if (result.error !== undefined) throw result.error;
  if (result.signal !== null) {
    process.exit(SIGNAL_EXIT_CODES[result.signal] ?? 1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
