import { mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  canReachHostWebsocketUrl: vi.fn(),
}));

vi.mock("../host-lifecycle", () => ({
  canReachHostWebsocketUrl: (url: string) =>
    mocks.canReachHostWebsocketUrl(url),
  isCurrentHostWebsocketUrl: (url: string) => {
    try {
      const parsed = new URL(url);
      return (
        (parsed.protocol === "ws:" || parsed.protocol === "wss:") &&
        parsed.hostname === "127.0.0.1" &&
        parsed.port !== "" &&
        parsed.pathname === "/rpc"
      );
    } catch {
      return false;
    }
  },
  sleep: (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    }),
}));

const {
  captureHostSpawnEvidenceBaseline,
  waitForHostReady,
  readEnsureRunning,
} = await import("../host-readiness");

function pidJson(pid: number): string {
  return JSON.stringify({
    version: "1.0.0",
    pid,
    websocketUrl: "ws://127.0.0.1:7100/rpc",
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function marker(
  phase: "starting" | "crashed" | "failed-to-spawn",
  attempt: string,
  supervisorPid: number,
): string {
  return markerAt(phase, attempt, supervisorPid, Date.now());
}

function markerAt(
  phase: "starting" | "crashed" | "failed-to-spawn",
  attempt: string,
  supervisorPid: number,
  timestampMs: number,
): string {
  return `[${new Date(timestampMs).toISOString()}] phase=${phase} attempt=${attempt} supervisorPid=${supervisorPid}\n`;
}

describe("waitForHostReady spawn-evidence extension (Finding F)", () => {
  let root = "";
  let logPath = "";
  let pidPath = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "host-readiness-"));
    logPath = join(root, "host.log");
    pidPath = join(root, "pid.json");
    mocks.canReachHostWebsocketUrl.mockReset();
    mocks.canReachHostWebsocketUrl.mockResolvedValue(true);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("fails immediately on a post-baseline terminal marker with its reason", async () => {
    const baseline = await captureHostSpawnEvidenceBaseline(logPath, pidPath);
    await writeFile(
      logPath,
      "[2026-01-01T00:00:00.000Z] phase=failed-to-spawn error=ENOENT attempt=a supervisorPid=1\n",
      "utf8",
    );

    const started = Date.now();
    const result = await waitForHostReady(60_000, pidPath, 20, null, {
      spawnEvidenceBaseline: baseline,
      extendedTimeoutMs: 5 * 60_000,
    });
    const elapsed = Date.now() - started;

    expect(result.ready).toBe(false);
    expect(result.reason).toContain("failed-to-spawn");
    expect(result.reason).toContain("ENOENT");
    // Must not wait out the base budget when a terminal marker is known.
    expect(elapsed).toBeLessThan(5_000);
  });

  it("extends past the base budget when a post-baseline starting marker is present", async () => {
    const baseline = await captureHostSpawnEvidenceBaseline(logPath, pidPath);
    await writeFile(
      logPath,
      "[2026-01-01T00:00:00.000Z] phase=starting shell=/bin/sh attempt=a supervisorPid=1\n",
      "utf8",
    );

    const waitPromise = waitForHostReady(80, pidPath, 15, null, {
      spawnEvidenceBaseline: baseline,
      extendedTimeoutMs: 2_000,
    });

    // Publish pid only after base budget would have expired.
    await delay(120);
    await writeFile(pidPath, pidJson(9001), "utf8");

    const result = await waitPromise;
    expect(result.ready).toBe(true);
    expect(result.pid).toBe(9001);
    expect(result.reason).toBe("ready");
  });

  it("does not extend when base budget expires with no post-baseline evidence", async () => {
    mocks.canReachHostWebsocketUrl.mockResolvedValue(false);
    await writeFile(
      logPath,
      "[2026-01-01T00:00:00.000Z] phase=starting shell=/old\n",
      "utf8",
    );
    await writeFile(pidPath, pidJson(111), "utf8");
    const baseline = await captureHostSpawnEvidenceBaseline(logPath, pidPath);

    const started = Date.now();
    const result = await waitForHostReady(60, pidPath, 15, null, {
      spawnEvidenceBaseline: baseline,
      extendedTimeoutMs: 5_000,
    });
    const elapsed = Date.now() - started;

    expect(result.ready).toBe(false);
    expect(result.reason).not.toMatch(/extending wait/);
    // Should fail near the base budget, not the extended hard cap.
    expect(elapsed).toBeLessThan(1_000);
  });

  it("extends on post-baseline pid metadata (mtime + pid change)", async () => {
    // Start unreachable so the pre-baseline pid cannot satisfy readiness
    // before the extension decision; only post-baseline evidence should
    // stretch the wait.
    mocks.canReachHostWebsocketUrl.mockResolvedValue(false);
    await writeFile(pidPath, pidJson(111), "utf8");
    const baseline = await captureHostSpawnEvidenceBaseline(logPath, pidPath);

    const waitPromise = waitForHostReady(80, pidPath, 15, null, {
      spawnEvidenceBaseline: baseline,
      extendedTimeoutMs: 2_000,
    });

    // Publish a fresh pid before base budget expires so extension sees
    // post-baseline pid evidence, but keep WS unreachable until after.
    await delay(20);
    const later = new Date(Date.now() + 2_000);
    await writeFile(pidPath, pidJson(222), "utf8");
    await utimes(pidPath, later, later);

    await delay(90);
    mocks.canReachHostWebsocketUrl.mockResolvedValue(true);

    const result = await waitPromise;
    expect(result.ready).toBe(true);
    expect(result.pid).toBe(222);
  });

  it("with null baseline never extends (SMAppService / disabled path)", async () => {
    mocks.canReachHostWebsocketUrl.mockResolvedValue(false);
    const started = Date.now();
    const result = await waitForHostReady(50, pidPath, 10, null, {
      spawnEvidenceBaseline: null,
      extendedTimeoutMs: 5_000,
    });
    const elapsed = Date.now() - started;

    expect(result.ready).toBe(false);
    expect(elapsed).toBeLessThan(1_000);
  });

  it("does not let an unreadable baseline pid bypass mtime advancement", async () => {
    mocks.canReachHostWebsocketUrl.mockResolvedValue(false);
    await writeFile(pidPath, "not-json", "utf8");
    const baseline = await captureHostSpawnEvidenceBaseline(logPath, pidPath);
    expect(baseline.pidExists).toBe(true);
    expect(baseline.pid).toBeNull();
    expect(baseline.pidMtimeMs).not.toBeNull();

    await writeFile(pidPath, pidJson(8001), "utf8");
    const unchanged = new Date(baseline.pidMtimeMs ?? 0);
    await utimes(pidPath, unchanged, unchanged);

    const started = Date.now();
    const result = await waitForHostReady(50, pidPath, 10, null, {
      spawnEvidenceBaseline: baseline,
      extendedTimeoutMs: 2_000,
    });

    expect(result.ready).toBe(false);
    expect(result.reason).not.toContain("extending wait");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("treats a newer attempt's starting marker as authoritative over an earlier attempt terminal", async () => {
    mocks.canReachHostWebsocketUrl.mockResolvedValue(false);
    const baseline = await captureHostSpawnEvidenceBaseline(logPath, pidPath);
    await writeFile(
      logPath,
      [
        marker("starting", "attempt-a", 10),
        marker("crashed", "attempt-a", 10),
        marker("starting", "attempt-b", 20),
      ].join(""),
      "utf8",
    );

    const started = Date.now();
    const result = await waitForHostReady(30, pidPath, 10, null, {
      spawnEvidenceBaseline: baseline,
      extendedTimeoutMs: 80,
    });

    expect(result.ready).toBe(false);
    expect(result.reason).not.toContain("host crashed");
    expect(Date.now() - started).toBeGreaterThanOrEqual(60);
  });

  it("ignores a delayed terminal marker from a different attempt after the current start", async () => {
    mocks.canReachHostWebsocketUrl.mockResolvedValue(false);
    const baseline = await captureHostSpawnEvidenceBaseline(logPath, pidPath);
    await writeFile(
      logPath,
      [
        marker("starting", "attempt-b", 20),
        marker("crashed", "attempt-a", 10),
      ].join(""),
      "utf8",
    );

    const started = Date.now();
    const result = await waitForHostReady(30, pidPath, 10, null, {
      spawnEvidenceBaseline: baseline,
      extendedTimeoutMs: 80,
    });

    expect(result.ready).toBe(false);
    expect(result.reason).not.toContain("host crashed");
    expect(Date.now() - started).toBeGreaterThanOrEqual(60);
  });

  it("fails on a terminal-only newer failed-to-spawn attempt", async () => {
    mocks.canReachHostWebsocketUrl.mockResolvedValue(false);
    const baseline = await captureHostSpawnEvidenceBaseline(logPath, pidPath);
    await writeFile(
      logPath,
      [
        marker("starting", "attempt-a", 10),
        marker("failed-to-spawn", "attempt-b", 20),
      ].join(""),
      "utf8",
    );

    const started = Date.now();
    const result = await waitForHostReady(30, pidPath, 10, null, {
      spawnEvidenceBaseline: baseline,
      extendedTimeoutMs: 80,
    });

    expect(result.ready).toBe(false);
    expect(result.reason).toContain("failed-to-spawn");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("fails on the terminal marker for the newest identified attempt", async () => {
    mocks.canReachHostWebsocketUrl.mockResolvedValue(false);
    const baseline = await captureHostSpawnEvidenceBaseline(logPath, pidPath);
    await writeFile(
      logPath,
      [
        marker("starting", "attempt-a", 10),
        marker("starting", "attempt-b", 20),
        marker("crashed", "attempt-b", 20),
      ].join(""),
      "utf8",
    );

    const result = await waitForHostReady(30, pidPath, 10, null, {
      spawnEvidenceBaseline: baseline,
      extendedTimeoutMs: 80,
    });

    expect(result.ready).toBe(false);
    expect(result.reason).toContain("host crashed");
  });

  it("keeps a final marker from 40 seconds before readiness within its bounded authority window", async () => {
    mocks.canReachHostWebsocketUrl.mockResolvedValue(false);
    const baseline = await captureHostSpawnEvidenceBaseline(logPath, pidPath);
    await writeFile(
      logPath,
      markerAt("starting", "attempt-b", 20, Date.now() - 40_000),
      "utf8",
    );

    const started = Date.now();
    const result = await waitForHostReady(30, pidPath, 10, null, {
      spawnEvidenceBaseline: {
        ...baseline,
        markerAuthoritySinceMs: Date.now() - 55_000,
      },
      extendedTimeoutMs: 80,
    });

    expect(result.ready).toBe(false);
    // The later readiness polls update the diagnostic text; elapsed time pins
    // the behavior: the 30ms base budget was extended by the 40s-old marker.
    expect(Date.now() - started).toBeGreaterThanOrEqual(60);
  });

  it("rescans the same inode from zero after an incremental reader sees a shrink", async () => {
    mocks.canReachHostWebsocketUrl.mockResolvedValue(false);
    const prefix = "x".repeat(100);
    await writeFile(logPath, prefix, "utf8");
    const baseline = await captureHostSpawnEvidenceBaseline(logPath, pidPath);
    await writeFile(
      logPath,
      `${prefix}${marker("starting", "attempt-a", 10)}${"y".repeat(300)}`,
      "utf8",
    );

    const waitPromise = waitForHostReady(500, pidPath, 20, null, {
      spawnEvidenceBaseline: baseline,
      extendedTimeoutMs: 1_000,
    });
    await delay(30);
    await writeFile(
      logPath,
      `${marker("failed-to-spawn", "attempt-b", 20)}${"z".repeat(100)}`,
      "utf8",
    );

    const result = await waitPromise;
    expect(result.ready).toBe(false);
    expect(result.reason).toContain("failed-to-spawn");
  });

  it("does not treat an old identified marker as final-start evidence after the authority window narrows", async () => {
    mocks.canReachHostWebsocketUrl.mockResolvedValue(false);
    const baseline = await captureHostSpawnEvidenceBaseline(logPath, pidPath);
    await writeFile(
      logPath,
      "[2020-01-01T00:00:00.000Z] phase=starting attempt=stale supervisorPid=1\n",
      "utf8",
    );

    const started = Date.now();
    const result = await waitForHostReady(50, pidPath, 10, null, {
      spawnEvidenceBaseline: {
        ...baseline,
        markerAuthoritySinceMs: Date.now() - 1_000,
      },
      extendedTimeoutMs: 2_000,
    });

    expect(result.ready).toBe(false);
    expect(result.reason).not.toContain("extending wait");
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("readEnsureRunning", () => {
  it("returns the boolean flag or null when absent", () => {
    expect(readEnsureRunning({ running: false })).toBe(false);
    expect(readEnsureRunning({ running: true })).toBe(true);
    expect(readEnsureRunning({})).toBeNull();
    expect(readEnsureRunning(null)).toBeNull();
    expect(readEnsureRunning(undefined)).toBeNull();
  });
});
