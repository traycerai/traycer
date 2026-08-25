import type {
  BrowserViewConsoleEntry,
  BrowserViewConsoleLevel,
  BrowserViewDebugSnapshotData,
  BrowserViewNetworkEntry,
  BrowserViewNetworkStatus,
  BrowserViewStackFrame,
} from "../../ipc-contracts/browser-view-types";

const MAX_CONSOLE_ENTRIES = 200;
const MAX_NETWORK_ENTRIES = 200;
const MAX_DEBUG_TEXT_LENGTH = 4096;
const MAX_DEBUG_URL_LENGTH = 2048;
const TRUNCATED_SUFFIX = "...";

interface NetworkEntryRecord {
  entry: BrowserViewNetworkEntry;
  readonly startedMonotonicAt: number | null;
}

export class BrowserDebugTelemetry {
  private readonly consoleEntries: BrowserViewConsoleEntry[] = [];
  private readonly networkEntriesById = new Map<string, NetworkEntryRecord>();
  private nextConsoleId = 1;

  constructor(
    private readonly webContentsId: number,
    private readonly onChange: () => void,
  ) {}

  handleEvent(
    method: string,
    params: Record<string, unknown>,
    sessionId: string | undefined,
  ): boolean {
    if (method === "Runtime.consoleAPICalled") {
      this.recordConsoleApiCall(params);
      return true;
    }
    if (method === "Runtime.exceptionThrown") {
      this.recordException(params);
      return true;
    }
    if (method === "Log.entryAdded") {
      this.recordLogEntry(params);
      return true;
    }
    if (method === "Network.requestWillBeSent") {
      this.recordRequestWillBeSent(params, sessionId);
      return true;
    }
    if (method === "Network.responseReceived") {
      this.recordResponseReceived(params, sessionId);
      return true;
    }
    if (method === "Network.loadingFinished") {
      this.recordLoadingFinished(params, sessionId);
      return true;
    }
    if (method === "Network.loadingFailed") {
      this.recordLoadingFailed(params, sessionId);
      return true;
    }
    if (method === "Network.requestServedFromCache") {
      this.recordRequestServedFromCache(params, sessionId);
      return true;
    }
    return false;
  }

  clear(): void {
    this.consoleEntries.splice(0);
    this.networkEntriesById.clear();
    this.onChange();
  }

  snapshot(): BrowserViewDebugSnapshotData {
    return {
      consoleEntries: this.consoleEntries,
      networkEntries: Array.from(this.networkEntriesById.values()).map(
        (record) => record.entry,
      ),
    };
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
    this.onChange();
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
    this.onChange();
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
    this.onChange();
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
    this.onChange();
  }

  private recordRequestServedFromCache(
    params: Record<string, unknown>,
    sessionId: string | undefined,
  ): void {
    const record = this.findNetworkRecord(params, sessionId);
    if (record === null) return;
    record.entry = { ...record.entry, fromCache: true };
    this.onChange();
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
    this.onChange();
  }

  private nextConsoleEntryId(prefix: string): string {
    const id = `${this.webContentsId}:${prefix}:${this.nextConsoleId}`;
    this.nextConsoleId += 1;
    return id;
  }
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
  if (level === "verbose") return "debug";
  if (level === "warning") return "warning";
  if (level === "error") return "error";
  if (level === "info") return "info";
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
  return wallTimeValue === null ? null : Math.round(wallTimeValue * 1000);
}

function cdpMonotonicTimestampMs(value: unknown): number | null {
  const timestamp = numberValue(value);
  return timestamp === null ? null : Math.round(timestamp * 1000);
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
