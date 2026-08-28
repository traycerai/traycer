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
      onSkipped: () => undefined,
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
      onSkipped: () => undefined,
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
      onSkipped: () => undefined,
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
      onSkipped: () => undefined,
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

  // A size-only "is this still the same file?" check is not enough. Consume N
  // bytes, lose the file to a rotation, and come back to a REPLACEMENT that is
  // already past N bytes: size > offset reads as an ordinary append and the
  // follower resumes at N, silently eating the new file's first N bytes. That
  // is reachable whenever the log is rotated under a live follower and the
  // host is reinstalled promptly. Identity (inode, or a confirmed ENOENT) is
  // what distinguishes it.
  it("re-reads a replacement from the top even when it is already LONGER than the consumed offset", async () => {
    const head = `${"a".repeat(120)}\n`;
    writeFileSync(logPath, "");
    const { onBytes, text } = collector();
    tail = startLogTail({
      path: logPath,
      onBytes,
      onExhausted: () => undefined,
      onSkipped: () => undefined,
      pollIntervalMs: POLL_INTERVAL_MS,
      maxMissingRetries: 60,
    });

    appendFileSync(logPath, head);
    await waitFor(() => text().includes(head), 2_000);

    // Replace the file with a different one that is LONGER than what was
    // consumed - so nothing about its size betrays the replacement.
    unlinkSync(logPath);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS * 6));
    const replacement = `${"b".repeat(200)}\nREPLACEMENT-PREFIX-KEPT\n`;
    writeFileSync(logPath, replacement);
    await waitFor(() => text().includes("REPLACEMENT-PREFIX-KEPT"), 3_000);

    // The replacement's own prefix survived: it was read from byte 0, not
    // from the old file's offset.
    expect(text()).toBe(`${head}${replacement}`);
  });

  // `host.log` is unbounded within a host's lifetime and is written by another
  // process, so sizing one allocation off `size - offset` lets that process
  // decide how much memory this one commits. A supervisor mirroring for weeks,
  // or resuming after any gap, could allocate gigabytes.
  it("bounds a single poll's read and still delivers the whole backlog across ticks", async () => {
    writeFileSync(logPath, "");
    const { onBytes, chunks, text } = collector();
    tail = startLogTail({
      path: logPath,
      onBytes,
      onExhausted: () => undefined,
      onSkipped: () => undefined,
      pollIntervalMs: POLL_INTERVAL_MS,
      maxMissingRetries: 60,
    });

    // Comfortably over the 1 MiB per-tick cap, written while the follower is
    // between polls so it all lands as one backlog.
    const payload = `${"z".repeat(3 * 1024 * 1024)}\n`;
    appendFileSync(logPath, payload);
    await waitFor(() => text().length >= payload.length, 5_000);

    // Nothing lost, and no single read took the whole thing.
    expect(text()).toBe(payload);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(1024 * 1024);
    }
  });

  // Inode comparison is NOT sufficient, and this is the case that proves it:
  // the content is replaced in place, so `ino` is unchanged and the new file is
  // longer than the consumed offset. `unlink` + create hits the same shape
  // whenever the allocator hands back the just-freed inode - which is exactly
  // how this was caught, with the identity-only version passing locally and
  // failing in CI. The continuity check (are the bytes we already read still
  // where we read them?) is what actually decides it.
  it("re-reads when the content changed under an UNCHANGED inode", async () => {
    writeFileSync(logPath, "");
    const { onBytes, text } = collector();
    tail = startLogTail({
      path: logPath,
      onBytes,
      onExhausted: () => undefined,
      onSkipped: () => undefined,
      pollIntervalMs: POLL_INTERVAL_MS,
      maxMissingRetries: 60,
    });

    const original = `${"a".repeat(150)}\n`;
    appendFileSync(logPath, original);
    await waitFor(() => text().includes(original), 2_000);

    // Same inode (no unlink), different bytes, longer than the old offset.
    const replacement = `${"b".repeat(300)}\nSAME-INODE-PREFIX-KEPT\n`;
    writeFileSync(logPath, replacement);
    await waitFor(() => text().includes("SAME-INODE-PREFIX-KEPT"), 3_000);

    expect(text()).toBe(`${original}${replacement}`);
  });

  // The window BEFORE the first poll. Recording only the size at construction
  // left the identity unknown, so a replacement that landed before the first
  // tick had nothing to compare against and resumed at the old offset.
  it("re-reads a replacement that landed before the first poll", async () => {
    writeFileSync(logPath, `${"o".repeat(200)}\n`);
    const { onBytes, text } = collector();
    tail = startLogTail({
      path: logPath,
      onBytes,
      onExhausted: () => undefined,
      onSkipped: () => undefined,
      pollIntervalMs: 10_000, // no tick will fire on its own
      maxMissingRetries: 60,
    });

    // Swap in a different, LONGER file before any poll has run.
    unlinkSync(logPath);
    const replacement = `${"n".repeat(400)}\nNEW-PREFIX-MUST-SURVIVE\n`;
    writeFileSync(logPath, replacement);
    tail.drainSync();

    expect(text()).toBe(replacement);
  });

  // The window AFTER the final poll: `drainSync` runs on the exit path, with
  // no later tick to correct it, so it has to apply the same replacement rule.
  it("re-reads a replacement in drainSync rather than resuming at the old offset", async () => {
    writeFileSync(logPath, "");
    const { onBytes, text } = collector();
    tail = startLogTail({
      path: logPath,
      onBytes,
      onExhausted: () => undefined,
      onSkipped: () => undefined,
      pollIntervalMs: POLL_INTERVAL_MS,
      maxMissingRetries: 60,
    });

    appendFileSync(logPath, `${"a".repeat(150)}\n`);
    await waitFor(() => text().length > 150, 2_000);
    tail.stop();

    const replacement = `${"b".repeat(300)}\nDRAIN-PREFIX-MUST-SURVIVE\n`;
    unlinkSync(logPath);
    writeFileSync(logPath, replacement);
    tail.drainSync();

    expect(text()).toContain("DRAIN-PREFIX-MUST-SURVIVE");
    expect(text().endsWith(replacement)).toBe(true);
  });

  // `stop()` can land while a tick is inside open/stat/read/close, past its
  // only entry check. Emitting then breaks the documented guarantee, lets
  // `host logs --follow` keep writing after its signal cleanup resolved, and
  // can race the foreground console's synchronous drain.
  it("emits nothing from a read that was already in flight when stop() landed", async () => {
    writeFileSync(logPath, "");
    const { chunks, onBytes } = collector();
    tail = startLogTail({
      path: logPath,
      onBytes,
      onExhausted: () => undefined,
      onSkipped: () => undefined,
      pollIntervalMs: POLL_INTERVAL_MS,
      maxMissingRetries: 60,
    });

    // Append, then stop DURING the window the tick is doing its async file
    // work rather than before it starts.
    appendFileSync(logPath, "written-then-stopped\n");
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    tail.stop();

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS * 6));
    expect(chunks).toHaveLength(0);
  });

  it("stop() is idempotent and no bytes are emitted afterwards", async () => {
    writeFileSync(logPath, "");
    const { chunks, onBytes, text } = collector();
    tail = startLogTail({
      path: logPath,
      onBytes,
      onExhausted: () => undefined,
      onSkipped: () => undefined,
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
      onSkipped: () => undefined,
      pollIntervalMs: 10_000,
      maxMissingRetries: 60,
    });

    appendFileSync(logPath, "drained-synchronously\n");
    tail.drainSync();

    expect(text()).toBe("drained-synchronously\n");
  });

  // `drainSync` runs immediately before `process.exit`, so whatever it does
  // not emit is lost forever. When the backlog exceeds its cap it must keep
  // the END of it - the host's last words on the way down - not the oldest
  // slice, which is what a plain "read the first N bytes" cap would have kept.
  it("drainSync keeps the TAIL of an over-cap backlog and reports the skip", async () => {
    writeFileSync(logPath, "");
    const { onBytes, text } = collector();
    const skips: number[] = [];
    tail = startLogTail({
      path: logPath,
      onBytes,
      onExhausted: () => undefined,
      onSkipped: (bytes) => skips.push(bytes),
      pollIntervalMs: 10_000,
      maxMissingRetries: 60,
    });

    // Over the 256 KiB sync-drain cap, with a recognisable marker at each end.
    const filler = "f".repeat(400 * 1024);
    appendFileSync(logPath, `OLDEST-LINE\n${filler}\nFINAL-SHUTDOWN-LINE\n`);
    tail.drainSync();

    expect(text()).toContain("FINAL-SHUTDOWN-LINE");
    expect(text()).not.toContain("OLDEST-LINE");
    expect(text().length).toBeLessThanOrEqual(256 * 1024);
    expect(skips).toHaveLength(1);
    expect(skips[0]).toBeGreaterThan(0);
  });

  it("drainSync is safe when the file is missing and must not throw", () => {
    // Never written at all - openSync must fail and be swallowed.
    const { onBytes, chunks } = collector();
    tail = startLogTail({
      path: join(work, "does-not-exist.log"),
      onBytes,
      onExhausted: () => undefined,
      onSkipped: () => undefined,
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
      onSkipped: () => undefined,
      pollIntervalMs: POLL_INTERVAL_MS,
      maxMissingRetries: 2,
    });

    await waitFor(() => exhaustedCalls > 0, 3_000);
    // Give any further scheduled ticks a chance to (wrongly) fire again.
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS * 5));
    expect(exhaustedCalls).toBe(1);
  });
});
