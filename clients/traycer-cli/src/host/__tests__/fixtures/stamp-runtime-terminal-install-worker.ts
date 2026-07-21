import { spawn } from "node:child_process";

// Worker process for the genuine two-process attested-generation CAS race
// test in `stamp-runtime.test.ts` (ticket-2 review round 1, Finding 5).
// Spawned as a real, separate OS process (via `bun run`) so "a terminal
// install lands between the command's returned attested generation and the
// stamp call" exercises the actual terminal command, not a direct record
// writer that could bypass command-result attestation behavior.
async function main(): Promise<void> {
  const cliRoot = process.env.WORKER_CLI_ROOT;
  const home = process.env.WORKER_HOME;
  const sourcePath = process.env.WORKER_SOURCE_PATH;
  if (cliRoot === undefined || home === undefined || sourcePath === undefined) {
    throw new Error(
      "stamp-runtime-terminal-install-worker: WORKER_CLI_ROOT, WORKER_HOME, and WORKER_SOURCE_PATH are required",
    );
  }
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(
      "bun",
      [
        "run",
        "src/index.ts",
        "host",
        "install",
        "--from",
        sourcePath,
        "--no-service-register",
        "--json",
        "--no-progress",
      ],
      {
        cwd: cliRoot,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          TRAYCER_NONINTERACTIVE: "1",
        },
      },
    );
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  if (exitCode !== 0) {
    throw new Error(
      `stamp-runtime-terminal-install-worker: host install exited ${String(exitCode)}`,
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    process.stderr.write(
      `stamp-runtime-terminal-install-worker failed: ${String(err)}\n`,
    );
    process.exit(1);
  });
