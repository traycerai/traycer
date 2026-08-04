import {
  chmod,
  mkdtemp,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Redirect host.log for StderrLogTee so tests never write under ~/.traycer.
const teeMocks = vi.hoisted(() => ({
  logPath: "",
}));

// Controllable stall for appendFile so flush(timeout) can be proven to race
// the queue rather than only exercising the already-drained path.
const appendFileGate = vi.hoisted(() => {
  let stall = false;
  let waiters: Array<() => void> = [];
  return {
    setStall(value: boolean): void {
      stall = value;
    },
    async maybeStall(): Promise<void> {
      if (!stall) return;
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    },
    releaseAll(): void {
      const pending = waiters;
      waiters = [];
      for (const resolve of pending) resolve();
    },
  };
});

vi.mock("../../store/paths", () => ({
  bootstrapLogPath: () => teeMocks.logPath,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    appendFile: async (
      ...args: Parameters<typeof actual.appendFile>
    ): Promise<void> => {
      await appendFileGate.maybeStall();
      await actual.appendFile(...args);
    },
  };
});

const {
  CRASH_REPORT_SPAWN_SLACK_MS,
  REPORT_SUMMARY_MAX_CHARS,
  STDERR_FATAL_WINDOW_MAX_BYTES,
  STDERR_MARKER_MAX_CHARS,
  STDERR_TEE_MAX_PENDING_BYTES,
  StderrCaptureBuffer,
  StderrLogTee,
  crashReportsDirFor,
  describeExitCode,
  describeFatalSignal,
  findCrashReportSince,
  isFatalSignal,
  prepareCrashReportsDir,
  pruneCrashReports,
} = await import("../crash-diagnostics");

const EMPTY_EXCLUDE: ReadonlySet<string> = new Set();

// ---------------------------------------------------------------------------
// StderrCaptureBuffer
// ---------------------------------------------------------------------------

describe("StderrCaptureBuffer", () => {
  it("keeps first head bytes, elides the middle, and keeps last tail bytes (no fatal)", () => {
    // head=4, tail=4: "AAAA" + "BBBBCCCC" + "DDDD" → head AAAA, elide 8, tail DDDD
    // when middle is BBBBCCCC (8 bytes) and only 4 fit in tail, last 4 of middle+tail.
    const buf = new StderrCaptureBuffer(4, 4);
    buf.append(Buffer.from("AAAA")); // fills head
    buf.append(Buffer.from("BBBB")); // starts tail
    buf.append(Buffer.from("CCCC")); // tail overflow: BBBBCCCC → elide BBBB, keep CCCC
    buf.append(Buffer.from("DDDD")); // tail: CCCCDDDD → elide CCCC, keep DDDD
    // elided = 4 (BBBB) + 4 (CCCC) = 8
    const escaped = buf.escapedForMarker();
    expect(escaped).toBe("AAAA\\n[... 8 bytes elided ...]\\nDDDD");
    expect(buf.isEmpty()).toBe(false);
  });

  it("concatenates head and tail without elision when nothing is dropped (no fatal)", () => {
    const buf = new StderrCaptureBuffer(10, 10);
    buf.append(Buffer.from("hello"));
    buf.append(Buffer.from("world"));
    expect(buf.escapedForMarker()).toBe("helloworld");
  });

  it("empty buffer reports isEmpty and empty escaped form", () => {
    const buf = new StderrCaptureBuffer(64, 64);
    expect(buf.isEmpty()).toBe(true);
    expect(buf.escapedForMarker()).toBe("");
  });

  it("escapedForMarker escapes LF and U+2028/U+2029 as \\\\n", () => {
    const buf = new StderrCaptureBuffer(2048, 2048);
    // U+2028 LINE SEPARATOR / U+2029 PARAGRAPH SEPARATOR — raw in a quoted
    // marker value silently discard the whole marker line (parser is line-based).
    buf.append(Buffer.from("a\nb\u2028c\u2029d\r\ne"));
    expect(buf.escapedForMarker()).toBe("a\\nb\\nc\\nd\\ne");
  });

  it("escapedForMarker strips remaining C0 control chars but keeps tab", () => {
    const buf = new StderrCaptureBuffer(2048, 2048);
    buf.append(Buffer.from("ok\x00\x01\tkeep\x1f"));
    expect(buf.escapedForMarker()).toBe("ok\tkeep");
  });

  it("clamps the escaped form after escaping at STDERR_MARKER_MAX_CHARS with ellipsis", () => {
    const buf = new StderrCaptureBuffer(10_000, 10_000);
    // Enough printable bytes that the escaped length exceeds the clamp.
    buf.append(Buffer.alloc(STDERR_MARKER_MAX_CHARS + 50, 0x41)); // 'A'
    const escaped = buf.escapedForMarker();
    expect(escaped.length).toBe(STDERR_MARKER_MAX_CHARS);
    expect(escaped.endsWith("…")).toBe(true);
    expect(escaped.slice(0, -1)).toBe("A".repeat(STDERR_MARKER_MAX_CHARS - 1));
  });

  describe("toSingleLine (shared escaper)", () => {
    it("escapes LF and U+2028/U+2029, strips C0 controls, keeps tab", () => {
      const out = StderrCaptureBuffer.toSingleLine(
        "a\nb\u2028c\u2029d\x00\x01\te",
        1_000,
      );
      expect(out).toBe("a\\nb\\nc\\nd\te");
    });

    it("clamps after escaping with an ellipsis", () => {
      const out = StderrCaptureBuffer.toSingleLine("A".repeat(100), 10);
      expect(out.length).toBe(10);
      expect(out.endsWith("…")).toBe(true);
      expect(out.slice(0, -1)).toBe("A".repeat(9));
    });

    it("counts escaped newlines toward the clamp", () => {
      // Two newlines become four chars (`\\n` × 2); clamp must apply after.
      const out = StderrCaptureBuffer.toSingleLine("a\nb\nc", 5);
      expect(out.length).toBe(5);
      expect(out.endsWith("…")).toBe(true);
    });
  });

  describe("FATAL-anchored window", () => {
    it("keeps FATAL ERROR after ~3KB of prior noise + a multi-KB fatal block", () => {
      // Round-3 repro: process-lifetime head fills with ordinary warnings, so
      // head+tail alone loses the headline that sits near the START of a
      // multi-KB OOM block. The fatal window latches at the needle.
      const buf = new StderrCaptureBuffer(2048, 2048);
      const prior = Buffer.from("warning: something noisy\n".repeat(150)); // ~3.6KB
      expect(prior.length).toBeGreaterThan(3000);
      buf.append(prior);

      const fatalBody =
        "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n" +
        " 1: 0x1000 node::Abort()\n" +
        " 2: 0x1001 v8::internal::V8::FatalProcessOutOfMemory\n" +
        " 3: heap stats line early in the block\n" +
        "X".repeat(5000);
      expect(fatalBody.length).toBeGreaterThan(4000);
      buf.append(Buffer.from(fatalBody));

      const escaped = buf.escapedForMarker();
      expect(escaped).toContain("FATAL ERROR");
      expect(escaped).toContain("Reached heap limit");
      expect(escaped).toContain("heap stats line early in the block");
      // Prior warning noise must not dominate: fatal-window rendering prefers
      // the latched fatal text (alone or with trailing elision), not head noise.
      expect(escaped.startsWith("warning:")).toBe(false);
    });

    it("detects a needle split across two chunks", () => {
      const buf = new StderrCaptureBuffer(2048, 2048);
      buf.append(Buffer.from("prefix noise FATAL ER"));
      buf.append(Buffer.from("ROR: heap OOM\nrest of block\n"));
      const escaped = buf.escapedForMarker();
      expect(escaped).toContain("FATAL ERROR");
      expect(escaped).toContain("heap OOM");
    });

    it("renders fatal text alone when the fatal window never fills (uncapped)", () => {
      const buf = new StderrCaptureBuffer(2048, 2048);
      // Head noise first so without fatal-window this would still include it.
      buf.append(Buffer.from("ordinary warning before the abort\n".repeat(20)));
      buf.append(
        Buffer.from(
          "FATAL ERROR: Reached heap limit\nAllocation failed - short block\n",
        ),
      );
      const escaped = buf.escapedForMarker();
      // Uncapped fatal window → fatal text alone (no head noise, no trailing marker).
      expect(escaped).toContain("FATAL ERROR: Reached heap limit");
      expect(escaped).not.toContain("ordinary warning");
      expect(escaped).not.toContain("trailing bytes");
    });

    it("appends trailing-bytes elision + tail when the fatal window caps", () => {
      const buf = new StderrCaptureBuffer(2048, 2048);
      // One chunk that starts with the needle and exceeds STDERR_FATAL_WINDOW_MAX_BYTES.
      const fatal =
        "FATAL ERROR: " +
        "A".repeat(STDERR_FATAL_WINDOW_MAX_BYTES) +
        "TAIL_MARKER_END";
      buf.append(Buffer.from(fatal));
      const escaped = buf.escapedForMarker();
      expect(escaped).toContain("FATAL ERROR");
      expect(escaped).toContain("[... trailing bytes ...]");
      // Tail window keeps the last bytes of the stream (TAIL_MARKER_END).
      expect(escaped).toContain("TAIL_MARKER_END");
    });

    it("detects the '# Fatal error in' needle variant", () => {
      const buf = new StderrCaptureBuffer(2048, 2048);
      buf.append(Buffer.from("some noise\n"));
      buf.append(Buffer.from("# Fatal error in , line 0\nCheck failed: ...\n"));
      const escaped = buf.escapedForMarker();
      expect(escaped).toContain("# Fatal error in");
      expect(escaped).toContain("Check failed");
      expect(escaped).not.toContain("some noise");
    });
  });
});

// ---------------------------------------------------------------------------
// StderrLogTee (mocked path so it never touches ~/.traycer)
// ---------------------------------------------------------------------------

describe("StderrLogTee", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "traycer-stderr-tee-"));
    teeMocks.logPath = join(root, "host.log");
  });

  afterEach(async () => {
    appendFileGate.setStall(false);
    appendFileGate.releaseAll();
    await rm(root, { recursive: true, force: true });
  });

  it("drops tee writes beyond the pending cap while capture stays complete", async () => {
    const tee = new StderrLogTee("production");
    // Flood past the pending-bytes cap with many chunks. Capture still
    // records head+tail; teeDroppedBytes grows for the overflow.
    const chunk = Buffer.alloc(64 * 1024, 0x42); // 64 KiB
    let total = 0;
    while (total <= STDERR_TEE_MAX_PENDING_BYTES + chunk.length) {
      tee.append(chunk);
      total += chunk.length;
    }
    expect(tee.teeDroppedBytes()).toBeGreaterThan(0);
    // Capture still has content from the first chunks (head).
    expect(tee.capture.isEmpty()).toBe(false);
    expect(tee.capture.escapedForMarker().length).toBeGreaterThan(0);
    await tee.flush(500);
  });

  it("flush resolves after queued writes drain", async () => {
    const tee = new StderrLogTee("production");
    tee.append(Buffer.from("hello stderr\n"));
    await tee.flush(2_000);
    const written = await import("node:fs/promises").then((fs) =>
      fs.readFile(teeMocks.logPath, "utf8"),
    );
    expect(written).toBe("hello stderr\n");
  });

  it("flush(timeout) resolves without the stalled appendFile settling, then release leaves no unhandled rejection", async () => {
    // Prove the timeout arm of Promise.race, not the already-drained path.
    appendFileGate.setStall(true);
    const tee = new StderrLogTee("production");
    tee.append(Buffer.from("stalled write\n"));
    const started = Date.now();
    await tee.flush(50);
    expect(Date.now() - started).toBeLessThan(400);
    // Release the stalled write so the microtask settles cleanly.
    appendFileGate.setStall(false);
    appendFileGate.releaseAll();
    // Give the deferred append a turn to finish without throwing unhandled.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  });
});

