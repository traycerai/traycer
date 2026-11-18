import { installStdioErrorGuards } from "../../std-write";

// Worker for `std-write-closed-reader.test.ts`. Writes ONLY with bare
// `process.stdout.write`, the way the maintenance-lease protocol frames and
// worktree-delete's relayed output do - nothing ever goes through the
// `std-write` seam, so only a guard installed at entry can cover it.

installStdioErrorGuards();

// One kernel pipe buffer per chunk, so each write is a real syscall against
// the closed reader rather than something the stream buffers away.
const CHUNK = `${"x".repeat(65_536)}\n`;
const ROUNDS = 40;
const ROUND_DELAY_MS = 25;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The parent destroys its read end when it sees this first line.
process.stdout.write("ready\n");

for (let round = 0; round < ROUNDS; round += 1) {
  await sleep(ROUND_DELAY_MS);
  process.stdout.write(CHUNK);
}

process.exit(0);
