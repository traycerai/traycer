import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

const reportLedgerMock = vi.hoisted(() => ({
  recordFingerprintSighting: vi.fn(async (): Promise<void> => undefined),
  recordFiledReport: vi.fn(async (): Promise<void> => undefined),
  getFingerprintOccurrence: vi.fn(async () => null),
}));

vi.mock("../report-ledger", () => reportLedgerMock);

import { DesktopSupportService } from "../support";
import type { HostFsLayout } from "../../host/host-paths";
import type { SupportSubmitReportRequest } from "../../../ipc-contracts/window-types";

// The frozen-evidence key is composed in the IPC layer (sender id + draftId) -
// the service itself just takes an opaque string, so tests stand in with a
// fixed key rather than a bare draftId.
const KEY = "sender-1:1";

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
  await service.freezeEvidence(KEY, null);
  return service.submitReport(FORM, KEY);
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

  it("records a filed report on delivered only when a fingerprint is present", async () => {
    const service = buildService();
    await service.freezeEvidence(KEY, null);
    const result = await service.submitReport(
      {
        ...FORM,
        privateDiagnostics: {
          cause: null,
          registry: {
            routeTemplate: { status: "unavailable" },
            hostId: { status: "unavailable" },
            epicId: { status: "unavailable" },
            tabId: { status: "unavailable" },
            artifactId: { status: "unavailable" },
            chatId: { status: "unavailable" },
            agentId: { status: "unavailable" },
            harnessId: { status: "unavailable" },
            model: { status: "unavailable" },
            profileId: { status: "unavailable" },
            providerSelectionClass: { status: "unavailable" },
            providerVersion: { status: "unavailable" },
          },
          fingerprint: "fp:v1:abc",
          stackFamily: null,
          correlationId: "corr-1",
        },
      },
      KEY,
    );
    expect(result.status).toBe("delivered");
    expect(reportLedgerMock.recordFiledReport).toHaveBeenCalledWith(
      result.status === "delivered" ? result.reportId : "",
      "fp:v1:abc",
    );
  });

  it("does not record a filed report when the submit has no fingerprint", async () => {
    await freezeAndSubmit(buildService());
    expect(reportLedgerMock.recordFiledReport).not.toHaveBeenCalled();
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

  it("attaches both log tails, the host one labeled local-host (D10)", async () => {
    await freezeAndSubmit(buildService());

    expect(lastHint().attachments.map((a) => a.filename)).toEqual([
      "desktop.log",
      "local-host.log",
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
    expect(reportLedgerMock.recordFiledReport).not.toHaveBeenCalled();
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

  it("returns failed when submit is called with no frozen evidence for the key", async () => {
    const service = buildService();

    // No freezeEvidence call first - the dialog always freezes at report-open,
    // so reaching this means that call was skipped or the draft already
    // expired. Minting a fresh id here would break the idempotency invariant.
    const result = await service.submitReport(FORM, KEY);

    expect(result).toEqual({ status: "failed", reason: "error" });
    expect(sentryMock.captureFeedback).not.toHaveBeenCalled();
  });
});

describe("DesktopSupportService - fingerprint sightings on freeze", () => {
  it("records a sighting on first freeze admission when fingerprint is present", async () => {
    await buildService().freezeEvidence(KEY, "fp:v1:sight");
    expect(reportLedgerMock.recordFingerprintSighting).toHaveBeenCalledWith(
      "fp:v1:sight",
    );
  });

  it("does not re-record a sighting on the idempotent second freeze of a live key", async () => {
    const service = buildService();
    await service.freezeEvidence(KEY, "fp:v1:sight");
    await service.freezeEvidence(KEY, "fp:v1:sight");
    expect(reportLedgerMock.recordFingerprintSighting).toHaveBeenCalledTimes(1);
  });

  it("skips the sighting when fingerprint is null", async () => {
    await buildService().freezeEvidence(KEY, null);
    expect(reportLedgerMock.recordFingerprintSighting).not.toHaveBeenCalled();
  });
});

describe("DesktopSupportService - evidence freeze semantics", () => {
  it("ships the tails captured at freeze time even after further log writes", async () => {
    const service = buildService();
    await service.freezeEvidence(KEY, null);

    // The crash-looping host that keeps writing while the dialog is open is
    // exactly the scenario the freeze exists for - the failing line must
    // still be in the shipped tail even though the file has moved on.
    await writeFile(hostLogPath, "line written after freeze\n", "utf8");

    await service.submitReport(FORM, KEY);

    const hostAttachment = lastHint().attachments.find(
      (a) => a.filename === "local-host.log",
    );
    expect(hostAttachment?.data).toContain("host log line");
    expect(hostAttachment?.data).not.toContain("line written after freeze");
  });

  it("drops the frozen evidence on discard, so a later submit fails honestly", async () => {
    const service = buildService();
    await service.freezeEvidence(KEY, null);
    service.discardFrozenEvidence(KEY);

    const result = await service.submitReport(FORM, KEY);

    expect(result).toEqual({ status: "failed", reason: "error" });
    expect(sentryMock.captureFeedback).not.toHaveBeenCalled();
  });

  it("never lands evidence discarded while its file reads are still in flight", async () => {
    const service = buildService();

    // Not awaited: the synchronous prefix of `freezeEvidence` (up through
    // inserting the pending map entry) runs before this call returns, so the
    // discard below reliably lands before the file reads resolve - the exact
    // race a cancel-during-freeze produces in the real dialog.
    const freezePromise = service.freezeEvidence(KEY, null);
    service.discardFrozenEvidence(KEY);
    await freezePromise;

    const result = await service.submitReport(FORM, KEY);
    expect(result).toEqual({ status: "failed", reason: "error" });
    expect(sentryMock.captureFeedback).not.toHaveBeenCalled();
  });

  it("serves readFrozenLogTail from the frozen copy, not a live read", async () => {
    const service = buildService();
    await service.freezeEvidence(KEY, null);
    await writeFile(hostLogPath, "line written after freeze\n", "utf8");

    const tail = await service.readFrozenLogTail(KEY, "host");

    expect(tail.lines).toEqual(["host log line"]);
  });

  it("returns an empty tail from readFrozenLogTail once discarded", async () => {
    const service = buildService();
    await service.freezeEvidence(KEY, null);
    service.discardFrozenEvidence(KEY);

    const tail = await service.readFrozenLogTail(KEY, "host");

    expect(tail).toEqual({
      target: "host",
      path: hostLogPath,
      lines: [],
      truncated: false,
    });
  });

  it("bounds each frozen attachment by bytes, not just line count, and flags it truncated", async () => {
    // 500 lines is not a size bound: one host log line can carry a multi-KB
    // payload, and an oversized envelope is dropped by Sentry after the event
    // is otherwise accepted.
    const fatLog = Array.from(
      { length: 100 },
      (_, i) => `line-${i}-${"x".repeat(20_000)}`,
    ).join("\n");
    await writeFile(hostLogPath, fatLog, "utf8");

    const service = buildService();
    await service.freezeEvidence(KEY, null);
    const tail = await service.readFrozenLogTail(KEY, "host");
    // Fewer than 500 lines were written, so the line-count cap never fires -
    // only the byte cap did, and that alone must still flag `truncated`.
    expect(tail.truncated).toBe(true);

    await service.submitReport(FORM, KEY);
    const hostAttachment = lastHint().attachments.find(
      (a) => a.filename === "local-host.log",
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

describe("DesktopSupportService - freeze idempotency per key", () => {
  it("mints one reportId per draft and reuses it across every submit call", async () => {
    const service = buildService();
    const { reportId } = await service.freezeEvidence(KEY, null);

    const first = await service.submitReport(FORM, KEY);
    const second = await service.submitReport(FORM, KEY);

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

  it("returns the existing reportId when freezeEvidence is called again for an already-frozen live draft", async () => {
    const service = buildService();
    const { reportId: first } = await service.freezeEvidence(KEY, null);
    const { reportId: second } = await service.freezeEvidence(KEY, null);

    // Not a fresh mint: a second freeze of a still-live draft (React
    // StrictMode's dev double-effect, or an accidental duplicate call) must
    // not straddle a retry-vs-submit across two different report/event ids.
    expect(second).toBe(first);
  });

  it("resolves concurrent in-flight freezes of the same key to one shared reportId", async () => {
    const service = buildService();

    const [a, b] = await Promise.all([
      service.freezeEvidence(KEY, null),
      service.freezeEvidence(KEY, null),
    ]);

    expect(a.reportId).toBe(b.reportId);
  });

  it("mints a fresh reportId when freezing again after a discard - a genuinely new draft", async () => {
    const service = buildService();
    const { reportId: first } = await service.freezeEvidence(KEY, null);
    service.discardFrozenEvidence(KEY);
    const { reportId: second } = await service.freezeEvidence(KEY, null);

    expect(second).not.toBe(first);
  });
});

describe("DesktopSupportService.buildPublicDraft", () => {
  it("returns a reportId-aware draft after freeze, independent of Sentry", async () => {
    const service = buildService();
    const { reportId } = await service.freezeEvidence(KEY, null);
    expect(reportId).toMatch(/^rpt_[0-9a-f]{32}$/);

    const draft = await service.buildPublicDraft(FORM, KEY);

    expect(draft.truncated).toBe(false);
    expect(draft.title).toBe(FORM.title);
    expect(draft.fields["what-happened"]).toContain(FORM.whatHappened);
    expect(draft.fields.version).toBe("1.1.9");
    expect(draft.fields.component).toBe("Desktop app");
    // Non-empty stepsToReproduce pass through (scrubbed), not the placeholder.
    expect(draft.fields.repro).toBe(FORM.stepsToReproduce);
    expect(draft.fields.repro).not.toContain(reportId);
  });

  it("uses the reportId-aware placeholder when steps are empty", async () => {
    const service = buildService();
    const { reportId } = await service.freezeEvidence(KEY, null);
    const draft = await service.buildPublicDraft(
      { ...FORM, stepsToReproduce: "" },
      KEY,
    );
    expect(draft.fields.repro).toBe(
      `Not captured step-by-step - see the private support report ${reportId}.`,
    );
    expect(reportId).toMatch(/^rpt_[0-9a-f]{32}$/);
  });

  it("is callable and correct when Sentry has no DSN", async () => {
    sentryMock.isInitialized.mockReturnValue(false);
    const service = buildService();
    const { reportId } = await service.freezeEvidence(KEY, null);

    const draft = await service.buildPublicDraft(
      { ...FORM, stepsToReproduce: "" },
      KEY,
    );

    expect(draft.title).toBe(FORM.title);
    expect(draft.fields.repro).toBe(
      `Not captured step-by-step - see the private support report ${reportId}.`,
    );
    // buildPublicDraft must not consult Sentry at all (unlike submitReport).
    expect(sentryMock.captureFeedback).not.toHaveBeenCalled();
  });

  it("is callable and correct after a submitReport that returned failed", async () => {
    sentryMock.captureFeedback.mockImplementation(() => {
      throw new Error("DSN rejected");
    });
    const service = buildService();
    await service.freezeEvidence(KEY, null);

    const submitResult = await service.submitReport(FORM, KEY);
    expect(submitResult).toEqual({ status: "failed", reason: "error" });

    const draft = await service.buildPublicDraft(
      { ...FORM, stepsToReproduce: "" },
      KEY,
    );

    expect(draft.title).toBe(FORM.title);
    expect(draft.fields.repro).toMatch(
      /^Not captured step-by-step - see the private support report rpt_[0-9a-f]{32}\.$/,
    );
    expect(draft.fields.component).toBe("Desktop app");
  });

  it("scrubs every emitted field (paths and tokens never leave raw)", async () => {
    const service = buildService();
    await service.freezeEvidence(KEY, null);

    const sensitiveForm: SupportSubmitReportRequest = {
      ...FORM,
      whatHappened:
        "It broke, see /Users/anurag/project/log.txt for the Bearer abc123token",
      stepsToReproduce: "Check password: secretvalue",
      title: "Crash at /Users/anurag/project/x.ts",
    };

    const draft = await service.buildPublicDraft(sensitiveForm, KEY);

    expect(draft.fields["what-happened"]).not.toContain("/Users/anurag");
    expect(draft.fields["what-happened"]).not.toContain("abc123token");
    expect(draft.fields["what-happened"]).toContain("Bearer <redacted>");
    expect(draft.fields.repro).not.toContain("secretvalue");
    expect(draft.fields.repro).toContain("password: <redacted>");
    expect(draft.title).not.toContain("/Users/anurag");
  });
});

describe("DesktopSupportService.saveDiagnosticBundle", () => {
  it("writes scrubbed form fields and frozen log tails under logs.desktop/host", async () => {
    // Seed real log content with a path/token so freeze captures scrubbed tails.
    await writeFile(
      loggerMock.desktopLogPath,
      "desktop saw Bearer desktopsecret at /Users/anurag/desktop-leak.ts\n",
      "utf8",
    );
    await writeFile(
      hostLogPath,
      "host saw password: hostsecret near /Users/anurag/host-leak.ts\n",
      "utf8",
    );

    const service = buildService();
    await service.freezeEvidence(KEY, null);

    const sensitiveForm: SupportSubmitReportRequest = {
      ...FORM,
      title: "Bundle title /Users/anurag/title-leak.ts",
      whatHappened: "Bundle body Bearer formtoken",
      stepsToReproduce: "path /Users/anurag/steps.ts",
    };

    const { path } = await service.saveDiagnosticBundle(sensitiveForm, KEY);
    const raw = await readFile(path, "utf8");
    const bundle: unknown = JSON.parse(raw);
    expect(bundle).toEqual(
      expect.objectContaining({
        logs: expect.objectContaining({
          desktop: expect.any(String),
          host: expect.any(String),
        }),
      }),
    );

    const typed = bundle as {
      title: string;
      whatHappened: string;
      stepsToReproduce: string;
      logs: { desktop: string; host: string };
    };

    // Frozen log tails are present and were scrubbed at freeze time.
    expect(typed.logs.desktop).toContain("desktop saw");
    expect(typed.logs.desktop).toContain("Bearer <redacted>");
    expect(typed.logs.desktop).not.toContain("desktopsecret");
    expect(typed.logs.desktop).not.toContain("/Users/anurag");
    expect(typed.logs.host).toContain("host saw");
    expect(typed.logs.host).toContain("password: <redacted>");
    expect(typed.logs.host).not.toContain("hostsecret");
    expect(typed.logs.host).not.toContain("/Users/anurag");

    // Form fields written into the bundle are scrubbed.
    expect(typed.title).not.toContain("/Users/anurag");
    expect(typed.whatHappened).not.toContain("formtoken");
    expect(typed.whatHappened).toContain("Bearer <redacted>");
    expect(typed.stepsToReproduce).not.toContain("/Users/anurag");
    expect(raw).not.toContain("/Users/anurag");
    expect(raw).not.toContain("formtoken");
    expect(raw).not.toContain("desktopsecret");
    expect(raw).not.toContain("hostsecret");
  });
});
