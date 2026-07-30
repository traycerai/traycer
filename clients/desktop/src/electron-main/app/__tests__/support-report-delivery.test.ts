import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface CapturedAttachment {
  readonly filename: string;
  readonly data: string;
}

interface CapturedHint {
  readonly event_id: string;
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
import type { SupportSubmitReportRequest } from "../../../ipc-contracts/window-types";

const FORM: SupportSubmitReportRequest = {
  draftId: 1,
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

async function freezeAndSubmit(service: DesktopSupportService) {
  await service.freezeEvidence(FORM.draftId);
  return service.submitReport(FORM);
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
  // resetAllMocks (not clearAllMocks): a test that sets a throwing
  // `mockImplementation` on captureFeedback (the "failed" describe block)
  // would otherwise leak that implementation into every later test -
  // clearing only wipes call history, not the implementation itself.
  vi.resetAllMocks();
  await rm(tempDir, { recursive: true, force: true });
});

describe("DesktopSupportService.submitReport - delivered", () => {
  it("returns delivered with the report id once the upload is confirmed flushed", async () => {
    const result = await freezeAndSubmit(buildService());

    expect(result.status).toBe("delivered");
    expect(result.status === "delivered" && result.reportId).toMatch(
      /^rpt_[0-9a-f]{32}$/,
    );
    expect(sentryMock.captureFeedback).toHaveBeenCalledTimes(1);
  });

  it("tags the feedback event with the id it hands back", async () => {
    const result = await freezeAndSubmit(buildService());

    // The id is a `reportId` tag, not a Sentry event id - it is the only handle
    // triage has, so an id that is not on the event would be unfindable.
    expect(result.status === "delivered" && result.reportId).toBe(
      lastHint().captureContext.tags.reportId,
    );
  });

  it("uses the reportId's suffix (dashes stripped) as the Sentry event_id", async () => {
    const result = await freezeAndSubmit(buildService());

    const reportId = result.status === "delivered" ? result.reportId : "";
    expect(lastHint().event_id).toBe(reportId.slice("rpt_".length));
  });

  it("attaches both log tails", async () => {
    await freezeAndSubmit(buildService());

    expect(lastHint().attachments.map((a) => a.filename)).toEqual([
      "desktop.log",
      "host.log",
    ]);
  });

  it("waits longer than the old 2s budget before giving up", async () => {
    await freezeAndSubmit(buildService());

    expect(sentryMock.flush).toHaveBeenCalledWith(10_000);
  });
});

describe("DesktopSupportService.submitReport - unavailable", () => {
  it("returns unavailable and uploads nothing when Sentry has no DSN", async () => {
    sentryMock.isInitialized.mockReturnValue(false);

    const result = await freezeAndSubmit(buildService());

    expect(result).toEqual({ status: "unavailable" });
    expect(sentryMock.captureFeedback).not.toHaveBeenCalled();
    expect(sentryMock.flush).not.toHaveBeenCalled();
  });

  it("reflects DSN presence on the support snapshot as privateDeliveryAvailable", async () => {
    sentryMock.isInitialized.mockReturnValue(false);
    const withoutDsn = await buildService().getSnapshot();
    expect(withoutDsn.privateDeliveryAvailable).toBe(false);

    sentryMock.isInitialized.mockReturnValue(true);
    const withDsn = await buildService().getSnapshot();
    expect(withDsn.privateDeliveryAvailable).toBe(true);
  });
});

describe("DesktopSupportService.submitReport - unconfirmed", () => {
  it("returns unconfirmed with the reportId when the flush times out - never failed", async () => {
    sentryMock.flush.mockResolvedValue(false);

    const result = await freezeAndSubmit(buildService());

    // The pre-fix code discarded the flush result and returned null, which
    // was indistinguishable from a definite failure - a false "failed" tells
    // users a report failed that may in fact have arrived.
    expect(result.status).toBe("unconfirmed");
    expect(result.status === "unconfirmed" && result.reportId).toMatch(
      /^rpt_[0-9a-f]{32}$/,
    );
  });

  it("returns unconfirmed, not failed, when the flush call rejects", async () => {
    sentryMock.flush.mockRejectedValue(new Error("transport closed"));

    const result = await freezeAndSubmit(buildService());

    expect(result.status).toBe("unconfirmed");
  });
});

describe("DesktopSupportService.submitReport - failed", () => {
  it("returns failed, with no reportId field, when captureFeedback throws", async () => {
    sentryMock.captureFeedback.mockImplementation(() => {
      throw new Error("DSN rejected");
    });

    const result = await freezeAndSubmit(buildService());

    expect(result).toEqual({ status: "failed", reason: "error" });
    expect(sentryMock.flush).not.toHaveBeenCalled();
  });

  it("returns failed when submit is called with no frozen evidence for the draft", async () => {
    const service = buildService();

    // No freezeEvidence call first - the dialog always freezes at report-open,
    // so reaching this means that call was skipped or the draft already
    // expired. Minting a fresh id here would break the idempotency invariant.
    const result = await service.submitReport(FORM);

    expect(result).toEqual({ status: "failed", reason: "error" });
    expect(sentryMock.captureFeedback).not.toHaveBeenCalled();
  });
});

describe("DesktopSupportService - evidence freeze semantics", () => {
  it("ships the tails captured at freeze time even after further log writes", async () => {
    const service = buildService();
    await service.freezeEvidence(FORM.draftId);

    // The crash-looping host that keeps writing while the dialog is open is
    // exactly the scenario the freeze exists for - the failing line must
    // still be in the shipped tail even though the file has moved on.
    await writeFile(hostLogPath, "line written after freeze\n", "utf8");

    await service.submitReport(FORM);

    const hostAttachment = lastHint().attachments.find(
      (a) => a.filename === "host.log",
    );
    expect(hostAttachment?.data).toContain("host log line");
    expect(hostAttachment?.data).not.toContain("line written after freeze");
  });

  it("drops the frozen evidence on discard, so a later submit fails honestly", async () => {
    const service = buildService();
    await service.freezeEvidence(FORM.draftId);
    service.discardFrozenEvidence(FORM.draftId);

    const result = await service.submitReport(FORM);

    expect(result).toEqual({ status: "failed", reason: "error" });
    expect(sentryMock.captureFeedback).not.toHaveBeenCalled();
  });

  it("serves readFrozenLogTail from the frozen copy, not a live read", async () => {
    const service = buildService();
    await service.freezeEvidence(FORM.draftId);
    await writeFile(hostLogPath, "line written after freeze\n", "utf8");

    const tail = await service.readFrozenLogTail({
      draftId: FORM.draftId,
      target: "host",
    });

    expect(tail.lines).toEqual(["host log line"]);
  });

  it("returns an empty tail from readFrozenLogTail once discarded", async () => {
    const service = buildService();
    await service.freezeEvidence(FORM.draftId);
    service.discardFrozenEvidence(FORM.draftId);

    const tail = await service.readFrozenLogTail({
      draftId: FORM.draftId,
      target: "host",
    });

    expect(tail).toEqual({
      target: "host",
      path: hostLogPath,
      lines: [],
      truncated: false,
    });
  });

  it("bounds each frozen attachment by bytes, not just line count", async () => {
    // 500 lines is not a size bound: one host log line can carry a multi-KB
    // payload, and an oversized envelope is dropped by Sentry after the event
    // is otherwise accepted.
    const fatLog = Array.from(
      { length: 100 },
      (_, i) => `line-${i}-${"x".repeat(20_000)}`,
    ).join("\n");
    await writeFile(hostLogPath, fatLog, "utf8");

    await freezeAndSubmit(buildService());

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
});

describe("DesktopSupportService - retry reuses the frozen reportId", () => {
  it("mints one reportId per draft and reuses it across every submit call", async () => {
    const service = buildService();
    const { reportId } = await service.freezeEvidence(FORM.draftId);

    const first = await service.submitReport(FORM);
    const second = await service.submitReport(FORM);

    expect(first.status === "delivered" && first.reportId).toBe(reportId);
    expect(second.status === "delivered" && second.reportId).toBe(reportId);
    expect(sentryMock.captureFeedback).toHaveBeenCalledTimes(2);
    const eventIds = sentryMock.captureFeedback.mock.calls.map(
      (call) => call[1].event_id,
    );
    // Same Sentry event_id both times - that is the idempotency mechanism
    // itself, not just an incidental match.
    expect(eventIds[0]).toBe(eventIds[1]);
  });

  it("mints a fresh reportId when a new freeze replaces the draft's evidence", async () => {
    const service = buildService();
    const { reportId: first } = await service.freezeEvidence(FORM.draftId);
    const { reportId: second } = await service.freezeEvidence(FORM.draftId);

    expect(second).not.toBe(first);
  });
});
