import type {
  BrowserViewConsoleEntry,
  BrowserViewConsoleLevel,
  BrowserViewDebugSnapshotData,
  BrowserViewNetworkEntry,
  BrowserViewNetworkStatus,
  BrowserViewStackFrame,
} from "../../ipc-contracts/browser-view-types";
import type {
  PipCaptureIpcPayload,
  PipCaptureServerFrame,
} from "../../ipc-contracts/pip-capture-types";
import type {
  BrowserViewDebugger,
  BrowserViewWebContents,
} from "./browser-view-manager";
import { describeLogError, log } from "../app/logger";

const MAX_CONSOLE_ENTRIES = 200;
const MAX_NETWORK_ENTRIES = 200;
const MAX_DEBUG_TEXT_LENGTH = 4096;
const MAX_DEBUG_URL_LENGTH = 2048;
const TRUNCATED_SUFFIX = "...";
// ponytail: Polling at 5 fps keeps hidden-tab painting reliable without paying
// full-frame capture cost; raise this ceiling only if PiP motion needs it.
const PIP_CAPTURE_INTERVAL_MS = 200;

export interface BrowserDebugTargetAttachedEvent {
  readonly sessionId: string;
  readonly targetId: string;
  readonly targetType: string;
  readonly url: string;
  readonly waitingForDebugger: boolean;
}

interface BrowserDebugSessionOptions {
  readonly webContents: BrowserViewWebContents;
  readonly onSnapshotChange: () => void;
  readonly onDetached: (reason: string) => void;
  // Ticket 03: forwards CDP's own `Target.attachedToTarget` so the host can
  // discover a flattened child (OOPIF/worker) session id to dispatch at.
  readonly onTargetAttached: (event: BrowserDebugTargetAttachedEvent) => void;
}

interface NetworkEntryRecord {
  entry: BrowserViewNetworkEntry;
  readonly startedMonotonicAt: number | null;
}

interface CdpEvent {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly sessionId: string | undefined;
}

export interface BrowserPipCaptureStartInput {
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly quality: number;
  readonly onFrame: (payload: PipCaptureIpcPayload) => void;
}

export class BrowserDebugSession {
  private readonly webContents: BrowserViewWebContents;
  private readonly onSnapshotChange: () => void;
  private readonly onDetached: (reason: string) => void;
  private readonly onTargetAttached: (
    event: BrowserDebugTargetAttachedEvent,
  ) => void;
  private readonly consoleEntries: BrowserViewConsoleEntry[] = [];
  private readonly networkEntriesById = new Map<string, NetworkEntryRecord>();
  private readonly childSessionIds = new Set<string>();
  private readonly messageListener = (...args: unknown[]) => {
    this.handleDebuggerMessage(args);
  };
  private readonly detachListener = (...args: unknown[]) => {
    this.handleDebuggerDetach(args);
  };
  private enabled = false;
  private enablePromise: Promise<void> | null = null;
  private attachedBySession = false;
  private disposed = false;
  private nextConsoleId = 1;
  private pipCapture: ActivePipCapture | null = null;

  constructor(options: BrowserDebugSessionOptions) {
    this.webContents = options.webContents;
    this.onSnapshotChange = options.onSnapshotChange;
    this.onDetached = options.onDetached;
    this.onTargetAttached = options.onTargetAttached;
  }

  async installScriptBeforeNavigation(source: string): Promise<string> {
    if (this.disposed) throw new Error("Browser debug session is disposed");
    const browserDebugger = this.webContents.debugger;
    if (!browserDebugger.isAttached()) {
      browserDebugger.attach("1.3");
      this.attachedBySession = true;
    }
    const result = await sendDebuggerCommand(
      browserDebugger,
      "Page.addScriptToEvaluateOnNewDocument",
      { source },
      undefined,
    );
    if (
      result === null ||
      typeof result !== "object" ||
      !("identifier" in result) ||
      typeof result.identifier !== "string"
    ) {
      throw new Error(
        "Browser seed script registration returned no identifier",
      );
    }
    return result.identifier;
  }