// ---------------------------------------------------------------------------
// Exit / signal decoding
// ---------------------------------------------------------------------------

describe("describeExitCode", () => {
  it("decodes 3221226505 as 0xC0000409 STATUS_STACK_BUFFER_OVERRUN", () => {
    const meaning = describeExitCode(3221226505);
    expect(meaning).not.toBeNull();
    expect(meaning).toContain("0xC0000409");
    expect(meaning).toContain("STATUS_STACK_BUFFER_OVERRUN");
  });

  it("returns null for ordinary small exit codes", () => {
    expect(describeExitCode(0)).toBeNull();
    expect(describeExitCode(1)).toBeNull();
    expect(describeExitCode(7)).toBeNull();
    expect(describeExitCode(143)).toBeNull();
  });

  it("returns bare hex for unknown high codes", () => {
    expect(describeExitCode(0xc0de0001)).toBe("0xC0DE0001");
  });
});

describe("isFatalSignal / describeFatalSignal", () => {
  it.each([
    ["SIGABRT", "abort"],
    ["SIGSEGV", "segmentation fault"],
    ["SIGBUS", "bus error"],
    ["SIGILL", "illegal instruction"],
    ["SIGFPE", "arithmetic fault"],
    ["SIGTRAP", "trap"],
  ] as const)("treats %s as fatal", (signal, phrase) => {
    expect(isFatalSignal(signal)).toBe(true);
    const meaning = describeFatalSignal(signal);
    expect(meaning).not.toBeNull();
    expect(meaning).toContain(signal);
    expect(meaning).toContain(phrase);
  });

  it("does not treat shutdown signals as fatal", () => {
    expect(isFatalSignal("SIGTERM")).toBe(false);
    expect(isFatalSignal("SIGINT")).toBe(false);
    expect(isFatalSignal("SIGHUP")).toBe(false);
    expect(describeFatalSignal("SIGTERM")).toBeNull();
    expect(isFatalSignal(null)).toBe(false);
    expect(isFatalSignal(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// crash-reports directory helpers
// ---------------------------------------------------------------------------

describe("crashReportsDirFor", () => {
  it("anchors crash-reports under the child cwd", () => {
    expect(crashReportsDirFor("/data/host")).toBe(
      join("/data/host", "crash-reports"),
    );
  });
});

describe("prepareCrashReportsDir", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "traycer-crash-prep-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates the directory, prunes to the newest N, and returns survivors", async () => {
    const dir = join(root, "crash-reports");
    // Seed a sibling-precreated dir with excess reports.
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(dir, { recursive: true }),
    );
    const base = Date.now() - 10_000;
    for (let i = 0; i < 4; i += 1) {
      const path = join(dir, `r${i}.json`);
      await writeFile(path, "{}", "utf8");
      const t = new Date(base + i * 1000);
      await utimes(path, t, t);
    }

    const survivors = await prepareCrashReportsDir(dir, 2);

    const info = await stat(dir);
    expect(info.isDirectory()).toBe(true);
    const remaining = (await readdir(dir)).sort();
    expect(remaining).toEqual(["r2.json", "r3.json"]);
    expect([...survivors].sort()).toEqual(["r2.json", "r3.json"]);
  });

  it("creates a missing directory and returns an empty survivor list", async () => {
    const dir = join(root, "new-crash-reports");
    const survivors = await prepareCrashReportsDir(dir, 5);
    const info = await stat(dir);
    expect(info.isDirectory()).toBe(true);
    expect(survivors).toEqual([]);
  });

  it("creates a new directory with mode 0o700 (POSIX)", async () => {
    if (platform() === "win32") return;
    const dir = join(root, "mode-crash-reports");
    await prepareCrashReportsDir(dir, 5);
    const info = await stat(dir);
    expect(info.mode & 0o777).toBe(0o700);
  });

  it("leaves an existing directory's mode untouched", async () => {
    if (platform() === "win32") return;
    const dir = join(root, "existing-mode");
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(dir, { recursive: true, mode: 0o755 }),
    );
    // Ensure the mode is what we set (mkdir mode can be umask-masked on some
    // platforms; chmod pins it so the "untouched" assertion is meaningful).
    await chmod(dir, 0o755);
    const before = (await stat(dir)).mode & 0o777;
    expect(before).toBe(0o755);

    await prepareCrashReportsDir(dir, 5);

    const after = (await stat(dir)).mode & 0o777;
    expect(after).toBe(0o755);
  });

  it("never throws when the parent is unwritable / mkdir fails", async () => {
    // Point at a path whose parent does not exist as a file (mkdir of
    // nested under a file path fails). Use a file as the parent.
    const blocker = join(root, "not-a-dir");
    await writeFile(blocker, "x", "utf8");
    const dir = join(blocker, "crash-reports");
    await expect(prepareCrashReportsDir(dir, 5)).resolves.toEqual([]);
  });
});

describe("pruneCrashReports", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "traycer-crash-prune-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps the newest N .json reports by mtime", async () => {
    const names = ["old.json", "mid.json", "new.json", "newest.json"];
    const base = Date.now() - 10_000;
    for (let i = 0; i < names.length; i += 1) {
      const path = join(dir, names[i]!);
      await writeFile(path, "{}", "utf8");
      const t = new Date(base + i * 1000);
      await utimes(path, t, t);
    }
    await writeFile(join(dir, "notes.txt"), "ignore me", "utf8");

    await pruneCrashReports(dir, 2);

    const remaining = (await readdir(dir)).sort();
    expect(remaining).toEqual(["new.json", "newest.json", "notes.txt"].sort());
  });

  it("does not throw when the directory is missing", async () => {
    await expect(
      pruneCrashReports(join(dir, "does-not-exist"), 5),
    ).resolves.toBeUndefined();
  });
});

