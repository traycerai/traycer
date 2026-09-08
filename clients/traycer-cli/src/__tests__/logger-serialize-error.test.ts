import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The CLI log used to record only WHETHER a thrown error had a message and a
// stack, never what they said. A Mac CLI that died inside a host archive
// download left `{"name":"AssertionError","hasMessage":true,"hasStack":true}`
// and nothing else - no assertion, no frame, no module. These pin the text now
// landing in the file, and the redaction that makes writing it safe.

let logDir = "";

// The real `cliLogPath` resolves under the developer's own ~/.traycer tree,
// which a unit test must not append to.
vi.mock("../store/paths", () => ({
  cliLogPath: () => join(logDir, "cli.log"),
}));

// Same reason, and a sharper one: the threshold is read out of the real
// config.json, so on a machine set to `warn` this whole file would pass by
// writing nothing at all.
vi.mock("@traycer/protocol/config/store", () => ({
  readLogLevelsSync: () => ({ cliLogLevel: "debug", hostLogLevel: "debug" }),
}));

interface SerializedError {
  readonly name: string;
  readonly code: string | null;
  readonly hasMessage: boolean;
  readonly hasStack: boolean;
  readonly message: string;
  readonly stack: string | null;
}

interface LogRecord {
  readonly level: string;
  readonly message: string;
  readonly error: SerializedError | null;
}

function loggedError(): SerializedError {
  const lines = readFileSync(join(logDir, "cli.log"), "utf8")
    .trim()
    .split("\n");
  const last = lines[lines.length - 1] ?? "";
  const record = JSON.parse(last) as LogRecord;
  if (record.error === null) throw new Error("log record carried no error");
  return record.error;
}

beforeEach(() => {
  logDir = mkdtempSync(join(tmpdir(), "traycer-cli-logger-"));
});

afterEach(() => {
  rmSync(logDir, { recursive: true, force: true });
  vi.resetModules();
});

describe("serializeError", () => {
  it("round-trips the message and the stack into the record", async () => {
    const { createCliLogger } = await import("../logger");
    const error = new Error("boom");

    createCliLogger("dev").error("failed", {}, error);

    const serialized = loggedError();
    expect(serialized.name).toBe("Error");
    expect(serialized.message).toBe("boom");
    expect(serialized.stack).toContain("Error: boom");
    // The frame is the half that was worth keeping: it names this file.
    expect(serialized.stack).toContain("logger-serialize-error.test.ts");
    // The old booleans stay, so a reader of older log files still works.
    expect(serialized.hasMessage).toBe(true);
    expect(serialized.hasStack).toBe(true);
  });

  it("redacts a credential carried in the message and in the stack", async () => {
    const { createCliLogger } = await import("../logger");
    // A V8 stack opens by repeating the message verbatim, so a secret in the
    // message is written twice. Both copies have to go.
    const error = new Error("request rejected: Bearer abc.def");

    createCliLogger("dev").error("failed", {}, error);

    const serialized = loggedError();
    expect(serialized.message).toBe("request rejected: Bearer [redacted]");
    expect(serialized.message).not.toContain("abc.def");
    expect(serialized.stack).not.toContain("abc.def");
    expect(serialized.stack).toContain("Bearer [redacted]");
  });

  it("bounds a pathological stack", async () => {
    const { createCliLogger } = await import("../logger");
    const error = new Error("deep");
    // Deep async recursion can carry a stack in the megabytes, and this file
    // is appended to on every CLI run.
    error.stack = `Error: deep\n${"    at frame (/x/y.js:1:1)\n".repeat(50_000)}`;

    createCliLogger("dev").error("failed", {}, error);

    const serialized = loggedError();
    expect(serialized.stack).not.toBeNull();
    // 8 KiB, plus the marker that says why it stops there.
    expect(serialized.stack?.length).toBe(8 * 1_024 + "...<truncated>".length);
    expect(serialized.stack?.endsWith("...<truncated>")).toBe(true);
  });
});

describe("describeErrorOrigin", () => {
  it("names the error and its first FRAME, not the stack's header line", async () => {
    const { describeErrorOrigin } = await import("../logger");
    const error = new Error("boom");
    error.name = "AssertionError";
    error.stack =
      "AssertionError: boom\n    at readBody (node:internal/undici:12:3)\n    at run (/a/b.js:9:1)";

    const origin = describeErrorOrigin(error);

    // `stack.split("\n")[0]` would be "AssertionError: boom" - a restatement
    // of what the caller already has. The frame is the part it does not.
    expect(origin).toBe(
      "AssertionError at readBody (node:internal/undici:12:3)",
    );
  });

  it("collapses the rendering to a single line", async () => {
    const { describeErrorOrigin } = await import("../logger");
    const error = new Error("x");
    error.name = "Weird\nerror: forged CLI line";
    error.stack = "";

    const origin = describeErrorOrigin(error);

    // This is written straight to stderr beside a real `error:` line, so an
    // embedded newline would let error text forge a second one.
    expect(origin).not.toContain("\n");
    expect(origin).toBe("Weird error: forged CLI line");
  });
});
