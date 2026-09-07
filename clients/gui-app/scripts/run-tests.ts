import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const testArgs = process.argv.slice(2);

/**
 * Spawn Vitest under Node, not Bun (`process.execPath` here is Bun). Resolve the entry from Vitest's `package.json` `bin`, not a `.bin` shim.
 */
/**
 * 128+n shell convention: 137 is SIGKILL, 139 is SIGSEGV.
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

  // Signal kill reports status null; do not collapse to exit 1. Exit 128+n
  // so OOM/segfault are self-identifying.
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
  runVitest(
    "vitest.react-compiler.config.ts",
    "src/hooks/terminal/__tests__/use-epic-terminal-durable-create.test.tsx",
  );
  if (runsBrowserRegressions) {
    runBrowserRegression("scripts/diff-edit-browser-regression.mjs");
    runBrowserRegression("scripts/pierre-tree-zoom-browser-regression.mjs");
    // Cancel-path usability needs a real layout engine; jsdom has no hit
    // testing. Same env flag as the other browser gates.
    runBrowserRegression("scripts/quit-intercept-cancel-browser.mjs");
    runBrowserRegression("scripts/destructive-dialog-focus-browser.mjs");
    // Escape hatch: element removed before release emits no click. jsdom
    // dispatches click directly, so jsdom tests pass on the broken build.
    runBrowserRegression("scripts/boot-escape-hatch-press-browser.mjs");
    // Not gated: window-host-modal-alignment is a left-edge instrument for a
    // superseded layout; toast-over-modal-hittest asserts nothing.
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
