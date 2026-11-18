import {
  flushStdio,
  installStdioErrorGuards,
  stdoutReaderClosed,
  writeStdout,
} from "../../std-write";

// Worker for `std-write-closed-reader.test.ts`. Shaped like `traycer host
// logs --follow`: it streams a line every 50 ms through the real `std-write`
// seam and ends only when stdout's reader goes away, the way `followLog`
// ends on SIGINT. Without `stdoutReaderClosed()` firing, nothing ends it.

installStdioErrorGuards();

const LINE_INTERVAL_MS = 50;

// The parent destroys its read end when it sees this first line.
writeStdout("ready\n");
const timer = setInterval(() => {
  writeStdout("line\n");
}, LINE_INTERVAL_MS);

const readerClosed = stdoutReaderClosed();
await new Promise<void>((resolve) => {
  if (readerClosed.aborted) {
    resolve();
    return;
  }
  readerClosed.addEventListener("abort", () => resolve(), { once: true });
});
clearInterval(timer);
await flushStdio();
process.exit(0);