  removeScriptBeforeNavigation(identifier: string): Promise<unknown> {
    return sendDebuggerCommand(
      this.webContents.debugger,
      "Page.removeScriptToEvaluateOnNewDocument",
      { identifier },
      undefined,
    );
  }

  enableAfterCommit(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error("Browser debug session is disposed"));
    }
    if (this.enabled) return Promise.resolve();
    if (this.enablePromise !== null) return this.enablePromise;
    const browserDebugger = this.webContents.debugger;
    try {
      if (!browserDebugger.isAttached()) {
        browserDebugger.attach("1.3");
        this.attachedBySession = true;
      }
      browserDebugger.on("message", this.messageListener);
      browserDebugger.on("detach", this.detachListener);
    } catch (err) {
      log.warn("[browser-view] debugger attach failed", {
        error: describeLogError(err),
      });
      return Promise.reject(err);
    }

    let enablePromise!: Promise<void>;
    enablePromise = Promise.all([
      sendDebuggerCommand(browserDebugger, "Page.enable", {}, undefined),
      sendDebuggerCommand(browserDebugger, "Runtime.enable", {}, undefined),
      sendDebuggerCommand(browserDebugger, "Log.enable", {}, undefined),
      sendDebuggerCommand(browserDebugger, "Network.enable", {}, undefined),
      // Ticket 03's `cdpDescribeNode` (DOM.describeNode) needs the DOM
      // domain enabled first, same convention as every other domain here -
      // CDP commands from a domain are unreliable (often outright rejected)
      // before that domain's own `enable` has been sent.
      sendDebuggerCommand(browserDebugger, "DOM.enable", {}, undefined),
      sendDebuggerCommand(
        browserDebugger,
        "Target.setAutoAttach",
        {
          autoAttach: true,
          flatten: true,
          waitForDebuggerOnStart: false,
        },
        undefined,
      ),
    ])
      .then(() => {
        if (
          this.disposed ||
          this.enablePromise !== enablePromise ||
          !browserDebugger.isAttached()
        ) {
          throw new Error("Browser debug session ended while enabling");
        }
        this.enabled = true;
        this.onSnapshotChange();
      })
      .catch((err: unknown) => {
        if (this.enablePromise === enablePromise) {
          this.enablePromise = null;
        }
        browserDebugger.off("message", this.messageListener);
        browserDebugger.off("detach", this.detachListener);
        if (this.attachedBySession && browserDebugger.isAttached()) {
          try {
            browserDebugger.detach();
          } catch (detachErr) {
            log.warn("[browser-view] debugger detach after enable failed", {
              error: describeLogError(detachErr),
            });
          }
        }
        this.attachedBySession = false;
        log.warn("[browser-view] debugger domain enable failed", {
          error: describeLogError(err),
        });
        throw err;
      });
    this.enablePromise = enablePromise;
    return enablePromise;
  }

  startPipCapture(input: BrowserPipCaptureStartInput): Promise<void> {
    if (this.disposed) throw new Error("Browser debug session is disposed");
    this.stopPipCapture();
    const capture: ActivePipCapture = {
      onFrame: input.onFrame,
      nextSequence: 0,
      timer: null,
    };
    this.pipCapture = capture;
    this.emitPipFrame(
      {
        kind: "started",
        hasBinaryPayload: false,
        frameWidth: input.maxWidth,
        frameHeight: input.maxHeight,
        deviceScaleFactor: 1,
      },
      null,
    );
    void this.capturePipFrame(capture, input.quality);
    return Promise.resolve();
  }

  stopPipCapture(): void {
    this.teardownPipCapture("stop");
  }

  isPipCapturing(): boolean {
    return this.pipCapture !== null;
  }

  clear(): void {
    this.consoleEntries.splice(0);
    this.networkEntriesById.clear();
    this.onSnapshotChange();
  }

  snapshot(): BrowserViewDebugSnapshotData {
    return {
      consoleEntries: this.consoleEntries,
      networkEntries: Array.from(this.networkEntriesById.values()).map(
        (record) => record.entry,
      ),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.enablePromise = null;
    this.teardownPipCapture(this.pipCapture === null ? "stop" : "stalled");
    const browserDebugger = this.webContents.debugger;
    browserDebugger.off("message", this.messageListener);
    browserDebugger.off("detach", this.detachListener);
    if (this.attachedBySession && browserDebugger.isAttached()) {
      try {
        browserDebugger.detach();
      } catch (err) {
        log.warn("[browser-view] debugger detach failed", {
          error: describeLogError(err),
        });
      }
    }
    this.childSessionIds.clear();
  }

  private handleDebuggerMessage(args: readonly unknown[]): void {
    const event = readCdpEvent(args);
    if (event === null) return;
    if (event.method === "Target.attachedToTarget") {
      this.handleTargetAttached(event.params);
      return;
    }
    if (event.method === "Target.detachedFromTarget") {
      this.handleTargetDetached(event.params);
      return;
    }
    if (event.method === "Runtime.consoleAPICalled") {
      this.recordConsoleApiCall(event.params);
      return;
    }
    if (event.method === "Runtime.exceptionThrown") {
      this.recordException(event.params);
      return;
    }
    if (event.method === "Log.entryAdded") {
      this.recordLogEntry(event.params);
      return;
    }
    if (event.method === "Network.requestWillBeSent") {
      this.recordRequestWillBeSent(event.params, event.sessionId);
      return;
    }
    if (event.method === "Network.responseReceived") {
      this.recordResponseReceived(event.params, event.sessionId);
      return;
    }
    if (event.method === "Network.loadingFinished") {
      this.recordLoadingFinished(event.params, event.sessionId);
      return;
    }
    if (event.method === "Network.loadingFailed") {
      this.recordLoadingFailed(event.params, event.sessionId);
      return;
    }
    if (event.method === "Network.requestServedFromCache") {
      this.recordRequestServedFromCache(event.params, event.sessionId);
    }
  }

  private handleDebuggerDetach(args: readonly unknown[]): void {
    const reason = args
      .map((value) => (typeof value === "string" ? value : null))
      .find((value) => value !== null);
    const browserDebugger = this.webContents.debugger;
    browserDebugger.off("message", this.messageListener);
    browserDebugger.off("detach", this.detachListener);
    this.enabled = false;
    this.enablePromise = null;
    this.attachedBySession = false;
    this.childSessionIds.clear();
    this.onDetached(reason ?? "Debugger detached");
  }

  private async capturePipFrame(
    capture: ActivePipCapture,
    quality: number,
  ): Promise<void> {
    try {
      const image = await this.webContents.capturePage();
      if (this.pipCapture !== capture) return;
      const size = image.getSize();
      const jpegBytes = image.toJPEG(quality);
      if (jpegBytes.byteLength > 0) {
        const sequence = capture.nextSequence;
        capture.nextSequence += 1;
        this.emitPipFrame(
          {
            kind: "frame",
            hasBinaryPayload: true,
            sequence,
            metadata: {
              offsetTop: 0,
              pageScaleFactor: 1,
              deviceWidth: size.width,
              deviceHeight: size.height,
              scrollOffsetX: 0,
              scrollOffsetY: 0,
              timestamp: Date.now() / 1_000,
            },
          },
          jpegBytes,
        );
      }
    } catch (err) {
      if (this.pipCapture === capture) {
        log.warn("[browser-view] pip frame capture failed", {
          error: describeLogError(err),
        });
      }
    }
    if (this.pipCapture !== capture) return;
    capture.timer = setTimeout(() => {
      capture.timer = null;
      void this.capturePipFrame(capture, quality);
    }, PIP_CAPTURE_INTERVAL_MS);
  }

  private teardownPipCapture(reason: "stop" | "stalled" | "failed"): void {
    const capture = this.pipCapture;
    if (capture === null) return;
    this.pipCapture = null;
    if (capture.timer !== null) clearTimeout(capture.timer);
    if (reason === "stalled") {
      capture.onFrame({
        frame: { kind: "stalled", hasBinaryPayload: false },
        jpegBytes: null,
      });
    }
  }

  private emitPipFrame(
    frame: PipCaptureServerFrame,
    jpegBytes: Uint8Array | null,
  ): void {
    const capture = this.pipCapture;
    if (capture === null) return;
    capture.onFrame({ frame, jpegBytes });
  }

  private handleTargetAttached(params: Record<string, unknown>): void {
    const sessionId = stringValue(params.sessionId);
    if (sessionId === null || this.childSessionIds.has(sessionId)) return;
    this.childSessionIds.add(sessionId);
    const targetInfo = recordValue(params.targetInfo);
    this.onTargetAttached({
      sessionId,
      targetId: stringValue(targetInfo?.targetId) ?? "",
      targetType: stringValue(targetInfo?.type) ?? "",
      url: stringValue(targetInfo?.url) ?? "",
      waitingForDebugger: booleanValue(params.waitingForDebugger),
    });
    Promise.all([
      sendDebuggerCommand(
        this.webContents.debugger,
        "Runtime.enable",
        {},
        sessionId,
      ),
      sendDebuggerCommand(
        this.webContents.debugger,
        "Log.enable",
        {},
        sessionId,
      ),
      sendDebuggerCommand(
        this.webContents.debugger,
        "Network.enable",
        {},
        sessionId,
      ),
      sendDebuggerCommand(
        this.webContents.debugger,
        "DOM.enable",
        {},
        sessionId,
      ),
    ]).catch((err: unknown) => {
      log.warn("[browser-view] child debugger domain enable failed", {
        error: describeLogError(err),
        sessionId,
      });
    });
  }

  private handleTargetDetached(params: Record<string, unknown>): void {
    const sessionId = stringValue(params.sessionId);
    if (sessionId !== null) this.childSessionIds.delete(sessionId);
  }

  private recordConsoleApiCall(params: Record<string, unknown>): void {
    const stackTrace = readStackTrace(params.stackTrace);
    const firstFrame = stackTrace[0] ?? null;
    const args = arrayValue(params.args);
    this.pushConsoleEntry({
      id: this.nextConsoleEntryId("console"),
      timestamp: numberValue(params.timestamp) ?? Date.now(),
      source: "console-api",
      level: consoleApiLevel(stringValue(params.type)),
      text: truncateDebugText(args.map(remoteObjectText).join(" ")),
      url: firstFrame?.url ?? null,
      lineNumber: firstFrame?.lineNumber ?? null,
      columnNumber: firstFrame?.columnNumber ?? null,
      stackTrace,
    });
  }

  private recordException(params: Record<string, unknown>): void {
    const details = recordValue(params.exceptionDetails);
    if (details === null) return;
    const exception = recordValue(details.exception);
    const stackTrace = readStackTrace(details.stackTrace);
    this.pushConsoleEntry({
      id: this.nextConsoleEntryId("exception"),
      timestamp: Date.now(),
      source: "exception",
      level: "error",
      text: truncateDebugText(
        stringValue(exception?.description) ??
          stringValue(exception?.value) ??
          stringValue(details.text) ??
          "Uncaught exception",
      ),
      url: truncateDebugUrl(stringValue(details.url)),
      lineNumber: numberValue(details.lineNumber),
      columnNumber: numberValue(details.columnNumber),
      stackTrace,
    });
  }

  private recordLogEntry(params: Record<string, unknown>): void {
    const entry = recordValue(params.entry);
    if (entry === null) return;
    this.pushConsoleEntry({
      id: this.nextConsoleEntryId("log"),
      timestamp: numberValue(entry.timestamp) ?? Date.now(),
      source: truncateDebugText(stringValue(entry.source) ?? "log"),
      level: logEntryLevel(stringValue(entry.level)),
      text: truncateDebugText(stringValue(entry.text) ?? ""),
      url: truncateDebugUrl(stringValue(entry.url)),
      lineNumber: numberValue(entry.lineNumber),
      columnNumber: null,
      stackTrace: [],
    });
  }

  private recordRequestWillBeSent(
    params: Record<string, unknown>,
    sessionId: string | undefined,
  ): void {
    const requestId = stringValue(params.requestId);
    const request = recordValue(params.request);
    if (requestId === null || request === null) return;
    const id = networkEntryId(sessionId, requestId);
    const startedMonotonicAt = cdpMonotonicTimestampMs(params.timestamp);
    this.networkEntriesById.set(id, {
      startedMonotonicAt,
      entry: {
        id,
        requestId,
        url: truncateDebugUrl(stringValue(request.url)) ?? "",
        method: truncateDebugText(stringValue(request.method) ?? "GET"),
        resourceType: truncateNullableText(stringValue(params.type)),
        status: "pending",
        statusCode: null,
        statusText: null,
        mimeType: null,
        fromCache: false,
        startedAt: cdpWallTimeMs(params.wallTime) ?? Date.now(),
        completedAt: null,
        durationMs: null,
        encodedDataLength: null,
        failureText: null,
      },
    });
    trimNetworkEntries(this.networkEntriesById);
    this.onSnapshotChange();
  }

  private recordResponseReceived(
    params: Record<string, unknown>,
    sessionId: string | undefined,
  ): void {
    const record = this.findNetworkRecord(params, sessionId);
    const response = recordValue(params.response);
    if (record === null || response === null) return;
    record.entry = {
      ...record.entry,
      statusCode: numberValue(response.status),
      statusText: truncateNullableText(stringValue(response.statusText)),
      mimeType: truncateNullableText(stringValue(response.mimeType)),
      fromCache:
        booleanValue(response.fromDiskCache) ||
        booleanValue(response.fromPrefetchCache) ||
        booleanValue(response.fromServiceWorker),
    };
    this.onSnapshotChange();
  }

  private recordLoadingFinished(
    params: Record<string, unknown>,
    sessionId: string | undefined,
  ): void {
    const record = this.findNetworkRecord(params, sessionId);
    if (record === null) return;
    record.entry = completeNetworkEntry(
      record,
      "finished",
      cdpMonotonicTimestampMs(params.timestamp),
      {
        encodedDataLength: numberValue(params.encodedDataLength),
        failureText: null,
      },
    );
    this.onSnapshotChange();
  }

  private recordLoadingFailed(
    params: Record<string, unknown>,
    sessionId: string | undefined,
  ): void {
    const record = this.findNetworkRecord(params, sessionId);
    if (record === null) return;
    record.entry = completeNetworkEntry(
      record,
      "failed",
      cdpMonotonicTimestampMs(params.timestamp),
      {
        encodedDataLength: null,
        failureText: truncateDebugText(
          stringValue(params.errorText) ?? "Request failed",
        ),
      },
    );
    this.onSnapshotChange();
  }

  private recordRequestServedFromCache(
    params: Record<string, unknown>,
    sessionId: string | undefined,
  ): void {
    const record = this.findNetworkRecord(params, sessionId);
    if (record === null) return;
    record.entry = { ...record.entry, fromCache: true };
    this.onSnapshotChange();
  }

  private findNetworkRecord(
    params: Record<string, unknown>,
    sessionId: string | undefined,
  ): NetworkEntryRecord | null {
    const requestId = stringValue(params.requestId);
    if (requestId === null) return null;
    return (
      this.networkEntriesById.get(networkEntryId(sessionId, requestId)) ?? null
    );
  }

  private pushConsoleEntry(entry: BrowserViewConsoleEntry): void {
    this.consoleEntries.push(entry);
    if (this.consoleEntries.length > MAX_CONSOLE_ENTRIES) {
      this.consoleEntries.splice(
        0,
        this.consoleEntries.length - MAX_CONSOLE_ENTRIES,
      );
    }
    this.onSnapshotChange();
  }

  private nextConsoleEntryId(prefix: string): string {
    const id = `${this.webContents.id}:${prefix}:${this.nextConsoleId}`;
    this.nextConsoleId += 1;
    return id;
  }
}

