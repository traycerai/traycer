import {
  appendFile,
  mkdtemp,
  open,
  rename,
  rm,
  stat,
  writeFile,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readHostPidMetadata: vi.fn(),
  pidPath: "",
  logPath: "",
}));

vi.mock("../pid-metadata", () => ({
  readHostPidMetadata: (environment: unknown) =>
    mocks.readHostPidMetadata(environment),
}));

vi.mock("../../store/paths", () => ({
  bootstrapLogPath: () => mocks.logPath,
  hostPidMetadataPath: () => mocks.pidPath,
}));

const {
  captureLogFileBaseline,
  capturePidMetadataBaseline,
  resolvePostBaselineReadOffset,
  readPostBaselineLogText,
  readPostBaselineMarkers,
  hasPostBaselinePidMetadata,
  collectSpawnEvidence,
  parseBootstrapMarkersFromText,
  findPostBaselineStartingMarker,
  findPostBaselineTerminalMarker,
  createPostBaselineMarkerReader,
  setSpawnEvidenceFileDepsForTests,
} = await import("../spawn-evidence");

const { parseBootstrapLogLine } = await import("../bootstrap-log");

function pidMeta(pid: number) {
  return {
    pid,
    hostId: "host-test",
    version: "1.0.0",
    websocketUrl: "ws://127.0.0.1:7100/rpc",
    startedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("spawn-evidence substrate", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "spawn-evidence-"));
    mocks.logPath = join(root, "host.log");
    mocks.pidPath = join(root, "pid.json");
    mocks.readHostPidMetadata.mockReset();
    mocks.readHostPidMetadata.mockResolvedValue(null);
    setSpawnEvidenceFileDepsForTests(null);
  });

  afterEach(async () => {
    setSpawnEvidenceFileDepsForTests(null);
    await rm(root, { recursive: true, force: true });
  });

  describe("file-identity-aware log baseline (rotation interleaving)", () => {
    it("detects starting at offset 0 of a rotated/fresh file as post-baseline", async () => {
      // Pre-rotation log is large; baseline captures its identity + size.
      const stale =
        "[2026-01-01T00:00:00.000Z] phase=starting shell=/bin/sh\n" +
        "x".repeat(200);
      await writeFile(mocks.logPath, stale, "utf8");
      const baseline = await captureLogFileBaseline(mocks.logPath);
      expect(baseline.exists).toBe(true);
      expect(baseline.size).toBeGreaterThan(100);

      // host-log-rotation renames the old log and starts a fresh file.
      // Simulate: rewrite as a shorter fresh file with `starting` at offset 0.
      const fresh =
        "[2026-01-01T00:01:00.000Z] phase=starting shell=/bin/sh attempt=a1 supervisorPid=99\n";
      await writeFile(mocks.logPath, fresh, "utf8");

      // Size decrease (or identity change after rename) ⇒ read from zero.
      const offset = await resolvePostBaselineReadOffset(baseline);
      expect(offset).toBe(0);

      const text = await readPostBaselineLogText(baseline);
      expect(text).toContain("phase=starting");
      const markers = await readPostBaselineMarkers(baseline);
      expect(findPostBaselineStartingMarker(markers)?.phase).toBe("starting");
    });

    it("reads only the post-baseline slice when the same file grows in place", async () => {
      const prefix =
        "[2026-01-01T00:00:00.000Z] phase=starting shell=/old\n" +
        "[2026-01-01T00:00:01.000Z] phase=exited code=0\n";
      await writeFile(mocks.logPath, prefix, "utf8");
      const baseline = await captureLogFileBaseline(mocks.logPath);

      const suffix =
        "[2026-01-01T00:01:00.000Z] phase=starting shell=/new attempt=a2 supervisorPid=42\n";
      await writeFile(mocks.logPath, prefix + suffix, "utf8");

      const offset = await resolvePostBaselineReadOffset(baseline);
      expect(offset).toBe(baseline.size);

      const text = await readPostBaselineLogText(baseline);
      expect(text).toBe(suffix);
      expect(text).not.toContain("shell=/old");

      const markers = await readPostBaselineMarkers(baseline);
      expect(markers).toHaveLength(1);
      expect(markers[0]?.phase).toBe("starting");
      expect(markers[0]?.fields.attempt).toBe("a2");
    });

    it("reads a newly created log from zero when baseline file was missing", async () => {
      const baseline = await captureLogFileBaseline(mocks.logPath);
      expect(baseline.exists).toBe(false);

      await writeFile(
        mocks.logPath,
        "[2026-01-01T00:00:00.000Z] phase=starting shell=/bin/sh\n",
        "utf8",
      );
      expect(await resolvePostBaselineReadOffset(baseline)).toBe(0);
      const markers = await readPostBaselineMarkers(baseline);
      expect(findPostBaselineStartingMarker(markers)).not.toBeNull();
    });

    it("revalidates opened-file identity when rotation happens after path stat but before open", async () => {
      const stale = "x".repeat(512);
      await writeFile(mocks.logPath, stale, "utf8");
      const baseline = await captureLogFileBaseline(mocks.logPath);
      const rotatedPath = join(root, "host.log.1");
      const fresh =
        "[2026-01-01T00:01:00.000Z] phase=starting attempt=new supervisorPid=44\n";

      setSpawnEvidenceFileDepsForTests({
        openRead: async (path) => {
          await rename(path, rotatedPath);
          await writeFile(path, fresh, "utf8");
          return open(path, "r");
        },
      });

      // The old inode was larger. A path-stat offset reused after rotation
      // would skip this marker; fstat on the opened replacement resets to 0.
      expect(await readPostBaselineLogText(baseline)).toBe(fresh);
    });

    it("resets its incremental cursor when the same inode shrinks", async () => {
      const prefix = "x".repeat(100);
      await writeFile(mocks.logPath, prefix, "utf8");
      const baseline = await captureLogFileBaseline(mocks.logPath);
      const reader = createPostBaselineMarkerReader(baseline);
      const first =
        "[2026-01-01T00:01:00.000Z] phase=starting attempt=a supervisorPid=1\n";
      await writeFile(
        mocks.logPath,
        `${prefix}${first}${"y".repeat(300)}`,
        "utf8",
      );
      expect((await reader.read())[0]?.fields.attempt).toBe("a");

      // Rewriting the file in place preserves its inode but leaves its new
      // marker below the previous cursor. Resuming at the old baseline (or
      // cursor) would skip the start of this replacement content.
      const second =
        "[2026-01-01T00:02:00.000Z] phase=failed-to-spawn attempt=b supervisorPid=2\n";
      await writeFile(mocks.logPath, `${second}${"z".repeat(120)}`, "utf8");

      const markers = await reader.read();
      expect(markers).toHaveLength(1);
      expect(markers[0]?.phase).toBe("failed-to-spawn");
      expect(markers[0]?.fields.attempt).toBe("b");
    });
  });

  describe("pid metadata baseline (stale presence is not evidence)", () => {
    it("rejects pre-baseline pid.json presence alone", async () => {
      await writeFile(mocks.pidPath, JSON.stringify(pidMeta(401)), "utf8");
      mocks.readHostPidMetadata.mockResolvedValue(pidMeta(401));
      const baseline = await capturePidMetadataBaseline(
        mocks.pidPath,
        "production",
      );
      expect(baseline.exists).toBe(true);
      expect(baseline.pid).toBe(401);

      // Same file, same pid, same mtime — not post-baseline.
      const result = await hasPostBaselinePidMetadata(baseline, "production");
      expect(result.evidence).toBe(false);
    });

    it("accepts mtime advance + pid change as evidence", async () => {
      await writeFile(mocks.pidPath, JSON.stringify(pidMeta(401)), "utf8");
      mocks.readHostPidMetadata.mockResolvedValue(pidMeta(401));
      const baseline = await capturePidMetadataBaseline(
        mocks.pidPath,
        "production",
      );

      // Ensure mtime advances past baseline (some FS have 1s resolution).
      const later = new Date(Date.now() + 2_000);
      await writeFile(mocks.pidPath, JSON.stringify(pidMeta(902)), "utf8");
      await utimes(mocks.pidPath, later, later);
      mocks.readHostPidMetadata.mockResolvedValue(pidMeta(902));

      const result = await hasPostBaselinePidMetadata(baseline, "production");
      expect(result.evidence).toBe(true);
      expect(result.metadata?.pid).toBe(902);

      const info = await stat(mocks.pidPath);
      expect(info.mtimeMs).toBeGreaterThan(baseline.mtimeMs ?? 0);
    });

    it("accepts any well-formed pid.json when baseline was missing", async () => {
      const baseline = await capturePidMetadataBaseline(
        mocks.pidPath,
        "production",
      );
      expect(baseline.exists).toBe(false);

      await writeFile(mocks.pidPath, JSON.stringify(pidMeta(555)), "utf8");
      mocks.readHostPidMetadata.mockResolvedValue(pidMeta(555));

      const result = await hasPostBaselinePidMetadata(baseline, "production");
      expect(result.evidence).toBe(true);
    });

    it("does not count mtime advance alone when pid is unchanged", async () => {
      await writeFile(mocks.pidPath, JSON.stringify(pidMeta(401)), "utf8");
      mocks.readHostPidMetadata.mockResolvedValue(pidMeta(401));
      const baseline = await capturePidMetadataBaseline(
        mocks.pidPath,
        "production",
      );

      const later = new Date(Date.now() + 2_000);
      // Touch content enough to rewrite, same pid.
      await writeFile(
        mocks.pidPath,
        JSON.stringify({ ...pidMeta(401), version: "1.0.1" }),
        "utf8",
      );
      await utimes(mocks.pidPath, later, later);
      mocks.readHostPidMetadata.mockResolvedValue({
        ...pidMeta(401),
        version: "1.0.1",
      });

      const result = await hasPostBaselinePidMetadata(baseline, "production");
      expect(result.evidence).toBe(false);
    });

    it("requires mtime advance when the baseline file exists but its pid was unreadable", async () => {
      await writeFile(mocks.pidPath, "not-json", "utf8");
      const baseline = await capturePidMetadataBaseline(
        mocks.pidPath,
        "production",
      );
      expect(baseline.exists).toBe(true);
      expect(baseline.pid).toBeNull();

      // A valid pid appearing without an mtime change is still not a spawn.
      mocks.readHostPidMetadata.mockResolvedValue(pidMeta(777));
      const unchanged = await hasPostBaselinePidMetadata(
        baseline,
        "production",
      );
      expect(unchanged.evidence).toBe(false);

      const later = new Date(Date.now() + 2_000);
      await writeFile(mocks.pidPath, JSON.stringify(pidMeta(777)), "utf8");
      await utimes(mocks.pidPath, later, later);
      const advanced = await hasPostBaselinePidMetadata(baseline, "production");
      expect(advanced.evidence).toBe(true);
    });
  });

  describe("marker format additivity", () => {
    it("parseBootstrapLogLine keeps known fields when attempt + supervisorPid are present", () => {
      const line =
        '[2026-01-01T00:00:00.000Z] phase=starting shell=/bin/zsh args=["-lc","host"] bundle=/opt/host code=0 attempt=attempt-uuid supervisorPid=12345';
      const parsed = parseBootstrapLogLine(line);
      expect(parsed).not.toBeNull();
      expect(parsed?.phase).toBe("starting");
      expect(parsed?.fields.shell).toBe("/bin/zsh");
      expect(parsed?.fields.bundle).toBe("/opt/host");
      expect(parsed?.fields.code).toBe("0");
      // Additive identity fields land as ordinary key=value strings.
      expect(parsed?.fields.attempt).toBe("attempt-uuid");
      expect(parsed?.fields.supervisorPid).toBe("12345");
    });

    it("old-style readers that only project known keys still work on new markers", () => {
      const line =
        "[2026-01-01T00:00:00.000Z] phase=crashed error=boom attempt=a1 supervisorPid=9";
      const parsed = parseBootstrapLogLine(line);
      expect(parsed).not.toBeNull();

      // Simulate a pre-Finding-F consumer that only knows phase + error.
      const legacyView = {
        phase: parsed!.phase,
        error: parsed!.fields.error,
      };
      expect(legacyView).toEqual({ phase: "crashed", error: "boom" });
    });

    it("tolerates crash-diagnostic fields while still extracting known keys", () => {
      // Additive fields (exitMeaning/report/stderrTail) must not break
      // consumers that only project phase + code/error — the same contract
      // host-status, spawn-evidence, and the GUI bootstrap-attempt summary
      // rely on.
      const line =
        '[2026-01-01T00:00:00.000Z] phase=crashed code=3221226505 exitMeaning="0xC0000409 STATUS_STACK_BUFFER_OVERRUN" report=report.2026.json stderrTail="FATAL ERROR:\\nheap OOM" attempt=a1 supervisorPid=9';
      const parsed = parseBootstrapLogLine(line);
      expect(parsed).not.toBeNull();
      expect(parsed?.phase).toBe("crashed");
      expect(parsed?.fields.code).toBe("3221226505");
      expect(parsed?.fields.exitMeaning).toContain("0xC0000409");
      expect(parsed?.fields.report).toBe("report.2026.json");
      expect(parsed?.fields.stderrTail).toBe("FATAL ERROR:\\nheap OOM");

      // host-status formatPhaseDetail projection (code/signal/error only).
      const hostStatusView = {
        phase: parsed!.phase,
        code: parsed!.fields.code,
        signal: parsed!.fields.signal,
        error: parsed!.fields.error,
      };
      expect(hostStatusView).toEqual({
        phase: "crashed",
        code: "3221226505",
        signal: undefined,
        error: undefined,
      });

      // bootstrap-attempt-summary-style projection (phase + code for describeOutcome).
      const attemptSummaryView = {
        phase: parsed!.phase,
        code: parsed!.fields.code ?? "?",
      };
      expect(attemptSummaryView).toEqual({
        phase: "crashed",
        code: "3221226505",
      });

      // spawn-evidence terminal reason still names the phase.
      expect(parsed!.phase).toBe("crashed");
    });

    it("parseBootstrapMarkersFromText and find helpers pick starting / terminal", () => {
      const text = [
        "[2026-01-01T00:00:00.000Z] phase=starting attempt=a supervisorPid=1",
        "[2026-01-01T00:00:01.000Z] phase=failed-to-spawn error=ENOENT attempt=a supervisorPid=1",
        "raw non-marker line",
        "",
      ].join("\n");
      const markers = parseBootstrapMarkersFromText(text);
      expect(markers).toHaveLength(2);
      expect(findPostBaselineStartingMarker(markers)?.phase).toBe("starting");
      expect(findPostBaselineTerminalMarker(markers)?.phase).toBe(
        "failed-to-spawn",
      );
    });
  });

  // Literal `writer=supervisor` throughout rather than the exported
  // constant: these fixtures stand in for bytes already on disk, and a test
  // written against the constant would follow a rename that silently broke
  // every log written before it.
  describe("writer identity across incremental reads", () => {
    it("rejects a marker-shaped burst without losing the stamped marker", async () => {
      const baseline = await captureLogFileBaseline(mocks.logPath);
      const reader = createPostBaselineMarkerReader(baseline);

      await appendFile(
        mocks.logPath,
        "[2026-01-01T00:00:00.000Z] phase=crashed code=134 writer=supervisor\n",
      );
      expect(await reader.read()).toHaveLength(1);

      // A burst of marker-shaped host output, larger than the reader's
      // window. None of it may be trusted, and it must not displace the
      // real marker either - filtering happens before the cap, so the
      // burst never occupies the window in the first place.
      const burst = Array.from(
        { length: 70 },
        (_unused, i) =>
          `[2026-01-01T00:01:${String(i % 60).padStart(2, "0")}.000Z] phase=starting`,
      ).join("\n");
      await appendFile(mocks.logPath, `${burst}\n`);

      const markers = await reader.read();
      expect(markers).toHaveLength(1);
      expect(markers[0]?.phase).toBe("crashed");
    });

    it("reads the era from the whole file, not just the post-baseline slice", async () => {
      // The verified marker sits BEFORE the baseline - a service-managed
      // start writes no CLI marker for this attempt. Deciding the era from
      // the slice alone would call this log legacy and promote the host's
      // stderr line to `starting-marker` evidence.
      await writeFile(
        mocks.logPath,
        "[2026-01-01T00:00:00.000Z] phase=exited code=0 writer=supervisor\n",
        "utf8",
      );
      const baseline = await captureLogFileBaseline(mocks.logPath);
      await appendFile(
        mocks.logPath,
        "[2026-01-01T00:00:05.000Z] phase=starting\n",
      );

      expect(await readPostBaselineMarkers(baseline)).toHaveLength(0);
      const evidence = await collectSpawnEvidence(
        {
          log: baseline,
          pidMetadata: await capturePidMetadataBaseline(
            mocks.pidPath,
            "production",
          ),
        },
        "production",
      );
      expect(evidence?.kind).not.toBe("starting-marker");
    });

    it("seeds the incremental reader's era from the pre-baseline region", async () => {
      await writeFile(
        mocks.logPath,
        "[2026-01-01T00:00:00.000Z] phase=exited code=0 writer=supervisor\n",
        "utf8",
      );
      const baseline = await captureLogFileBaseline(mocks.logPath);
      const reader = createPostBaselineMarkerReader(baseline);
      await appendFile(
        mocks.logPath,
        "[2026-01-01T00:00:05.000Z] phase=starting\n",
      );

      // Reading only forward would never see the verified marker.
      expect(await reader.read()).toHaveLength(0);
    });

    it("does not let raw output evict an authentic marker from the window", async () => {
      // `runTaskAndVerifyStart` polls this reader and gives up if no marker
      // appears. Capping before filtering would let a burst of marker-shaped
      // host output push the real terminal marker out of the window, so a
      // spawn that DID leave evidence reports none and the verifier times out.
      await writeFile(
        mocks.logPath,
        "[2026-01-01T00:00:00.000Z] phase=exited code=0 writer=supervisor\n",
        "utf8",
      );
      const baseline = await captureLogFileBaseline(mocks.logPath);
      const reader = createPostBaselineMarkerReader(baseline);

      await appendFile(
        mocks.logPath,
        "[2026-01-01T00:01:00.000Z] phase=crashed code=134 writer=supervisor\n",
      );
      expect(await reader.read()).toHaveLength(1);

      const burst = Array.from(
        { length: 200 },
        (_unused, i) =>
          `[2026-01-01T00:02:${String(i % 60).padStart(2, "0")}.000Z] phase=starting`,
      ).join("\n");
      await appendFile(mocks.logPath, `${burst}\n`);

      const markers = await reader.read();
      expect(markers).toHaveLength(1);
      expect(markers[0]?.phase).toBe("crashed");
      expect(findPostBaselineTerminalMarker(markers)?.phase).toBe("crashed");
    });

    it("remembers a stamped marker seen in the stream across a rotation", async () => {
      // The stamped marker arrives POST-baseline (the ordinary case - the
      // supervisor writes `starting` after the baseline is taken), so the
      // pre-baseline seed never sees it. If that is not latched, rotation
      // clears `observed`, the replacement has no stamped prefix to re-seed
      // from, and a marker-shaped host line in the new file is trusted.
      const baseline = await captureLogFileBaseline(mocks.logPath);
      const reader = createPostBaselineMarkerReader(baseline);

      await appendFile(
        mocks.logPath,
        "[2026-01-01T00:00:00.000Z] phase=starting writer=supervisor\n",
      );
      expect(await reader.read()).toHaveLength(1);

      // Rotation: a brand new file, no stamped prefix, and the host's own
      // output is the first thing in it.
      await rm(mocks.logPath, { force: true });
      await writeFile(
        mocks.logPath,
        "[2026-01-01T00:05:00.000Z] phase=starting\n",
        "utf8",
      );

      expect(await reader.read()).toHaveLength(0);
    });

    it("scans a pre-baseline region larger than one chunk without buffering it whole", async () => {
      // The prefix is streamed in 64KiB chunks, so a stamped marker beyond
      // the first chunk must still be found - and a marker split across a
      // chunk boundary must not be missed.
      const filler = `${"x".repeat(120)}\n`.repeat(2000); // ~240KB, > 3 chunks
      await writeFile(
        mocks.logPath,
        `${filler}[2026-01-01T00:00:00.000Z] phase=exited code=0 writer=supervisor\n${filler}`,
        "utf8",
      );
      const baseline = await captureLogFileBaseline(mocks.logPath);
      await appendFile(
        mocks.logPath,
        "[2026-01-01T00:00:05.000Z] phase=starting\n",
      );

      expect(await readPostBaselineMarkers(baseline)).toHaveLength(0);
    });

    it("keeps pre-boundary lines but rejects what follows the first stamped marker", async () => {
      const baseline = await captureLogFileBaseline(mocks.logPath);
      const reader = createPostBaselineMarkerReader(baseline);

      await appendFile(
        mocks.logPath,
        "[2026-01-01T00:00:00.000Z] phase=starting\n",
      );
      // Nothing has stamped yet, so this may be the previous CLI's marker.
      expect(await reader.read()).toHaveLength(1);

      await appendFile(
        mocks.logPath,
        "[2026-01-01T00:00:01.000Z] phase=crashed code=9 writer=supervisor\n" +
          "[2026-01-01T00:00:02.000Z] phase=starting\n",
      );

      // The first line stays - it precedes the boundary, so demoting it
      // would delete a genuine older marker on every upgrade. The third
      // does not: it arrives after the writer proved it stamps.
      const markers = await reader.read();
      expect(markers.map((m) => m.phase)).toEqual(["starting", "crashed"]);
      expect(markers[0]?.writer).toBe("unverified");
      expect(markers[1]?.writer).toBe("supervisor");
    });

    it("keeps the pre-boundary line on later polls of the same file", async () => {
      // The boundary is positional WITHIN a file. A stamped marker in the
      // window proves the writer stamps from here on - it does not
      // retroactively convict the lines before it, which is the whole point
      // of the N-1 overlap. Re-deriving the era from that marker on the next
      // poll would delete the previous CLI's evidence one read late, so the
      // marker would be reported once and then vanish.
      const baseline = await captureLogFileBaseline(mocks.logPath);
      const reader = createPostBaselineMarkerReader(baseline);

      await appendFile(
        mocks.logPath,
        "[2026-01-01T00:00:00.000Z] phase=crashed code=9\n" +
          "[2026-01-01T00:00:01.000Z] phase=starting writer=supervisor\n",
      );
      expect((await reader.read()).map((m) => m.phase)).toEqual([
        "crashed",
        "starting",
      ]);

      // Poll with no new bytes, then a poll with an unrelated append. Neither
      // may demote the legacy marker.
      expect((await reader.read()).map((m) => m.phase)).toEqual([
        "crashed",
        "starting",
      ]);
      await appendFile(mocks.logPath, "some raw host output\n");
      expect((await reader.read()).map((m) => m.phase)).toEqual([
        "crashed",
        "starting",
      ]);
    });
  });

  describe("collectSpawnEvidence preference order", () => {
    it("prefers terminal marker over starting and pid metadata", async () => {
      const logBaseline = await captureLogFileBaseline(mocks.logPath);
      const pidBaseline = await capturePidMetadataBaseline(
        mocks.pidPath,
        "production",
      );
      await writeFile(
        mocks.logPath,
        [
          "[2026-01-01T00:00:00.000Z] phase=starting attempt=a supervisorPid=1",
          "[2026-01-01T00:00:01.000Z] phase=crashed error=boom attempt=a supervisorPid=1",
          "",
        ].join("\n"),
        "utf8",
      );
      mocks.readHostPidMetadata.mockResolvedValue(pidMeta(1));

      const evidence = await collectSpawnEvidence(
        { log: logBaseline, pidMetadata: pidBaseline },
        "production",
      );
      expect(evidence?.kind).toBe("terminal-marker");
      expect(evidence?.reason).toContain("crashed");
    });

    it("still collects terminal evidence when the crashed marker carries diagnostic fields", async () => {
      const logBaseline = await captureLogFileBaseline(mocks.logPath);
      const pidBaseline = await capturePidMetadataBaseline(
        mocks.pidPath,
        "production",
      );
      await writeFile(
        mocks.logPath,
        [
          "[2026-01-01T00:00:00.000Z] phase=starting attempt=a supervisorPid=1",
          '[2026-01-01T00:00:01.000Z] phase=crashed code=3221226505 exitMeaning="0xC0000409 STATUS_STACK_BUFFER_OVERRUN" report=r.json stderrTail="FATAL\\nOOM" attempt=a supervisorPid=1',
          "",
        ].join("\n"),
        "utf8",
      );
      mocks.readHostPidMetadata.mockResolvedValue(pidMeta(1));

      const evidence = await collectSpawnEvidence(
        { log: logBaseline, pidMetadata: pidBaseline },
        "production",
      );
      expect(evidence?.kind).toBe("terminal-marker");
      expect(evidence?.reason).toContain("crashed");
    });
  });
});
