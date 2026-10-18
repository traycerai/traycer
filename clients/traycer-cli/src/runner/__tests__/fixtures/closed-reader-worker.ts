import { writeSync } from "node:fs";
import {
  flushStdio,
  installStdioErrorGuards,
  writeStderr,
  writeStdout,
} from "../../std-write";

// Worker for `std-write-closed-reader.test.ts`. Keeps writing through the
// REAL `std-write` seam after the parent has closed its end of the pipe, so
// the kernel answers every later write with EPIPE.
//
// `WORKER_STREAM` picks which descriptor is written. `WORKER_INJECT_ERROR_CODE`
// additionally makes the stream's own write path fail with that code after the
// first write, for the case where the error is NOT a closed reader.
// `WORKER_OWN_ERROR_LISTENER=after-guard` installs a no-op `error` listener BEFORE the
// first write, the way `acknowledgeRelocationEntry` does for a relocated
// host-stopping command, so another listener already owns stream errors.
// `WORKER_OWN_ERROR_LISTENER=once-before-guard` instead registers a
// `once("error")` listener BEFORE the guards are installed; it reports what
// it saw on fd 2, so the parent can tell the error was handled.
const stream = process.env.WORKER_STREAM;
if (stream !== "stdout" && stream !== "stderr") {
  throw new Error(
    `WORKER_STREAM must be "stdout" or "stderr", got ${String(stream)}`,
  );
}
const target = stream === "stdout" ? process.stdout : process.stderr;

if (process.env.WORKER_OWN_ERROR_LISTENER === "once-before-guard") {
  target.once("error", (error: NodeJS.ErrnoException) => {
    writeSync(2, `once-handler saw ${String(error.code)}\n`);
  });
}
// As `index.ts` does at process entry, before any command writes.
installStdioErrorGuards();
const write = stream === "stdout" ? writeStdout : writeStderr;

if (process.env.WORKER_OWN_ERROR_LISTENER === "after-guard") {
  target.on("error", () => undefined);
}

// One kernel pipe buffer per chunk, so each write is a real syscall against
// the closed reader rather than something the stream buffers away.
const CHUNK = `${"x".repeat(65_536)}\n`;
const ROUNDS = 40;
const ROUND_DELAY_MS = 25;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The parent closes its end when it sees this first line.
write("ready\n");

const injectedCode = process.env.WORKER_INJECT_ERROR_CODE;
if (injectedCode !== undefined && injectedCode.length > 0) {
  // Fail the stream's own write path, so the error reaches `error` listeners
  // the way a real failing write does (Writable destroys the stream and emits
  // `error`) rather than by hand-emitting the event.
  // A `once` listener sees ONE error, so that mode fails exactly one write;
  // every other mode keeps failing, as a broken descriptor does.
  const failOnce =
    process.env.WORKER_OWN_ERROR_LISTENER === "once-before-guard";
  let failed = false;
  Object.defineProperty(target, "_write", {
    configurable: true,
    value: (
      _chunk: Buffer | string,
      _encoding: BufferEncoding,
      callback: (error: Error | null | undefined) => void,
    ): void => {
      if (failOnce && failed) {
        callback(null);
        return;
      }
      failed = true;
      callback(
        Object.assign(new Error("injected stream error"), {
          code: injectedCode,
        }),
      );
    },
  });
  write("after-injection\n");
}

for (let round = 0; round < ROUNDS; round += 1) {
  await sleep(ROUND_DELAY_MS);
  write(CHUNK);
}

await flushStdio();
process.exit(0);