interface ActivePipCapture {
  readonly onFrame: (payload: PipCaptureIpcPayload) => void;
  nextSequence: number;
  timer: NodeJS.Timeout | null;
}

function sendDebuggerCommand(
  browserDebugger: BrowserViewDebugger,
  method: string,
  params: Record<string, unknown>,
  sessionId: string | undefined,
): Promise<unknown> {
  return browserDebugger.sendCommand(method, params, sessionId);
}

function readCdpEvent(args: readonly unknown[]): CdpEvent | null {
  const method = args[1];
  if (typeof method !== "string") return null;
  const params = recordValue(args[2]) ?? {};
  const sessionId = typeof args[3] === "string" ? args[3] : undefined;
  return { method, params, sessionId };
}

function remoteObjectText(value: unknown): string {
  const object = recordValue(value);
  if (object === null) return "";
  const type = stringValue(object.type);
  const subtype = stringValue(object.subtype);
  const valueText = primitiveRemoteValueText(object.value);
  if (valueText !== null) return valueText;
  const description = stringValue(object.description);
  if (description !== null) return truncateDebugText(description);
  if (subtype !== null) return truncateDebugText(subtype);
  return truncateDebugText(type ?? "");
}

function primitiveRemoteValueText(value: unknown): string | null {
  if (typeof value === "string") return truncateDebugText(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null) return "null";
  return null;
}

