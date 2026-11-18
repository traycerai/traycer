import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processDataCommandIo } from "../data-control-entry";
import { engineProgressReporter } from "../data-migrate";

// `--no-progress` means what it means for every other command (runner/
// runtime.ts): no progress in either mode. Only progress - the result and
// every other note stay.

function text(chunk: string | Uint8Array): string {
  return typeof chunk === "string"
    ? chunk
    : Buffer.from(chunk).toString("utf8");
}

describe("--no-progress on the data commands", () => {
  let stdout: string[];
  let stderr: string[];

  beforeEach(() => {
    stdout = [];
    stderr = [];
    vi.spyOn(process.stdout, "write").mockImplementation(
      (chunk: string | Uint8Array) => {
        stdout.push(text(chunk));
        return true;
      },
    );
    vi.spyOn(process.stderr, "write").mockImplementation(
      (chunk: string | Uint8Array) => {
        stderr.push(text(chunk));
        return true;
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function report(args: readonly string[]): void {
    const io = processDataCommandIo(["node", "traycer", "data", ...args]);
    const progress = engineProgressReporter(io);
    progress({ kind: "phase", phase: "copying" });
    progress({
      kind: "copy",
      files: 1,
      totalFiles: 2,
      bytes: 10,
      totalBytes: 20,
    });
    progress({ kind: "waiting-for-participants", running: 1 });
  }

  it("--json --no-progress emits no progress event", () => {
    report(["migrate", "--json", "--no-progress"]);

    expect(stdout.join("")).not.toContain('"type":"progress"');
  });

  it("--no-progress in human mode prints no progress line, and keeps the other notes", () => {
    report(["migrate", "--no-progress"]);

    const printed = stderr.join("");
    expect(printed).not.toContain("Copied 1 of 2 files");
    expect(printed).not.toContain("Copying");
    expect(printed).toContain("Waiting for 1 Traycer process(es) to quit");
  });

  it("control: without the flag, --json emits progress events and human mode prints progress lines", () => {
    report(["migrate", "--json"]);
    expect(stdout.join("")).toContain('"type":"progress"');

    report(["migrate"]);
    expect(stderr.join("")).toContain("Copied 1 of 2 files");
  });
});
