import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, statSync, utimesSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { REPORT_LOG_TAIL_MAX_BYTES } from "@traycer-clients/shared/support/image-attachment-guards";

interface CapturedAttachment {
  readonly filename: string;
  /** Log tails ship as strings; image attachments ship as Uint8Array. */
  readonly data: string | Uint8Array;
  readonly contentType?: string;
}

interface CapturedHint {
  readonly event_id: string;
  readonly captureContext: {
    readonly tags: Record<string, string>;
    readonly contexts?: Record<string, unknown>;
  };
  readonly attachments: readonly CapturedAttachment[];
}

/**
 * The headers shape `TransportMakeRequestResponse` declares: an index
 * signature PLUS both named keys, REQUIRED and `string | null`
 * (`@sentry/core@10.70.0` `types/transport.d.ts`). Every fake response below
 * is built through {@link responseHeaders} so it carries both, which is what
 * the real transport hands the `afterSendEvent` hook - Sentry's own response
 * normalization fills both keys, `null` when the server sent neither, and
 * `updateRateLimits` reads a `null` value and an absent header identically.
 * A `Record<string, string | null>` here would have let the one fixture that
 * feeds the REAL `sentryReportRateLimitWindow.observe` pass a shape the
 * transport never produces.
 */
interface FakeSentryResponseHeaders {
  [key: string]: string | null;
  "x-sentry-rate-limits": string | null;
  "retry-after": string | null;
}

function responseHeaders(values: {
  readonly rateLimits: string | null;
  readonly retryAfter: string | null;
}): FakeSentryResponseHeaders {
  return {
    "x-sentry-rate-limits": values.rateLimits,
    "retry-after": values.retryAfter,
  };
}

interface FakeSendResponse {
  readonly statusCode?: number;
  readonly headers?: FakeSentryResponseHeaders;
}

interface FakeAfterSendEventListener {
  (event: { readonly event_id?: string }, sendResponse: FakeSendResponse): void;
}

interface FakeSentryClient {
  readonly on: (
    hook: "afterSendEvent",
    callback: FakeAfterSendEventListener,
  ) => () => void;
  readonly emitAfterSendEvent: FakeAfterSendEventListener;
  readonly listenerCount: () => number;
}

const sentryMock = vi.hoisted(() => ({
  isInitialized: vi.fn<() => boolean>(),
  captureFeedback: vi.fn<(feedback: unknown, hint: CapturedHint) => string>(),
  flush: vi.fn<(timeout: number) => Promise<boolean>>(),
  getClient: vi.fn<() => FakeSentryClient | undefined>(),
}));