function consoleApiLevel(type: string | null): BrowserViewConsoleLevel {
  if (type === "debug") return "debug";
  if (type === "error") return "error";
  if (type === "warning") return "warning";
  if (type === "info") return "info";
  if (type === "trace") return "trace";
  return "log";
}

function logEntryLevel(level: string | null): BrowserViewConsoleLevel {
  if (level === "error") return "error";
  if (level === "warning") return "warning";
  if (level === "info") return "info";
  if (level === "verbose") return "debug";
  return "log";
}

function readStackTrace(value: unknown): BrowserViewStackFrame[] {
  const trace = recordValue(value);
  const frames = arrayValue(trace?.callFrames);
  return frames.flatMap((frame): BrowserViewStackFrame[] => {
    const record = recordValue(frame);
    if (record === null) return [];
    return [
      {
        functionName: truncateDebugText(stringValue(record.functionName) ?? ""),
        url: truncateDebugUrl(stringValue(record.url)) ?? "",
        lineNumber: numberValue(record.lineNumber),
        columnNumber: numberValue(record.columnNumber),
      },
    ];
  });
}

function completeNetworkEntry(
  record: NetworkEntryRecord,
  status: BrowserViewNetworkStatus,
  completedMonotonicAt: number | null,
  result: {
    readonly encodedDataLength: number | null;
    readonly failureText: string | null;
  },
): BrowserViewNetworkEntry {
  const entry = record.entry;
  const now = Date.now();
  const durationMs =
    record.startedMonotonicAt === null || completedMonotonicAt === null
      ? Math.max(0, now - entry.startedAt)
      : Math.max(
          0,
          Math.round(completedMonotonicAt - record.startedMonotonicAt),
        );
  const completedAt =
    record.startedMonotonicAt === null || completedMonotonicAt === null
      ? now
      : entry.startedAt + durationMs;
  return {
    ...entry,
    status,
    completedAt,
    durationMs,
    encodedDataLength: result.encodedDataLength,
    failureText: result.failureText,
  };
}