describe("findCrashReportSince", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "traycer-crash-find-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("ignores reports older than sinceMs", async () => {
    const sinceMs = Date.now();
    const path = join(dir, "stale.json");
    await writeFile(
      path,
      JSON.stringify({
        header: { event: "Allocation failed", trigger: "FatalError" },
      }),
      "utf8",
    );
    const older = new Date(sinceMs - 60_000);
    await utimes(path, older, older);

    await expect(
      findCrashReportSince(dir, sinceMs, EMPTY_EXCLUDE),
    ).resolves.toBeNull();
  });

  it("returns the newest report at or after sinceMs with a summary", async () => {
    const sinceMs = Date.now() - 5_000;
    const olderPath = join(dir, "older.json");
    const newerPath = join(dir, "newer.json");
    await writeFile(
      olderPath,
      JSON.stringify({
        header: { event: "old-event", trigger: "FatalError" },
      }),
      "utf8",
    );
    await writeFile(
      newerPath,
      JSON.stringify({
        header: {
          event: "Allocation failed - JavaScript heap out of memory",
          trigger: "FatalError",
        },
        javascriptStack: { message: "FATAL ERROR: Reached heap limit" },
      }),
      "utf8",
    );
    await utimes(olderPath, new Date(sinceMs + 100), new Date(sinceMs + 100));
    await utimes(newerPath, new Date(sinceMs + 500), new Date(sinceMs + 500));

    const match = await findCrashReportSince(dir, sinceMs, EMPTY_EXCLUDE);
    expect(match).not.toBeNull();
    expect(match?.filename).toBe("newer.json");
    expect(match?.summary).toContain("event=Allocation failed");
    expect(match?.summary).toContain("trigger=FatalError");
    expect(match?.summary).toContain("js=FATAL ERROR: Reached heap limit");
  });

  it("returns filename with null summary when JSON is unreadable", async () => {
    const sinceMs = Date.now() - 1_000;
    const path = join(dir, "broken.json");
    await writeFile(path, "not-json{{{", "utf8");
    await utimes(path, new Date(sinceMs + 100), new Date(sinceMs + 100));

    const match = await findCrashReportSince(dir, sinceMs, EMPTY_EXCLUDE);
    expect(match).toEqual({ filename: "broken.json", summary: null });
  });

  it("normalizes report summary to a single line (newlines + U+2028) and clamps length", async () => {
    // summarizeReport is private; exercise it through findCrashReportSince.
    const sinceMs = Date.now() - 1_000;
    const path = join(dir, "multiline.json");
    const longMsg =
      "line1\nline2\u2028line3 " + "Z".repeat(REPORT_SUMMARY_MAX_CHARS + 100);
    await writeFile(
      path,
      JSON.stringify({
        header: { event: "Allocation failed", trigger: "FatalError" },
        javascriptStack: { message: longMsg },
      }),
      "utf8",
    );
    await utimes(path, new Date(sinceMs + 100), new Date(sinceMs + 100));

    const match = await findCrashReportSince(dir, sinceMs, EMPTY_EXCLUDE);
    expect(match).not.toBeNull();
    const summary = match?.summary;
    expect(summary).not.toBeNull();
    // One logical line: no raw LF / U+2028 / U+2029 remain.
    expect(summary).not.toMatch(/[\n\u2028\u2029]/);
    expect(summary).toContain("\\n");
    expect(summary!.length).toBeLessThanOrEqual(REPORT_SUMMARY_MAX_CHARS);
    expect(summary!.endsWith("…")).toBe(true);
  });

  it("returns null for a missing directory", async () => {
    await expect(
      findCrashReportSince(join(dir, "missing"), Date.now(), EMPTY_EXCLUDE),
    ).resolves.toBeNull();
  });

  it("skips names in excludeNames even when mtime is within the slack window", async () => {
    // Previous-child-within-slack attribution: a leftover report is young
    // enough to pass sinceMs but must not be attributed to this child.
    const sinceMs = Date.now() - CRASH_REPORT_SPAWN_SLACK_MS;
    const staleName = "report.prev-child.json";
    const freshName = "report.this-child.json";
    await writeFile(
      join(dir, staleName),
      JSON.stringify({
        header: { event: "prev", trigger: "FatalError" },
      }),
      "utf8",
    );
    await writeFile(
      join(dir, freshName),
      JSON.stringify({
        header: { event: "this", trigger: "FatalError" },
      }),
      "utf8",
    );
    const now = new Date();
    await utimes(join(dir, staleName), now, now);
    await utimes(join(dir, freshName), now, now);

    const match = await findCrashReportSince(
      dir,
      sinceMs,
      new Set([staleName]),
    );
    expect(match).not.toBeNull();
    expect(match?.filename).toBe(freshName);
    expect(match?.summary).toContain("event=this");
  });

  it("returns null when every candidate is excluded", async () => {
    const sinceMs = Date.now() - 1_000;
    const name = "only.json";
    await writeFile(join(dir, name), "{}", "utf8");
    await utimes(join(dir, name), new Date(), new Date());
    await expect(
      findCrashReportSince(dir, sinceMs, new Set([name])),
    ).resolves.toBeNull();
  });

  it("documents the spawn-slack constant used by the supervisor", () => {
    // Callers pass childSpawnedAtMs - CRASH_REPORT_SPAWN_SLACK_MS.
    expect(CRASH_REPORT_SPAWN_SLACK_MS).toBe(2_000);
  });
});
