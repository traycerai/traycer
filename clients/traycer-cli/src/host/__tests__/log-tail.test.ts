import {
  appendFileSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startLogTail, type LogTail } from "../log-tail";

// Shared `tail -f` follower behind `host logs --follow` and the foreground
// `host start` mirror (see the module doc comment). Exercised against a REAL
// file: the whole point of the module is the rotation/offset arithmetic
// around real fs semantics, which a mocked fs would not prove.

const POLL_INTERVAL_MS = 20;

function collector(): {
  chunks: Buffer[];
  onBytes: (chunk: Buffer) => void;
  text: () => string;
} {
  const chunks: Buffer[] = [];
  return {
    chunks,
    onBytes: (chunk) => chunks.push(chunk),
    text: () => Buffer.concat(chunks).toString("utf8"),
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor: condition never became true");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("startLogTail", () => {
  let work: string;
  let logPath: string;
  let tail: LogTail | null;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "traycer-log-tail-"));
    logPath = join(work, "host.log");
    tail = null;
  });

  afterEach(() => {
    tail?.stop();
    rmSync(work, { recursive: true, force: true });
  });

  it("starts at current EOF: pre-existing content is never emitted", async () => {
    writeFileSync(logPath, "line-that-predates-the-follower\n");
    const { chunks, onBytes } = collector();
    tail = startLogTail({
      path: logPath,
      onBytes,
      onExhausted: () => undefined,
      pollIntervalMs: POLL_INTERVAL_MS,
      maxMissingRetries: 60,
    });

    appendFileSync(logPath, "line-after-follow-started\n");
    await waitFor(() => chunks.length > 0, 2_000);

    const text = Buffer.concat(chunks).toString("utf8");
    expect(text).not.toContain("predates");
    expect(text).toContain("line-after-follow-started");
  });

  it("emits newly appended bytes verbatim", async () => {
    writeFileSync(logPath, "");
    const { onBytes, text } = collector();
    tail = startLogTail({
      path: logPath,
      onBytes,
      onExhausted: () => undefined,
      pollIntervalMs: POLL_INTERVAL_MS,
      maxMissingRetries: 60,
    });

    appendFileSync(logPath, "chunk-one\n");
    await waitFor(() => text().includes("chunk-one"), 2_000);
    appendFileSync(logPath, "chunk-two\n");
    await waitFor(() => text().includes("chunk-two"), 2_000);

    expect(text()).toBe("chunk-one\nchunk-two\n");
  });

  it("resets the offset and re-reads from the top when the file is truncated in place", async () => {
    writeFileSync(logPath, "");
    const { onBytes, text } = collector();
    tail = startLogTail({
      path: logPath,
      onBytes,
      onExhausted: () => undefined,
      pollIntervalMs: POLL_INTERVAL_MS,
      maxMissingRetries: 60,
    });

    appendFileSync(logPath, "before-rotation\n");
    await waitFor(() => text().includes("before-rotation"), 2_000);

    // Simulate rotation-by-truncation: the file shrinks below the last
    // offset the follower observed.
    truncateSync(logPath, 0);
    writeFileSync(logPath, "after-rotation\n");
    await waitFor(() => text().includes("after-rotation"), 3_000);

    expect(text()).toContain("after-rotation");
  });

  it("resets the offset and re-reads from the top when the file is unlinked and recreated smaller", async () => {
    writeFileSync(logPath, "");
    const { onBytes, text } = collector();
    tail = startLogTail({
      path: logPath,
      onBytes,
      onExhausted: () => undefined,
      pollIntervalMs: POLL_INTERVAL_MS,
      maxMissingRetries: 60,
    });

    appendFileSync(logPath, "long line before the rename-rotation\n");
    await waitFor(() => text().includes("long line"), 2_000);

    const beforeRotation = text();
    unlinkSync(logPath);
    writeFileSync(logPath, "short\n");
    await waitFor(() => text().includes("short"), 3_000);

    // "short" (6 bytes) is well below the pre-rotation offset (~40 bytes) -
    // it is only reachable if size < offset reset the read position to 0,
    // rather than the follower stalling forever waiting for the file to grow
    // past an offset the new, smaller file can never reach.
    expect(text()).toBe(`${beforeRotation}short\n`);
  });

  // The catch block cannot tell a deleted file from a one-poll Windows
  // scanner lock or a momentary EACCES, so it must NOT rewind the offset:
  // doing so re-emits the entire log from byte zero on the next successful
  // tick, which for the foreground `host start` mirror floods a terminal with
  // history it started at EOF precisely to avoid. Replacement and truncation
  // stay handled where they can be OBSERVED - the `size < offset` check.
  it("does not replay history after a transient read failure that leaves the file longer than the offset", async () => {
    const head = `${"a".repeat(120)}\n`;
    writeFileSync(logPath, "");
    const { onBytes, text } = collector();
    tail = startLogTail({
      path: logPath,
      onBytes,
      onExhausted: () => undefined,
      pollIntervalMs: POLL_INTERVAL_MS,
      maxMissingRetries: 60,
    });

    appendFileSync(logPath, head);
    await waitFor(() => text().includes(head), 2_000);

    // Make several ticks fail, then restore a file that is LONGER than the
    // consumed offset - the shape a transient failure leaves behind, as
    // opposed to the shorter file a real rotation leaves.
    unlinkSync(logPath);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS * 6));
    writeFileSync(logPath, `${head}tail-only\n`);
    await waitFor(() => text().includes("tail-only"), 3_000);

    // Exactly one copy of the head: the follower resumed at its offset rather
    // than re-reading from zero.
    expect(text().split(head).length - 1).toBe(1);
    expect(text()).toBe(`${head}tail-only\n`);
  });

  it("stop() is idempotent and no bytes are emitted afterwards", async () => {
    writeFileSync(logPath, "");
    const { chunks, onBytes, text } = collector();
    tail = startLogTail({
      path: logPath,
      onBytes,
      onExhausted: () => undefined,
      pollIntervalMs: POLL_INTERVAL_MS,
      maxMissingRetries: 60,
    });

    appendFileSync(logPath, "before-stop\n");
    await waitFor(() => text().includes("before-stop"), 2_000);

    tail.stop();
    tail.stop(); // must not throw a second time

    const countAtStop = chunks.length;
    appendFileSync(logPath, "after-stop\n");
    // Give the poll loop several intervals to (wrongly) fire if it were
    // still scheduled.
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS * 5));
    expect(chunks.length).toBe(countAtStop);
    expect(text()).not.toContain("after-stop");
  });

  it("drainSync emits appends that landed since the last poll, synchronously", async () => {
    writeFileSync(logPath, "");
    const { onBytes, text } = collector();
    // A poll interval long enough that the automatic tick has no chance to
    // fire before drainSync is called, so the emission is attributable only
    // to the synchronous drain.
    tail = startLogTail({
      path: logPath,
      onBytes,
      onExhausted: () => undefined,
      pollIntervalMs: 10_000,
      maxMissingRetries: 60,
    });

    appendFileSync(logPath, "drained-synchronously\n");
    tail.drainSync();

    expect(text()).toBe("drained-synchronously\n");
  });

  it("drainSync is safe when the file is missing and must not throw", () => {
    // Never written at all - openSync must fail and be swallowed.
    const { onBytes, chunks } = collector();
    tail = startLogTail({
      path: join(work, "does-not-exist.log"),
      onBytes,
      onExhausted: () => undefined,
      pollIntervalMs: 10_000,
      maxMissingRetries: 60,
    });

    expect(() => tail?.drainSync()).not.toThrow();
    expect(chunks).toHaveLength(0);
  });

  it("a missing file past maxMissingRetries calls onExhausted exactly once and stops", async () => {
    // Never created - every tick fails to open it.
    const missingPath = join(work, "never-created.log");
    let exhaustedCalls = 0;
    tail = startLogTail({
      path: missingPath,
      onBytes: () => undefined,
      onExhausted: () => {
        exhaustedCalls += 1;
      },
      pollIntervalMs: POLL_INTERVAL_MS,
      maxMissingRetries: 2,
    });

    await waitFor(() => exhaustedCalls > 0, 3_000);
    // Give any further scheduled ticks a chance to (wrongly) fire again.
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS * 5));
    expect(exhaustedCalls).toBe(1);
  });
});