function cdpWallTimeMs(wallTime: unknown): number | null {
  const wallTimeValue = numberValue(wallTime);
  if (wallTimeValue !== null) return Math.round(wallTimeValue * 1000);
  return null;
}

function cdpMonotonicTimestampMs(monotonicTimestamp: unknown): number | null {
  const timestampValue = numberValue(monotonicTimestamp);
  if (timestampValue !== null) return Math.round(timestampValue * 1000);
  return null;
}

function networkEntryId(
  sessionId: string | undefined,
  requestId: string,
): string {
  return `${sessionId ?? "root"}:${requestId}`;
}

function trimNetworkEntries(entries: Map<string, NetworkEntryRecord>): void {
  while (entries.size > MAX_NETWORK_ENTRIES) {
    const first = entries.keys().next();
    if (first.done) return;
    entries.delete(first.value);
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function truncateDebugText(value: string): string {
  return truncateString(value, MAX_DEBUG_TEXT_LENGTH);
}

function truncateNullableText(value: string | null): string | null {
  return value === null ? null : truncateDebugText(value);
}

function truncateDebugUrl(value: string | null): string | null {
  return value === null ? null : truncateString(value, MAX_DEBUG_URL_LENGTH);
}

function truncateString(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - TRUNCATED_SUFFIX.length)}${TRUNCATED_SUFFIX}`;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
