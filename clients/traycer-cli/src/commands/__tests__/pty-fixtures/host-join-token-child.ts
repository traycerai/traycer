import { createHash } from "node:crypto";
import { readInstallToken } from "../../host-join-token";

// The child of host-join-token.pty.test.ts: reads an install token the way
// `traycer host join` does, on a terminal, and reports only its length and a
// digest. It then holds still until the driver has looked at the terminal and
// sends SIGUSR2.

// Installed first, so the driver's signal cannot arrive before it is awaited.
const released = new Promise<void>((resolve) => {
  process.once("SIGUSR2", () => resolve());
});

async function run(): Promise<number> {
  let exitCode = 0;
  try {
    const token = await readInstallToken(process.stdin, process.stderr, true);
    const digest = createHash("sha256").update(token).digest("hex");
    process.stdout.write(`READ length=${token.length} sha256=${digest}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    process.stdout.write(`REFUSED ${message}\n`);
    exitCode = 1;
  }
  await released;
  return exitCode;
}

process.exitCode = await run();