const loggerMock = vi.hoisted(() => ({
  desktopLogPath: "",
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mutated per-test in `beforeEach` (real userData dir under this test's
// tempDir) so the offline-queue tests can write fixtures at the exact path
// `wasReportQueuedOffline` derives via `sentryOfflineQueuePath(app.getPath
// ("userData"))` - the same helper the production code uses, so the reader
// and this test's writer cannot silently look at two different directories.
const electronMock = vi.hoisted(() => ({ userDataPath: "" }));

vi.mock("electron", () => ({
  app: {
    getVersion: (): string => "1.1.9",
    getPath: (): string => electronMock.userDataPath,
  },
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

// Real-shaped `app.getAppMetrics()` output: `cpu`/`memory` nest two levels
// deep, which is exactly what Sentry's normalizeDepth flattens to "[Object]"
// placeholders past its budget - the bug this fixture exercises.
const FAKE_PROCESS_METRICS = {
  main: { private: 102_400, residentSet: 204_800, shared: 51_200 },
  cpuUsage: { user: 123_456, system: 7_890 },
  appMetrics: [
    {
      type: "Browser" as const,
      pid: 1111,
      name: undefined,
      serviceName: undefined,
      cpu: { percentCPUUsage: 1.5, idleWakeupsPerSecond: 2 },
      memory: { workingSetSize: 51_200, peakWorkingSetSize: 61_440 },
    },
    {
      type: "Utility" as const,
      pid: 2222,
      name: "Network Service",
      serviceName: undefined,
      cpu: { percentCPUUsage: 0.2, idleWakeupsPerSecond: 0 },
      memory: { workingSetSize: 10_240, peakWorkingSetSize: 12_288 },
    },
  ],
};

const diagnosticsMock = vi.hoisted(() => ({
  handleGetMetrics: vi.fn<() => Promise<typeof FAKE_PROCESS_METRICS>>(),
}));

vi.mock("../diagnostics", () => diagnosticsMock);

/**
 * The process-wide `sentryReportRateLimitWindow` replaced by a REAL window
 * with a per-test lifetime.
 *
 * Everything under test stays real: the object below delegates to an actual
 * `createSentryRateLimitWindow()` instance, so core's own header parsing and
 * its per-data-category semantics decide every answer - a limit naming
 * `error` still does not limit a report, because `isRateLimited` says so and
 * not because a stub said so. Only the LIFETIME changes, from process-wide to
 * per test, and that is what lets these tests drive a window at all: the real
 * singleton has no reset hook, so the one pre-existing test that fed it a
 * limit had to sleep past a 5-second window to avoid stranding every later
 * test in the file. It no longer does.
 *
 * `observe`'s `nowMs` is the test's lever for expiry - observing at a
 * back-dated timestamp makes a window that is already closed when
 * `submitReport` reads it, with no clock control and no waiting.
 */
const rateLimitWindowMock = vi.hoisted(() => {
  const state: { inner: SentryRateLimitWindow | null } = { inner: null };
  return {
    state,
    window: {
      observe: (
        response: TransportMakeRequestResponse,
        nowMs: number,
      ): void => {
        if (state.inner === null) throw new Error("window not installed");
        state.inner.observe(response, nowMs);
      },
      current: (nowMs: number): SentryReportRateLimit => {
        if (state.inner === null) throw new Error("window not installed");
        return state.inner.current(nowMs);
      },
    },
  };
});

vi.mock("../sentry-delivery-observer", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../sentry-delivery-observer")>();
  return { ...actual, sentryReportRateLimitWindow: rateLimitWindowMock.window };
});

import { DesktopSupportService } from "../support";
import {
  createSentryRateLimitWindow,
  sentryOfflineQueuePath,
  sentryReportRateLimitWindow,
  type SentryRateLimitWindow,
  type SentryReportRateLimit,
} from "../sentry-delivery-observer";
import type { TransportMakeRequestResponse } from "@sentry/core";
import type { HostFsLayout } from "../../host/host-paths";
import type { SupportSubmitReportRequest } from "../../../ipc-contracts/window-types";

// The frozen-evidence key is composed in the IPC layer (sender id + draftId) -
// the service itself just takes an opaque string, so tests stand in with a
// fixed key rather than a bare draftId.
const KEY = "sender-1:1";

const FORM: SupportSubmitReportRequest = {
  draftId: 1,
  type: "bug",
  intent: "It hangs on launch",
  frequency: null,
  location: null,
  allowContact: false,
  includeDesktopLog: true,
  includeHostLog: true,
  includeBrowserDiagnostics: true,
  includeDiagnostics: true,
  images: [],
  overrideTitle: null,
  // Most tests below exercise a confirmed-delivery buildPublicDraft call;
  // the handful exercising unavailable/failed routes override this to
  // "none" explicitly (see the "buildPublicDraft outcome honesty" describe).
  privateOutcome: "delivered",
};

const LOG_ATTACHMENT_MAX_BYTES = REPORT_LOG_TAIL_MAX_BYTES;

let tempDir = "";
let hostLogPath = "";

function buildService(
  signedInEmail: string | null | (() => string | null),
): DesktopSupportService {
  const hostLayout: HostFsLayout = {
    rootDir: tempDir,
    pidMetadataFile: join(tempDir, "pid.json"),
    identityEnrollmentFile: join(tempDir, "identity", "enrollment.json"),
    logFile: hostLogPath,
    installDir: join(tempDir, "install"),
    installRecordFile: join(tempDir, "install.json"),
    stagedDir: join(tempDir, "staged"),
    stagedRecordFile: join(tempDir, "staged.json"),
    pendingLoginItemRevisionFile: join(tempDir, "login-item"),
    substrateFile: join(tempDir, "substrate.json"),
    transitionJournalFile: join(tempDir, "transition.json"),
    browserTelemetryFile: join(tempDir, "browser-telemetry.jsonl"),
    browserTelemetryRotatedFile: join(tempDir, "browser-telemetry.jsonl.1"),
    browserTraceFile: join(tempDir, "browser-trace.jsonl"),
    browserTraceRotatedFile: join(tempDir, "browser-trace.jsonl.1"),
    environment: "production",
  };
  return new DesktopSupportService({
    appName: "Traycer",
    host: { getSnapshot: () => null },
    authSession: {
      get: () => {
        const email =
          typeof signedInEmail === "function" ? signedInEmail() : signedInEmail;
        return email === null
          ? { status: "signed-out", token: null, profile: null }
          : {
              status: "signed-in",
              token: "token",
              profile: {
                userId: "user-1",
                userName: "Test User",
                email,
              },
            };
      },
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

function makeFakeSentryClient(): FakeSentryClient {
  const listeners = new Set<FakeAfterSendEventListener>();
  return {
    on: (_hook, callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    emitAfterSendEvent: (event, sendResponse) => {
      for (const listener of listeners) listener(event, sendResponse);
    },
    listenerCount: () => listeners.size,
  };
}

/**
 * Writes a fixture directly under the offline-queue path
 * `sentryOfflineQueuePath(app.getPath("userData"))` derives - the same one
 * `wasReportQueuedOffline` reads. Each entry is `{id, eventId}`: when
 * `eventId` is a string, the body's envelope header carries it as
 * `event_id`; `null` writes a header with NO `event_id` key at all (the
 * "index names an entry, but its body doesn't identify our envelope"
 * shape), and omitting a body entirely (`hasBody: false`) simulates the
 * store's own index write landing while the body write did not.
 */
async function writeOfflineQueueFixture(
  entries: ReadonlyArray<{
    readonly id: string;
    readonly eventId: string | null;
    readonly hasBody?: boolean;
  }>,
): Promise<void> {
  const queuePath = sentryOfflineQueuePath(electronMock.userDataPath);
  await mkdir(queuePath, { recursive: true });
  await writeFile(
    join(queuePath, "queue-v2.json"),
    JSON.stringify(
      entries.map((e) => ({ id: e.id, date: new Date().toISOString() })),
    ),
    "utf8",
  );
  for (const entry of entries) {
    if (entry.hasBody === false) continue;
    const header =
      entry.eventId === null
        ? JSON.stringify({ sent_at: new Date().toISOString() })
        : JSON.stringify({
            event_id: entry.eventId,
            sent_at: new Date().toISOString(),
          });
    const itemHeader = JSON.stringify({ type: "event" });
    const payload =
      entry.eventId === null
        ? "{}"
        : JSON.stringify({ event_id: entry.eventId });
    await writeFile(
      join(queuePath, entry.id),
      `${header}\n${itemHeader}\n${payload}\n`,
      "utf8",
    );
  }
}

let defaultFakeClient: FakeSentryClient;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "traycer-support-"));
  loggerMock.desktopLogPath = join(tempDir, "traycer-desktop.log");
  hostLogPath = join(tempDir, "host.log");
  electronMock.userDataPath = join(tempDir, "userdata");
  await writeFile(loggerMock.desktopLogPath, "desktop log line\n", "utf8");
  await writeFile(hostLogPath, "host log line\n", "utf8");
  sentryMock.isInitialized.mockReturnValue(true);
  // Default happy path: a real observed 2xx on OUR event, not the bare
  // `flush` boolean. `resolveDeliveryOutcome` now requires an explicit 2xx
  // to call anything "delivered" - the old code's null-outcome fallthrough
  // to "delivered" is gone, so every test below that doesn't itself drive a
  // different outcome needs a client whose `afterSendEvent` genuinely fires
  // with a 200, or it would see `unconfirmed` instead.
  defaultFakeClient = makeFakeSentryClient();
  sentryMock.getClient.mockReturnValue(defaultFakeClient);
  sentryMock.flush.mockImplementation(async () => {
    defaultFakeClient.emitAfterSendEvent(
      { event_id: lastHint().event_id },
      { statusCode: 200 },
    );
    return true;
  });
  diagnosticsMock.handleGetMetrics.mockResolvedValue(FAKE_PROCESS_METRICS);
  rateLimitWindowMock.state.inner = createSentryRateLimitWindow();
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
    const result = await freezeAndSubmit(buildService(null));

    expect(result.status).toBe("delivered");
    expect(result.status === "delivered" && result.reportId).toMatch(
      /^rpt_[0-9a-f]{32}$/,
    );
    expect(sentryMock.captureFeedback).toHaveBeenCalledTimes(1);
  });

  it("records a filed report on delivered only when a fingerprint is present", async () => {
    const service = buildService(null);
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
    await freezeAndSubmit(buildService(null));
    expect(reportLedgerMock.recordFiledReport).not.toHaveBeenCalled();
  });

  it("tags the feedback event with the id it hands back", async () => {
    const result = await freezeAndSubmit(buildService(null));

    // The id is a `reportId` tag, not a Sentry event id - it is the only handle
    // triage has, so an id that is not on the event would be unfindable.
    expect(result.status === "delivered" && result.reportId).toBe(
      lastHint().captureContext.tags.reportId,
    );
  });

  it("uses the reportId's suffix (dashes stripped) as the Sentry event_id", async () => {
    const result = await freezeAndSubmit(buildService(null));

    const reportId = result.status === "delivered" ? result.reportId : "";
    expect(lastHint().event_id).toBe(reportId.slice("rpt_".length));
  });

  it("attaches both log tails, the host one labeled local-host (D10)", async () => {
    await freezeAndSubmit(buildService(null));

    expect(lastHint().attachments.map((a) => a.filename)).toEqual([
      "desktop.log",
      "local-host.log",
    ]);
  });

  it("survives Sentry's real normalize() with no '[Object]' placeholder anywhere in contexts", async () => {
    // Round 1 of this fix (flattening each appMetrics entry to scalar
    // fields) passed a unit test asserting the helper's *return value*, but
    // a live delivered event still showed four "[Object]" placeholders -
    // Sentry normalizes the whole `contexts` object under one shared depth
    // budget, and `processMetrics.appMetrics[i]` sat one level too deep for
    // even a fully-flattened entry to survive it. This test runs the actual
    // captured `contexts` through Sentry's own `normalize()` (not a mock, not
    // this file's helper) at its real default depth (3, unset in this app's
    // Sentry.init) - the only assertion that would have caught round 1's gap.
    const { normalize } = await import("@sentry/core");
    await freezeAndSubmit(buildService(null));

    const contexts = lastHint().captureContext.contexts;
    const normalized = normalize(contexts, 3);
    const serialized = JSON.stringify(normalized);

    expect(serialized).not.toContain("[Object]");
    expect(serialized).not.toContain("[Array]");
  });

  it("puts appMetrics next to, not nested inside, processMetrics - the depth that actually fixed it", async () => {
    await freezeAndSubmit(buildService(null));

    const contexts = lastHint().captureContext.contexts as
      | {
          readonly processMetrics: {
            readonly main: unknown;
            readonly cpuUsage: unknown;
          };
          readonly appMetrics: Record<string, Record<string, unknown>>;
        }
      | undefined;
    expect(contexts).toBeDefined();
    expect(
      Object.prototype.hasOwnProperty.call(
        contexts?.processMetrics ?? {},
        "appMetrics",
      ),
    ).toBe(false);

    // Object.values, not array indexing: the wire shape is a numeric-keyed
    // record ({"0": {...}, "1": {...}}), not an array - Sentry's `Contexts`
    // type requires a plain record for every named context, and the two
    // shapes normalize identically.
    const entries = Object.values(contexts?.appMetrics ?? {});
    expect(entries).toEqual([
      {
        type: "Browser",
        pid: 1111,
        name: null,
        cpuPercent: 1.5,
        cpuIdleWakeupsPerSecond: 2,
        memoryWorkingSetKb: 51_200,
        memoryPeakWorkingSetKb: 61_440,
      },
      {
        type: "Utility",
        pid: 2222,
        name: "Network Service",
        cpuPercent: 0.2,
        cpuIdleWakeupsPerSecond: 0,
        memoryWorkingSetKb: 10_240,
        memoryPeakWorkingSetKb: 12_288,
      },
    ]);
    for (const entry of entries) {
      for (const value of Object.values(entry)) {
        const isScalarOrNull =
          value === null ||
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean";
        expect(isScalarOrNull).toBe(true);
      }
    }

    // main/cpuUsage are already flat in Electron's own types - ride through
    // unchanged, still nested under processMetrics.
    expect(contexts?.processMetrics.main).toEqual(FAKE_PROCESS_METRICS.main);
    expect(contexts?.processMetrics.cpuUsage).toEqual(
      FAKE_PROCESS_METRICS.cpuUsage,
    );
  });

  it("waits longer than the old 2s budget before giving up", async () => {
    await freezeAndSubmit(buildService(null));

    expect(sentryMock.flush).toHaveBeenCalledWith(10_000);
  });
});

describe("DesktopSupportService.submitReport - consent panel log toggles", () => {
  it("withholds the desktop log attachment when its toggle is off", async () => {
    const service = buildService(null);
    await service.freezeEvidence(KEY, null);
    await service.submitReport(
      { ...FORM, includeDesktopLog: false, includeHostLog: true },
      KEY,
    );
    expect(lastHint().attachments.map((a) => a.filename)).toEqual([
      "local-host.log",
    ]);
  });

  it("withholds the host log attachment when its toggle is off", async () => {
    const service = buildService(null);
    await service.freezeEvidence(KEY, null);
    await service.submitReport(
      { ...FORM, includeDesktopLog: true, includeHostLog: false },
      KEY,
    );
    expect(lastHint().attachments.map((a) => a.filename)).toEqual([
      "desktop.log",
    ]);
  });

  it("withholds both attachments when both toggles are off", async () => {
    const service = buildService(null);
    await service.freezeEvidence(KEY, null);
    await service.submitReport(
      { ...FORM, includeDesktopLog: false, includeHostLog: false },
      KEY,
    );
    expect(lastHint().attachments).toEqual([]);
  });
});

// Ticket 03 / plan D3: one consent flag covers both browser diagnostic
// files, each skipped independently of the other when its own tail is
// empty - same "toggle off must actually withhold it" invariant as the
// desktop/host toggles above, plus the "absence is normal" skip-on-empty
// rule that has no desktop/host equivalent (those two always exist).
describe("DesktopSupportService.submitReport - browser diagnostics consent (ticket 03)", () => {
  it("skips both browser attachments when neither file exists, even with the toggle on", async () => {
    const service = buildService(null);
    await service.freezeEvidence(KEY, null);
    await service.submitReport(
      { ...FORM, includeBrowserDiagnostics: true },
      KEY,
    );
    expect(lastHint().attachments.map((a) => a.filename)).toEqual([
      "desktop.log",
      "local-host.log",
    ]);
  });

  it("attaches both browser files when present and the toggle is on", async () => {
    await writeFile(
      join(tempDir, "browser-telemetry.jsonl"),
      '{"seq":1,"kind":"nav"}\n',
      "utf8",
    );
    await writeFile(
      join(tempDir, "browser-trace.jsonl"),
      '{"seq":1,"kind":"cdp.command"}\n',
      "utf8",
    );
    const service = buildService(null);
    await service.freezeEvidence(KEY, null);
    await service.submitReport(
      { ...FORM, includeBrowserDiagnostics: true },
      KEY,
    );
    expect(lastHint().attachments.map((a) => a.filename)).toEqual([
      "desktop.log",
      "local-host.log",
      "browser-telemetry.jsonl",
      "browser-trace.jsonl",
    ]);
  });

  it("withholds both browser attachments when the toggle is off, even though the files exist", async () => {
    await writeFile(
      join(tempDir, "browser-telemetry.jsonl"),
      '{"seq":1,"kind":"nav"}\n',
      "utf8",
    );
    await writeFile(
      join(tempDir, "browser-trace.jsonl"),
      '{"seq":1,"kind":"cdp.command"}\n',
      "utf8",
    );
    const service = buildService(null);
    await service.freezeEvidence(KEY, null);
    await service.submitReport(
      { ...FORM, includeBrowserDiagnostics: false },
      KEY,
    );
    expect(lastHint().attachments.map((a) => a.filename)).toEqual([
      "desktop.log",
      "local-host.log",
    ]);
  });
});

describe("DesktopSupportService.submitReport - private identity", () => {
  it("attaches the signed-in email despite the legacy allowContact:false flag", async () => {
    const service = buildService("anurag@traycer.ai");
    await service.freezeEvidence(KEY, null);
    await service.submitReport({ ...FORM, allowContact: false }, KEY);

    const [feedback] = sentryMock.captureFeedback.mock.calls.at(-1) ?? [];
    expect(
      (feedback as { name?: string; email?: string } | undefined)?.name,
    ).toBe("anurag@traycer.ai");
    expect(
      (feedback as { name?: string; email?: string } | undefined)?.email,
    ).toBe("anurag@traycer.ai");
  });

  it("attaches identity when allowContact is true and a signed-in email exists", async () => {
    const service = buildService("anurag@traycer.ai");
    await service.freezeEvidence(KEY, null);
    await service.submitReport({ ...FORM, allowContact: true }, KEY);

    const [feedback] = sentryMock.captureFeedback.mock.calls.at(-1) ?? [];
    expect(
      (feedback as { name?: string; email?: string } | undefined)?.name,
    ).toBe("anurag@traycer.ai");
    expect(
      (feedback as { name?: string; email?: string } | undefined)?.email,
    ).toBe("anurag@traycer.ai");
  });

  it("stays anonymous when there is no signed-in email", async () => {
    const service = buildService(null);
    await service.freezeEvidence(KEY, null);
    await service.submitReport({ ...FORM, allowContact: true }, KEY);

    const [feedback] = sentryMock.captureFeedback.mock.calls.at(-1) ?? [];
    expect(
      (feedback as { name?: string; email?: string } | undefined)?.name,
    ).toBe("anonymous");
    expect(
      (feedback as { name?: string; email?: string } | undefined)?.email,
    ).toBeUndefined();
  });

  it("uses the email frozen when the draft opened after the account changes", async () => {
    let email: string | null = "first@traycer.ai";
    const service = buildService(() => email);
    await service.freezeEvidence(KEY, null);
    email = "second@traycer.ai";

    await service.submitReport(FORM, KEY);

    const [feedback] = sentryMock.captureFeedback.mock.calls.at(-1) ?? [];
    expect((feedback as { email?: string } | undefined)?.email).toBe(
      "first@traycer.ai",
    );
  });

  it("keeps a signed-out draft anonymous after sign-in", async () => {
    let email: string | null = null;
    const service = buildService(() => email);
    await service.freezeEvidence(KEY, null);
    email = "later@traycer.ai";

    await service.submitReport(FORM, KEY);

    const [feedback] = sentryMock.captureFeedback.mock.calls.at(-1) ?? [];
    expect(
      (feedback as { name?: string; email?: string } | undefined)?.name,
    ).toBe("anonymous");
    expect((feedback as { email?: string } | undefined)?.email).toBeUndefined();
  });
});

describe("DesktopSupportService.submitReport - includeDiagnostics gate", () => {
  const diagnosticsForm: SupportSubmitReportRequest = {
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
      fingerprint: "fp:v1:gate",
      stackFamily: "family-a",
      correlationId: "corr-gate",
    },
  };

  it("omits layer-0/process-metrics/version-platform-host tags and every context when off", async () => {
    const service = buildService(null);
    await service.freezeEvidence(KEY, null);
    await service.submitReport(
      { ...diagnosticsForm, includeDiagnostics: false },
      KEY,
    );
    const { tags, contexts } = lastHint().captureContext;
    expect(tags.appVersion).toBeUndefined();
    expect(tags.platform).toBeUndefined();
    expect(tags.localHostVersion).toBeUndefined();
    expect(tags.electronVersion).toBeUndefined();
    expect(tags.layer0Status).toBeUndefined();
    expect(tags.stackFamily).toBeUndefined();
    expect(contexts).toBeUndefined();
  });

  it("still tags the report's own identity - reportId, fingerprint, correlationId - when off", async () => {
    const service = buildService(null);
    await service.freezeEvidence(KEY, null);
    await service.submitReport(
      { ...diagnosticsForm, includeDiagnostics: false },
      KEY,
    );
    const { tags } = lastHint().captureContext;
    expect(tags.reportId).toMatch(/^rpt_[0-9a-f]{32}$/);
    expect(tags.fingerprint).toBe("fp:v1:gate");
    expect(tags.correlationId).toBe("corr-gate");
  });

  it("includes the gated tags and a registry context when on", async () => {
    const service = buildService(null);
    await service.freezeEvidence(KEY, null);
    await service.submitReport(
      { ...diagnosticsForm, includeDiagnostics: true },
      KEY,
    );
    const { tags, contexts } = lastHint().captureContext;
    expect(tags.appVersion).toBeDefined();
    expect(tags.platform).toBeDefined();
    expect(tags.localHostVersion).toBeDefined();
    expect(tags.electronVersion).toBeDefined();
    expect(tags.layer0Status).toBe("absent");
    expect(tags.stackFamily).toBe("family-a");
    expect(contexts?.registry).toBeDefined();
  });
});

describe("DesktopSupportService.submitReport - unavailable", () => {
  it("returns unavailable and uploads nothing when Sentry has no DSN", async () => {
    sentryMock.isInitialized.mockReturnValue(false);

    const result = await freezeAndSubmit(buildService(null));

    expect(result).toEqual({ status: "unavailable" });
    expect(sentryMock.captureFeedback).not.toHaveBeenCalled();
    expect(sentryMock.flush).not.toHaveBeenCalled();
    expect(reportLedgerMock.recordFiledReport).not.toHaveBeenCalled();
  });

  it("reflects DSN presence on the support snapshot as privateDeliveryAvailable", async () => {
    sentryMock.isInitialized.mockReturnValue(false);
    const withoutDsn = await buildService(null).getSnapshot();
    expect(withoutDsn.privateDeliveryAvailable).toBe(false);

    sentryMock.isInitialized.mockReturnValue(true);
    const withDsn = await buildService(null).getSnapshot();
    expect(withDsn.privateDeliveryAvailable).toBe(true);
  });
});

describe("DesktopSupportService.submitReport - unconfirmed", () => {
  it("returns unconfirmed with the reportId when the flush times out - never failed", async () => {
    sentryMock.flush.mockResolvedValue(false);

    const result = await freezeAndSubmit(buildService(null));

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

    const result = await freezeAndSubmit(buildService(null));

    expect(result.status).toBe("unconfirmed");
  });
});

describe("DesktopSupportService.submitReport - Sentry send outcome (afterSendEvent)", () => {
  // E2E Round 3 F1: `flush` draining the queue was read as "delivered" even
  // when Sentry's store definitively rejected the event (HTTP 500, or the
  // connection destroyed after receiving the body) - draining only means the
  // envelope reached the transport, not that the store accepted it. These
  // tests drive the real per-event outcome mechanism (`afterSendEvent`)
  // instead of trusting `flush`'s boolean alone.
  let fakeClient: FakeSentryClient;

  beforeEach(() => {
    fakeClient = makeFakeSentryClient();
    sentryMock.getClient.mockReturnValue(fakeClient);
  });

  function mockFlushWithSendOutcome(sendResponse: FakeSendResponse): void {
    // Stands in for the SDK: by the time `flush` is called, `captureFeedback`
    // has already run, so the event_id it used is on the last captured hint -
    // exactly what `afterSendEvent` would carry for the event actually sent.
    sentryMock.flush.mockImplementationOnce(async () => {
      fakeClient.emitAfterSendEvent(
        { event_id: lastHint().event_id },
        sendResponse,
      );
      return true;
    });
  }

  it("returns delivered when afterSendEvent reports a 2xx status for our event", async () => {
    mockFlushWithSendOutcome({ statusCode: 200 });

    const result = await freezeAndSubmit(buildService(null));

    expect(result.status).toBe("delivered");
    expect(reportLedgerMock.recordFiledReport).not.toHaveBeenCalled();
  });

  it("returns failed, not delivered, when afterSendEvent reports a 500", async () => {
    mockFlushWithSendOutcome({ statusCode: 500 });

    const result = await freezeAndSubmit(buildService(null));

    // The live gap this closes: a 500 previously still came back "Sent
    // privately" with a report id that existed nowhere.
    expect(result).toEqual({ status: "failed", reason: "error" });
  });

  it("maps a 429 with a retry-after header to rate-limited, with the header's own seconds - not core's 60s default", async () => {
    mockFlushWithSendOutcome({
      statusCode: 429,
      headers: responseHeaders({ rateLimits: null, retryAfter: "90" }),
    });

    const result = await freezeAndSubmit(buildService(null));

    expect(result).toEqual({
      status: "failed",
      reason: "rate-limited",
      retryAfterSeconds: 90,
    });
  });

  it("maps a 429 with NO retry-after header to rate-limited with null seconds - never inventing core's 60s default", async () => {
    mockFlushWithSendOutcome({ statusCode: 429 });

    const result = await freezeAndSubmit(buildService(null));

    // This is the reason the direct-429 arm reads only THIS response's
    // header: the window's own `current()` would answer 60 here (core's
    // default guess for a bare 429), but that is not something the server
    // actually said about this response.
    expect(result).toEqual({
      status: "failed",
      reason: "rate-limited",
      retryAfterSeconds: null,
    });
  });

  it("an undefined status earned by a DIFFERENT event's 429 still maps to rate-limited (the RCA's own scenario)", async () => {
    // The rate-limit window is fed by a CLIENT-WIDE observer in
    // `crash-reporter.ts` (`client.on("afterSendEvent", (_, r) =>
    // window.observe(r, Date.now()))`), not by `support.ts`'s own per-event
    // hook - a 429 earned by a crash report sharing the same DSN quota is
    // exactly what a per-event hook cannot see on its own. Simulate that
    // observer directly here, rather than importing `crash-reporter.ts`
    // (which pulls in far more than this test needs).
    const observedAt = Date.now();
    sentryReportRateLimitWindow.observe(
      {
        statusCode: 429,
        headers: responseHeaders({ rateLimits: null, retryAfter: "5" }),
      },
      observedAt,
    );
    // Our own event gets no HTTP response at all (network failure, or the
    // SDK's client-side drop under the very limit just observed) -
    // `resolveDeliveryOutcome` must still recognize the still-active window
    // and not fall through to `unconfirmed`. No cleanup and no sleeping: the
    // window is installed fresh per test (see `rateLimitWindowMock`), so a
    // limit fed here cannot reach any other test.
    mockFlushWithSendOutcome({});

    const result = await freezeAndSubmit(buildService(null));

    expect(result.status).toBe("failed");
    expect(result.status === "failed" && result.reason).toBe("rate-limited");
  });

  // --- Cold review P2: a 2xx is a fact about the envelope that was SENT ---
  //
  // `createTransport.send` filters envelope ITEMS independently by data
  // category (`@sentry/core` `transports/base.js`: `isRateLimited(rateLimits,
  // dataCategory)` per item, then it sends whatever survived), and
  // `Client.sendEvent` appends each attachment as its own item before
  // forwarding that ONE transport response to every `afterSendEvent`
  // listener. Under a window naming `feedback` only, a report therefore goes
  // out as its log attachments MINUS the feedback item, and the 2xx those
  // attachments earned is what reaches the hook. Every report carries log
  // attachments, so this is that window's ordinary shape, not a corner of it.
  it("a 2xx earned while a feedback-category limit was already in force is rate-limited, not delivered, and files no report", async () => {
    // The limit a PRIOR response established - the crash-reporter observer's
    // job, simulated directly as in the test above.
    sentryReportRateLimitWindow.observe(
      {
        statusCode: 429,
        headers: responseHeaders({
          rateLimits: "60:feedback",
          retryAfter: null,
        }),
      },
      Date.now(),
    );
    mockFlushWithSendOutcome({ statusCode: 200 });

    const result = await freezeAndSubmit(buildService(null));

    expect(result).toEqual({
      status: "failed",
      reason: "rate-limited",
      retryAfterSeconds: 60,
    });
    // The half that made this a P2 rather than a copy bug: a filed-report
    // ledger entry for a report Sentry never received inflates every later
    // router count and fixed-in query.
    expect(reportLedgerMock.recordFiledReport).not.toHaveBeenCalled();
  });

  it.each([["60:error"], ["60:default"], ["60:error;default:organization"]])(
    "a 2xx under a limit naming only %s is delivered - a limit that does not name feedback must not stop a report",
    async (rateLimits) => {
      sentryReportRateLimitWindow.observe(
        {
          statusCode: 429,
          headers: responseHeaders({ rateLimits, retryAfter: null }),
        },
        Date.now(),
      );
      mockFlushWithSendOutcome({ statusCode: 200 });

      const result = await freezeAndSubmit(buildService(null));

      expect(result.status).toBe("delivered");
    },
  );

  it("a 2xx under an EXPIRED feedback limit is delivered", async () => {
    // Observed two minutes ago with a 60s window, so it is closed by the time
    // `submitReport` reads it. Back-dating `observe`'s own `nowMs` is what
    // makes expiry testable with no clock control and no waiting.
    sentryReportRateLimitWindow.observe(
      {
        statusCode: 429,
        headers: responseHeaders({
          rateLimits: "60:feedback",
          retryAfter: null,
        }),
      },
      Date.now() - 120_000,
    );
    mockFlushWithSendOutcome({ statusCode: 200 });

    const result = await freezeAndSubmit(buildService(null));

    expect(result.status).toBe("delivered");
  });

  it("a 2xx whose OWN response opens the feedback window is still delivered - the limit did not exist when our item was sent", async () => {
    // Not in the review's list, and the reason the gate reads a pre-send
    // SNAPSHOT rather than the live window. Sentry's usual way of opening a
    // window is the very response that accepted the event, and
    // `crash-reporter.ts`'s observer is registered at `init` while
    // `support.ts` subscribes per submit - `Client.on` keeps hooks in a `Set`
    // that `emit` walks in insertion order, so the observer has already
    // folded this response's headers in before our hook runs. A live read
    // here would call a report that LANDED rate-limited and send the user
    // back to retry it.
    const client = makeFakeSentryClient();
    sentryMock.getClient.mockReturnValue(client);
    sentryMock.flush.mockImplementationOnce(async () => {
      const accepted: TransportMakeRequestResponse = {
        statusCode: 200,
        headers: responseHeaders({
          rateLimits: "60:feedback",
          retryAfter: null,
        }),
      };
      // Observer first, exactly as insertion order dictates in production.
      sentryReportRateLimitWindow.observe(accepted, Date.now());
      client.emitAfterSendEvent({ event_id: lastHint().event_id }, accepted);
      return true;
    });

    const result = await freezeAndSubmit(buildService(null));

    expect(result.status).toBe("delivered");
    // ...and the window really is limited now, so the assertion above is not
    // passing because the header was ignored.
    expect(sentryReportRateLimitWindow.current(Date.now()).limited).toBe(true);
  });

  it("an undefined status, no rate limit, and the offline queue confirmed holding this envelope maps to queued", async () => {
    mockFlushWithSendOutcome({});
    const service = buildService(null);
    // The Sentry event id is a pure, deterministic derivation of the
    // reportId (`sentryEventIdFromReportId`: the uuid suffix, dashes
    // stripped) - freezing first lets the fixture below name the exact id
    // `captureFeedback` will use.
    const draft = await service.freezeEvidence(KEY, null);
    const eventId = draft.reportId.slice("rpt_".length);
    await writeOfflineQueueFixture([{ id: "entry-a", eventId }]);

    // The read happens in the same tick `flush` resolves, well before the
    // offline transport's own 5s replay timer (`START_DELAY` on the
    // queue-on-error path in `@sentry/core`'s offline transport) could ever
    // fire, so there is no clock to race here.
    const result = await service.submitReport(FORM, KEY);

    expect(result).toEqual({ status: "queued", reportId: draft.reportId });
    expect(reportLedgerMock.recordFiledReport).not.toHaveBeenCalled();
  });

  it("an undefined status, no rate limit, and a queue that does NOT hold this envelope (cap-dropped) maps to unconfirmed - even though flush and the inner push both resolved", async () => {
    mockFlushWithSendOutcome({});
    const service = buildService(null);
    const draft = await service.freezeEvidence(KEY, null);
    // The index names an entry, but for a DIFFERENT event - exactly what the
    // store's cap-drop path leaves behind (the body is unlinked, the index
    // is left as it was for whatever was already queued).
    await writeOfflineQueueFixture([
      { id: "entry-someone-else", eventId: "some-other-event" },
    ]);

    const result = await service.submitReport(FORM, KEY);

    expect(result).toEqual({ status: "unconfirmed", reportId: draft.reportId });
  });

  it("two different event ids where only one is actually queued answer queued and unconfirmed respectively", async () => {
    // Deviation from the sub-plan's wrapper design, noted in the brief: this
    // is exact attribution off the envelope's own `event_id`, not a
    // set-difference over a wrapped `push` - so the case that matters is two
    // DIFFERENT events where only one is actually in the queue, not a
    // concurrent-push race.
    const queuedService = buildService(null);
    const queuedDraft = await queuedService.freezeEvidence(KEY, null);
    const queuedEventId = queuedDraft.reportId.slice("rpt_".length);

    const droppedService = buildService(null);
    const droppedDraft = await droppedService.freezeEvidence(
      "sender-1:2",
      null,
    );

    await writeOfflineQueueFixture([
      { id: "entry-queued", eventId: queuedEventId },
    ]);

    mockFlushWithSendOutcome({});
    const queuedResult = await queuedService.submitReport(FORM, KEY);
    expect(queuedResult).toEqual({
      status: "queued",
      reportId: queuedDraft.reportId,
    });

    mockFlushWithSendOutcome({});
    const droppedResult = await droppedService.submitReport(FORM, "sender-1:2");
    expect(droppedResult).toEqual({
      status: "unconfirmed",
      reportId: droppedDraft.reportId,
    });
  });

  it("an index entry whose body the store's writeFile swallowed (never named the envelope) maps to unconfirmed, never failed", async () => {
    mockFlushWithSendOutcome({});
    const service = buildService(null);
    const draft = await service.freezeEvidence(KEY, null);
    // `Store.set` swallows a failed `writeFile` internally - the in-memory
    // queue can hold an envelope the disk index never named. Simulate the
    // disk-side symptom directly: no queue-v2.json at all (the write never
    // landed), which is indistinguishable from "nothing queued" to a reader
    // that only ever sees disk.
    // (No fixture written - `sentryOfflineQueuePath` resolves to a
    // directory that simply doesn't exist yet.)

    const result = await service.submitReport(FORM, KEY);

    expect(result).toEqual({ status: "unconfirmed", reportId: draft.reportId });
  });

  it("a transport throw the SDK swallows into {} (undefined status, no evidence either way) maps to unconfirmed", async () => {
    // `sendEnvelope`'s catch turns a transport-level throw into the same
    // shape as a queued-and-returned-{} response at the hook - this test
    // exists so that shape is pinned as `unconfirmed`, not `failed`, even
    // with nothing at all backing a `queued` verdict.
    mockFlushWithSendOutcome({});

    const result = await freezeAndSubmit(buildService(null));

    expect(result.status).toBe("unconfirmed");
  });

  it("a NULL outcome (afterSendEvent never fires within the grace window) maps to unconfirmed, never delivered - the old fallthrough is gone", async () => {
    // Unlike `still returns unconfirmed on silence` below (where `flush`
    // itself times out first), here `flush` resolves true - the queue
    // genuinely drained - but no listener ever fires. This exercises
    // `awaitOutcome`'s own `SEND_OUTCOME_GRACE_MS` timeout, which is a real
    // (short, ~500ms) wait; there is nothing in `support.ts` to inject a
    // clock into for it.
    fakeClient = makeFakeSentryClient();
    sentryMock.getClient.mockReturnValue(fakeClient);
    sentryMock.flush.mockResolvedValueOnce(true);

    const result = await freezeAndSubmit(buildService(null));

    expect(result.status).toBe("unconfirmed");
    expect(result.status).not.toBe("delivered");
  }, 5_000);

  it("still returns unconfirmed on silence - the flush-timeout path is unchanged", async () => {
    // The hook never fires at all (the send is still in flight); `flush`
    // itself gives up first. Must stay byte-identical to the pre-existing
    // flush-timeout path, not get reclassified by the new mechanism.
    sentryMock.flush.mockResolvedValueOnce(false);

    const result = await freezeAndSubmit(buildService(null));

    expect(result.status).toBe("unconfirmed");
  });

  it("a 500-then-retry flow reuses the same reportId and can subsequently succeed", async () => {
    const service = buildService(null);
    const { reportId } = await service.freezeEvidence(KEY, null);

    mockFlushWithSendOutcome({ statusCode: 500 });
    const first = await service.submitReport(FORM, KEY);
    expect(first).toEqual({ status: "failed", reason: "error" });

    mockFlushWithSendOutcome({ statusCode: 200 });
    const second = await service.submitReport(FORM, KEY);
    expect(second.status).toBe("delivered");
    expect(second.status === "delivered" && second.reportId).toBe(reportId);

    // Same Sentry event_id on both attempts - the retry rode the same
    // idempotency key, not a fresh one.
    const eventIds = sentryMock.captureFeedback.mock.calls.map(
      (call) => call[1].event_id,
    );
    expect(eventIds[0]).toBe(eventIds[1]);
  });

  it("unsubscribes its afterSendEvent listener once a delivered submit settles", async () => {
    mockFlushWithSendOutcome({ statusCode: 200 });
    await freezeAndSubmit(buildService(null));

    expect(fakeClient.listenerCount()).toBe(0);
  });

  it("unsubscribes even when the flush times out (unconfirmed path)", async () => {
    sentryMock.flush.mockResolvedValueOnce(false);
    await freezeAndSubmit(buildService(null));

    expect(fakeClient.listenerCount()).toBe(0);
  });

  it("unsubscribes even when captureFeedback throws (failed-before-flush path)", async () => {
    sentryMock.captureFeedback.mockImplementationOnce(() => {
      throw new Error("DSN rejected");
    });
    await freezeAndSubmit(buildService(null));

    expect(fakeClient.listenerCount()).toBe(0);
  });

  it("unsubscribes on a rate-limited exit", async () => {
    mockFlushWithSendOutcome({
      statusCode: 429,
      headers: responseHeaders({ rateLimits: null, retryAfter: "5" }),
    });
    await freezeAndSubmit(buildService(null));

    expect(fakeClient.listenerCount()).toBe(0);
  });

  it("unsubscribes on a queued exit", async () => {
    mockFlushWithSendOutcome({});
    const service = buildService(null);
    const draft = await service.freezeEvidence(KEY, null);
    await writeOfflineQueueFixture([
      { id: "entry-a", eventId: draft.reportId.slice("rpt_".length) },
    ]);

    const result = await service.submitReport(FORM, KEY);
    expect(result.status).toBe("queued");
    expect(fakeClient.listenerCount()).toBe(0);
  });
});

describe("DesktopSupportService.submitReport - failed", () => {
  it("returns failed, with no reportId field, when captureFeedback throws", async () => {
    sentryMock.captureFeedback.mockImplementation(() => {
      throw new Error("DSN rejected");
    });

    const result = await freezeAndSubmit(buildService(null));

    expect(result).toEqual({ status: "failed", reason: "error" });
    expect(sentryMock.flush).not.toHaveBeenCalled();
  });

  it("returns failed when submit is called with no frozen evidence for the key", async () => {
    const service = buildService(null);

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
    await buildService(null).freezeEvidence(KEY, "fp:v1:sight");
    expect(reportLedgerMock.recordFingerprintSighting).toHaveBeenCalledWith(
      "fp:v1:sight",
    );
  });

  it("skips the sighting when fingerprint is null", async () => {
    await buildService(null).freezeEvidence(KEY, null);
    expect(reportLedgerMock.recordFingerprintSighting).not.toHaveBeenCalled();
  });

  it("records ONE sighting across StrictMode freeze → discard → freeze of the same key", async () => {
    // Real renderer mounts under <StrictMode> (renderer-shell/main.tsx):
    // setup freezes, cleanup discards, setup freezes again with the SAME
    // draftId/key. The live freeze-map alone is not enough - discard clears
    // it between the two setups. A short-TTL recentSightingKeys set must
    // suppress the second claim so first open never reads as "2nd time".
    const service = buildService(null);
    await service.freezeEvidence(KEY, "fp:v1:sight");
    service.discardFrozenEvidence(KEY);
    await service.freezeEvidence(KEY, "fp:v1:sight");
    expect(reportLedgerMock.recordFingerprintSighting).toHaveBeenCalledTimes(1);
  });
});

describe("DesktopSupportService - evidence freeze semantics", () => {
  it("ships the tails captured at freeze time even after further log writes", async () => {
    const service = buildService(null);
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
    const service = buildService(null);
    await service.freezeEvidence(KEY, null);
    service.discardFrozenEvidence(KEY);

    const result = await service.submitReport(FORM, KEY);

    expect(result).toEqual({ status: "failed", reason: "error" });
    expect(sentryMock.captureFeedback).not.toHaveBeenCalled();
  });

  it("never lands evidence discarded while its file reads are still in flight", async () => {
    const service = buildService(null);

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
    const service = buildService(null);
    await service.freezeEvidence(KEY, null);
    await writeFile(hostLogPath, "line written after freeze\n", "utf8");

    const tail = await service.readFrozenLogTail(KEY, "host");

    expect(tail.lines).toEqual(["host log line"]);
  });

  it("returns an empty tail from readFrozenLogTail once discarded", async () => {
    const service = buildService(null);
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

    const service = buildService(null);
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
  it("reuses the original email for repeated freezes and captures a new draft's email", async () => {
    let email: string | null = "first@traycer.ai";
    const service = buildService(() => email);
    const first = await service.freezeEvidence(KEY, null);
    email = "second@traycer.ai";

    const repeated = await service.freezeEvidence(KEY, null);
    const next = await service.freezeEvidence("sender-1:2", null);

    expect(repeated.contactEmail).toBe(first.contactEmail);
    expect(repeated.contactEmail).toBe("first@traycer.ai");
    expect(next.contactEmail).toBe("second@traycer.ai");
  });

  it("mints one reportId per draft and reuses it across every submit call", async () => {
    const service = buildService(null);
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
  it("resolves concurrent in-flight freezes of the same key to one shared reportId", async () => {
    const service = buildService(null);

    const [a, b] = await Promise.all([
      service.freezeEvidence(KEY, null),
      service.freezeEvidence(KEY, null),
    ]);

    expect(a.reportId).toBe(b.reportId);
  });

  it("mints a fresh reportId when freezing again after a discard - a genuinely new draft", async () => {
    const service = buildService(null);
    const { reportId: first } = await service.freezeEvidence(KEY, null);
    service.discardFrozenEvidence(KEY);
    const { reportId: second } = await service.freezeEvidence(KEY, null);

    expect(second).not.toBe(first);
  });
});

describe("DesktopSupportService.buildPublicDraft", () => {
  it("omits the signed-in email from public GitHub drafts", async () => {
    const service = buildService("anurag@traycer.ai");
    await service.freezeEvidence(KEY, null);

    const draft = await service.buildPublicDraft(FORM, KEY);

    expect(JSON.stringify(draft)).not.toContain("anurag@traycer.ai");
  });

  it("returns a reportId-aware draft after freeze, independent of Sentry", async () => {
    const service = buildService(null);
    const { reportId } = await service.freezeEvidence(KEY, null);
    expect(reportId).toMatch(/^rpt_[0-9a-f]{32}$/);

    const draft = await service.buildPublicDraft(FORM, KEY);

    expect(draft.template).toBe("bug_report.yml");
    if (draft.template !== "bug_report.yml") return;
    expect(draft.truncated).toBe(false);
    expect(draft.title).toBe(FORM.intent);
    expect(draft.fields["what-happened"]).toContain(FORM.intent);
    expect(draft.fields["what-happened"]).toContain(
      `Support report: ${reportId}`,
    );
    expect(draft.fields.version).toBe("1.1.9");
    expect(draft.fields.component).toBe("Desktop app");
    // No steps-to-reproduce field exists anymore - repro is always the
    // reportId-pointing placeholder, never user-typed text.
    expect(draft.fields.repro).toBe(
      `Not captured step-by-step - see the private support report ${reportId}.`,
    );
  });

  it("routes idea reports to feature_request.yml with a problem field and a proposal placeholder", async () => {
    const service = buildService(null);
    const { reportId } = await service.freezeEvidence(KEY, null);
    const draft = await service.buildPublicDraft(
      { ...FORM, type: "idea" },
      KEY,
    );
    expect(draft.template).toBe("feature_request.yml");
    if (draft.template !== "feature_request.yml") return;
    expect(draft.fields.problem).toContain(FORM.intent);
    expect(draft.fields.proposal).toBe(
      `Not captured separately - see the private support report ${reportId}.`,
    );
    expect(draft.fields.component).toBe("Desktop app");
  });

  it("routes 'other' reports to general.yml with a details field", async () => {
    const service = buildService(null);
    await service.freezeEvidence(KEY, null);
    const draft = await service.buildPublicDraft(
      { ...FORM, type: "other" },
      KEY,
    );
    expect(draft.template).toBe("general.yml");
    if (draft.template !== "general.yml") return;
    expect(draft.fields.details).toContain(FORM.intent);
  });

  it("uses the report-id-free repro placeholder when frozen evidence never resolved", async () => {
    const service = buildService(null);
    // No freezeEvidence call: `buildPublicDraft` resolves its own frozen
    // evidence and must still be callable (Flow 4 Case B's no-DSN route).
    const draft = await service.buildPublicDraft(FORM, KEY);
    if (draft.template !== "bug_report.yml") return;
    expect(draft.fields.repro).toBe("Filed from the in-app reporter.");
  });

  it("is callable and correct when Sentry has no DSN - honestly points at no report", async () => {
    sentryMock.isInitialized.mockReturnValue(false);
    const service = buildService(null);
    await service.freezeEvidence(KEY, null);

    // No-DSN builds never upload anything - the dialog sends "none" here,
    // matching the real route (Flow 4 Case B). A `reportId` being resolvable
    // from frozen evidence must not, on its own, make the draft claim a
    // private report exists to see.
    const draft = await service.buildPublicDraft(
      { ...FORM, privateOutcome: "none" },
      KEY,
    );

    expect(draft.title).toBe(FORM.intent);
    if (draft.template !== "bug_report.yml") return;
    expect(draft.fields.repro).toBe("Filed from the in-app reporter.");
    expect(draft.fields["what-happened"]).not.toContain("Support report:");
    // buildPublicDraft must not consult Sentry at all (unlike submitReport).
    expect(sentryMock.captureFeedback).not.toHaveBeenCalled();
  });

  it("is callable and correct after a submitReport that returned failed - honestly points at no report", async () => {
    sentryMock.captureFeedback.mockImplementation(() => {
      throw new Error("DSN rejected");
    });
    const service = buildService(null);
    await service.freezeEvidence(KEY, null);

    const submitResult = await service.submitReport(FORM, KEY);
    expect(submitResult).toEqual({ status: "failed", reason: "error" });

    // A definite `failed` submit leaves nothing on the Sentry side either -
    // the dialog sends "none" for this route too.
    const draft = await service.buildPublicDraft(
      { ...FORM, privateOutcome: "none" },
      KEY,
    );

    expect(draft.title).toBe(FORM.intent);
    if (draft.template !== "bug_report.yml") return;
    expect(draft.fields.repro).toBe("Filed from the in-app reporter.");
    expect(draft.fields["what-happened"]).not.toContain("Support report:");
    expect(draft.fields.component).toBe("Desktop app");
  });

  it("scrubs every emitted field (paths and tokens never leave raw)", async () => {
    const service = buildService(null);
    await service.freezeEvidence(KEY, null);

    const sensitiveForm: SupportSubmitReportRequest = {
      ...FORM,
      intent:
        "It broke, see /Users/anurag/project/log.txt for the Bearer abc123token",
    };

    const draft = await service.buildPublicDraft(sensitiveForm, KEY);

    if (draft.template !== "bug_report.yml") return;
    expect(draft.fields["what-happened"]).not.toContain("/Users/anurag");
    expect(draft.fields["what-happened"]).not.toContain("abc123token");
    expect(draft.fields["what-happened"]).toContain("Bearer <redacted>");
    expect(draft.title).not.toContain("/Users/anurag");
  });
});

function pngArrayBuffer(length: number): ArrayBuffer {
  const bytes = new Uint8Array(length);
  bytes[0] = 0x89;
  bytes[1] = 0x50;
  bytes[2] = 0x4e;
  bytes[3] = 0x47;
  return bytes.buffer;
}

function smallPngArrayBuffer(): ArrayBuffer {
  return pngArrayBuffer(32);
}

describe("DesktopSupportService.submitReport - image attachments (ticket 08)", () => {
  it("appends image attachments to captureFeedback alongside log tails", async () => {
    const pngBytes = smallPngArrayBuffer();
    const service = buildService(null);
    await service.freezeEvidence(KEY, null);
    await service.submitReport(
      {
        ...FORM,
        images: [
          {
            fileName: "ui-shot.png",
            mimeType: "image/png",
            bytes: pngBytes,
          },
        ],
      },
      KEY,
    );

    const filenames = lastHint().attachments.map((a) => a.filename);
    expect(filenames).toEqual(["desktop.log", "local-host.log", "ui-shot.png"]);
    const image = lastHint().attachments.find(
      (a) => a.filename === "ui-shot.png",
    );
    expect(image?.contentType).toBe("image/png");
    expect(image?.data).toBeInstanceOf(Uint8Array);
    expect(image?.data).toEqual(new Uint8Array(pngBytes));
  });

  it("never folds images into captureContext.contexts", async () => {
    const service = buildService(null);
    await service.freezeEvidence(KEY, null);
    await service.submitReport(
      {
        ...FORM,
        images: [
          {
            fileName: "ui-shot.png",
            mimeType: "image/png",
            bytes: smallPngArrayBuffer(),
          },
        ],
      },
      KEY,
    );

    const contexts = lastHint().captureContext.contexts;
    if (contexts !== undefined) {
      expect(contexts).not.toHaveProperty("images");
      for (const value of Object.values(contexts)) {
        expect(JSON.stringify(value)).not.toContain("ui-shot.png");
      }
    }
  });

  it("ships only log tails when images is empty", async () => {
    await freezeAndSubmit(buildService(null));
    expect(lastHint().attachments.map((a) => a.filename)).toEqual([
      "desktop.log",
      "local-host.log",
    ]);
  });
});

describe("DesktopSupportService.saveDiagnosticBundle", () => {
  it("omits the signed-in email from diagnostic bundles", async () => {
    const service = buildService("anurag@traycer.ai");
    await service.freezeEvidence(KEY, null);

    const { path } = await service.saveDiagnosticBundle(FORM, KEY);

    expect(await readFile(path, "utf8")).not.toContain("anurag@traycer.ai");
  });

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

    const service = buildService(null);
    await service.freezeEvidence(KEY, null);

    const sensitiveForm: SupportSubmitReportRequest = {
      ...FORM,
      intent: "Bundle body Bearer formtoken near /Users/anurag/title-leak.ts",
      location: "Epic canvas /Users/anurag/steps.ts",
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
      intent: string;
      location: string | null;
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
    expect(typed.intent).not.toContain("formtoken");
    expect(typed.intent).toContain("Bearer <redacted>");
    expect(typed.intent).not.toContain("/Users/anurag");
    expect(typed.location).not.toContain("/Users/anurag");
    expect(raw).not.toContain("/Users/anurag");
    expect(raw).not.toContain("formtoken");
    expect(raw).not.toContain("desktopsecret");
    expect(raw).not.toContain("hostsecret");
  });

  it("withholds a log from the bundle when its consent toggle is off", async () => {
    const service = buildService(null);
    await service.freezeEvidence(KEY, null);

    const { path } = await service.saveDiagnosticBundle(
      { ...FORM, includeDesktopLog: false, includeHostLog: true },
      KEY,
    );
    const bundle = JSON.parse(await readFile(path, "utf8")) as {
      logs: { desktop: string; host: string };
    };
    expect(bundle.logs.desktop).toBe("");
    expect(bundle.logs.host).not.toBe("");
  });

  it("includes both browser log tails when present and the toggle is on, blank when toggled off (ticket 03)", async () => {
    await writeFile(
      join(tempDir, "browser-telemetry.jsonl"),
      '{"seq":1,"kind":"nav"}\n',
      "utf8",
    );
    await writeFile(
      join(tempDir, "browser-trace.jsonl"),
      '{"seq":1,"kind":"cdp.command"}\n',
      "utf8",
    );
    const service = buildService(null);
    await service.freezeEvidence(KEY, null);

    const { path: onPath } = await service.saveDiagnosticBundle(
      { ...FORM, includeBrowserDiagnostics: true },
      KEY,
    );
    const onBundle = JSON.parse(await readFile(onPath, "utf8")) as {
      logs: { browserTelemetry: string; browserTrace: string };
    };
    expect(onBundle.logs.browserTelemetry).toContain('"kind":"nav"');
    expect(onBundle.logs.browserTrace).toContain('"kind":"cdp.command"');

    const { path: offPath } = await service.saveDiagnosticBundle(
      { ...FORM, includeBrowserDiagnostics: false },
      KEY,
    );
    const offBundle = JSON.parse(await readFile(offPath, "utf8")) as {
      logs: { browserTelemetry: string; browserTrace: string };
    };
    expect(offBundle.logs.browserTelemetry).toBe("");
    expect(offBundle.logs.browserTrace).toBe("");
  });

  it("omits appVersion/platform/arch/versions/host from the bundle when includeDiagnostics is off", async () => {
    const service = buildService(null);
    await service.freezeEvidence(KEY, null);
    const { path } = await service.saveDiagnosticBundle(
      { ...FORM, includeDiagnostics: false },
      KEY,
    );
    const bundle = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
    expect(bundle).not.toHaveProperty("appVersion");
    expect(bundle).not.toHaveProperty("platform");
    expect(bundle).not.toHaveProperty("arch");
    expect(bundle).not.toHaveProperty("versions");
    expect(bundle).not.toHaveProperty("host");
    // The report's own identity is not "diagnostics" - it still writes.
    expect(bundle.reportId).toMatch(/^rpt_[0-9a-f]{32}$/);
    expect(bundle.type).toBe(FORM.type);
    expect(bundle.intent).toBe(FORM.intent);
  });

  it("includes appVersion/platform/arch/versions/host in the bundle when includeDiagnostics is on", async () => {
    const service = buildService(null);
    await service.freezeEvidence(KEY, null);
    const { path } = await service.saveDiagnosticBundle(
      { ...FORM, includeDiagnostics: true },
      KEY,
    );
    const bundle = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
    expect(bundle.appVersion).toBeDefined();
    expect(bundle.platform).toBeDefined();
    expect(bundle.arch).toBeDefined();
    expect(bundle.versions).toBeDefined();
    expect(bundle.host).toBeDefined();
  });

  it("deliberately omits form.images from the diagnostic bundle JSON", async () => {
    // Screenshots are reviewed in-dialog and are not base64-inlined into the
    // local JSON bundle (ticket 08 design). Assert absence, not presence.
    const service = buildService(null);
    await service.freezeEvidence(KEY, null);
    const { path } = await service.saveDiagnosticBundle(
      {
        ...FORM,
        images: [
          {
            fileName: "secret-screen.png",
            mimeType: "image/png",
            bytes: smallPngArrayBuffer(),
          },
        ],
      },
      KEY,
    );
    const raw = await readFile(path, "utf8");
    const bundle = JSON.parse(raw) as Record<string, unknown>;
    expect(bundle).not.toHaveProperty("images");
    expect(raw).not.toContain("secret-screen.png");
    expect(raw).not.toContain("image/png");
  });
  it("writes the bundle owner-only and keeps a bundle saved moments ago", async () => {
    // The bundle lands in a shared `/tmp` holding the desktop and host log
    // tails and the browser trace, and every save used to leave its own
    // directory behind for the lifetime of the machine's `/tmp`.
    //
    // The sweep is age-bounded, though: a bundle is REVEALED to the user so
    // they can attach it to a ticket, so saving a second one must not pull the
    // first out from under an open file manager window.
    const service = buildService(null);
    await service.freezeEvidence(KEY, null);

    const first = await service.saveDiagnosticBundle(FORM, KEY);
    expect(statSync(first.path).mode & 0o777).toBe(0o600);

    const second = await service.saveDiagnosticBundle(FORM, KEY);
    expect(second.path).not.toBe(first.path);
    expect(existsSync(first.path)).toBe(true);
    expect(existsSync(second.path)).toBe(true);
  });

  it("erases a bundle a previous run left behind, not just this run's", async () => {
    // The bound has to survive a relaunch: an in-memory "last directory"
    // field only ever cleans up within one process lifetime, so every restart
    // orphaned another bundle in `/tmp` forever.
    const orphan = await mkdtemp(join(tmpdir(), "traycer-diagnostic-bundle-"));
    await writeFile(join(orphan, "report.json"), "{}", "utf8");
    // Aged past the retention window, which is what makes it an ORPHAN rather
    // than a bundle the user is still holding on to.
    const stale = new Date(Date.now() - 25 * 60 * 60_000);
    utimesSync(orphan, stale, stale);

    const service = buildService(null);
    await service.freezeEvidence(KEY, null);
    const saved = await service.saveDiagnosticBundle(FORM, KEY);

    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(saved.path)).toBe(true);
  });
});
