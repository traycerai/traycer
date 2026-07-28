import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface CapturedAttachment {
  readonly filename: string;
  readonly data: string;
}

interface CapturedHint {
  readonly captureContext: { readonly tags: Record<string, string> };
  readonly attachments: readonly CapturedAttachment[];
}

const sentryMock = vi.hoisted(() => ({
  isInitialized: vi.fn<() => boolean>(),
  captureFeedback: vi.fn<(feedback: unknown, hint: CapturedHint) => string>(),
  flush: vi.fn<(timeout: number) => Promise<boolean>>(),
}));

const loggerMock = vi.hoisted(() => ({
  desktopLogPath: "",
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("electron", () => ({
  app: { getVersion: (): string => "1.1.9" },
  shell: { showItemInFolder: vi.fn() },
}));

vi.mock("@sentry/electron/main", () => sentryMock);

vi.mock("../logger", () => ({
  log: loggerMock.log,
  resolveDesktopLogPath: (): string => loggerMock.desktopLogPath,
}));

import { DesktopSupportService } from "../support";
import type { HostFsLayout } from "../../host/host-paths";

const FORM = {
  title: "Host will not start",
  whatHappened: "It hangs on launch",
  stepsToReproduce: "1. Open the app",
  expectedBehavior: "It starts",
  actualBehavior: "It hangs",
};

const LOG_ATTACHMENT_MAX_BYTES = 512_000;

let tempDir = "";
let hostLogPath = "";

function buildService(): DesktopSupportService {
  const hostLayout: HostFsLayout = {
    rootDir: tempDir,
    pidMetadataFile: join(tempDir, "pid.json"),
    logFile: hostLogPath,
    installDir: join(tempDir, "install"),
    installRecordFile: join(tempDir, "install.json"),
    stagedDir: join(tempDir, "staged"),
    stagedRecordFile: join(tempDir, "staged.json"),
    pendingLoginItemRevisionFile: join(tempDir, "login-item"),
    environment: "production",
  };
  return new DesktopSupportService({
    appName: "Traycer",
    host: { getSnapshot: () => null },
    authSession: {
      get: () => ({ status: "signed-out", token: null, profile: null }),
    },
    hostLayout,
  });
}

function lastHint(): CapturedHint {
  const call = sentryMock.captureFeedback.mock.calls.at(-1);
  if (call === undefined) throw new Error("captureFeedback was never called");
  return call[1];
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "traycer-support-"));
  loggerMock.desktopLogPath = join(tempDir, "traycer-desktop.log");
  hostLogPath = join(tempDir, "host.log");
  await writeFile(loggerMock.desktopLogPath, "desktop log line\n", "utf8");
  await writeFile(hostLogPath, "host log line\n", "utf8");
  sentryMock.isInitialized.mockReturnValue(true);
  sentryMock.flush.mockResolvedValue(true);
});

afterEach(async () => {
  vi.clearAllMocks();
  await rm(tempDir, { recursive: true, force: true });
});

describe("DesktopSupportService.submitReport", () => {
  it("returns the report id once the upload is confirmed flushed", async () => {
    const result = await buildService().submitReport(FORM);

    expect(result.reportId).toMatch(/^rpt_[0-9a-f]{32}$/);
    expect(sentryMock.captureFeedback).toHaveBeenCalledTimes(1);
  });

  it("tags the feedback event with the id it hands back", async () => {
    const result = await buildService().submitReport(FORM);

    // The id is a `reportId` tag, not a Sentry event id - it is the only handle
    // triage has, so an id that is not on the event would be unfindable.
    expect(lastHint().captureContext.tags.reportId).toBe(result.reportId);
  });

  it("attaches both log tails", async () => {
    await buildService().submitReport(FORM);

    expect(lastHint().attachments.map((a) => a.filename)).toEqual([
      "desktop.log",
      "host.log",
    ]);
  });

  it("returns null and uploads nothing when Sentry has no DSN", async () => {
    sentryMock.isInitialized.mockReturnValue(false);

    const result = await buildService().submitReport(FORM);

    expect(result.reportId).toBeNull();
    expect(sentryMock.captureFeedback).not.toHaveBeenCalled();
    expect(sentryMock.flush).not.toHaveBeenCalled();
  });

  it("returns null when the flush times out", async () => {
    sentryMock.flush.mockResolvedValue(false);

    const result = await buildService().submitReport(FORM);

    // The pre-fix code discarded the flush result, so a timed-out upload still
    // handed back an id and stamped it into the GitHub issue.
    expect(result.reportId).toBeNull();
    expect(loggerMock.log.error).toHaveBeenCalled();
  });

  it("returns null when the flush rejects", async () => {
    sentryMock.flush.mockRejectedValue(new Error("transport closed"));

    const result = await buildService().submitReport(FORM);

    expect(result.reportId).toBeNull();
  });

  it("bounds each attachment by bytes, not just line count", async () => {
    // 500 lines is not a size bound: one host log line can carry a multi-KB
    // payload, and an oversized envelope is dropped by Sentry after the event
    // is otherwise accepted.
    // ~2 MB across 100 lines, so line count alone would let all of it through.
    const fatLog = Array.from(
      { length: 100 },
      (_, i) => `line-${i}-${"x".repeat(20_000)}`,
    ).join("\n");
    await writeFile(hostLogPath, fatLog, "utf8");

    await buildService().submitReport(FORM);

    const hostAttachment = lastHint().attachments.find(
      (a) => a.filename === "host.log",
    );
    expect(hostAttachment).toBeDefined();
    const data = hostAttachment?.data ?? "";
    expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(
      LOG_ATTACHMENT_MAX_BYTES,
    );
    // Truncation keeps the tail - the failure being reported lives there.
    expect(data).toContain("line-99-");
    expect(data).not.toContain("line-0-");
  });

  it("waits longer than the old 2s budget before giving up", async () => {
    await buildService().submitReport(FORM);

    expect(sentryMock.flush).toHaveBeenCalledWith(10_000);
  });
});
