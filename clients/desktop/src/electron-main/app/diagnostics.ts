import {
  BrowserWindow,
  app,
  contentTracing,
  type IpcMainInvokeEvent,
} from "electron";
import * as SentryElectron from "@sentry/electron/main";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeLogError, log } from "./logger";
import { isSentryEnabled } from "./crash-reporter-state";
import type {
  RendererJsHeapBreakdown,
  RendererJsHeapIsolate,
} from "../../ipc-contracts/platform-types";

export async function handleGetMetrics(): Promise<{
  readonly main: Electron.ProcessMemoryInfo;
  readonly appMetrics: ReadonlyArray<Electron.ProcessMetric>;
  readonly cpuUsage: NodeJS.CpuUsage;
}> {
  const memory = await process.getProcessMemoryInfo();
  return {
    main: memory,
    appMetrics: app.getAppMetrics(),
    cpuUsage: process.cpuUsage(),
  };
}

export async function handleTakeHeapSnapshot(
  event: IpcMainInvokeEvent,
): Promise<string | null> {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window === null || window.isDestroyed()) return null;
  const dir = await mkdtemp(join(tmpdir(), "traycer-heap-"));
  const filePath = join(dir, `renderer-${Date.now()}.heapsnapshot`);
  try {
    await window.webContents.takeHeapSnapshot(filePath);
    log.info("[diagnostics] heap snapshot captured", { filePath });
    return filePath;
  } catch (err) {
    log.error("[diagnostics] heap snapshot failed", { err, filePath });
    return null;
  }
}

const JS_HEAP_MEASURE_TIMEOUT_MS = 10_000;

interface AttachedWorkerTarget {
  readonly sessionId: string;
  readonly url: string;
}

interface DebuggerMessageListener {
  (
    event: Electron.Event,
    method: string,
    params: unknown,
    sessionId: string | undefined,
  ): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readOptionalSize(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function readHeapUsage(
  result: unknown,
): Omit<RendererJsHeapIsolate, "kind" | "url"> | null {
  if (!isRecord(result)) return null;
  const { usedSize, totalSize, embedderHeapUsedSize, backingStorageSize } =
    result;
  if (typeof usedSize !== "number" || typeof totalSize !== "number") {
    return null;
  }
  return {
    usedBytes: usedSize,
    totalBytes: totalSize,
    embedderBytes: readOptionalSize(embedderHeapUsedSize),
    backingStorageBytes: readOptionalSize(backingStorageSize),
  };
}

function readAttachedWorkerTarget(
  params: unknown,
): AttachedWorkerTarget | null {
  if (!isRecord(params)) return null;
  const { sessionId, targetInfo } = params;
  if (typeof sessionId !== "string" || !isRecord(targetInfo)) return null;
  if (targetInfo.type !== "worker" || typeof targetInfo.url !== "string") {
    return null;
  }
  return { sessionId, url: targetInfo.url };
}

/**
 * CDP commands cannot be cancelled - `sendCommand` resolves when the browser answers, and a timed-out `measureIsolates` keeps going.
 * Left alone it would reach its own cleanup and send `Target.setAutoAttach: false` after the outer `finally` detached.
 */
interface MeasurementCancellation {
  cancelled: boolean;
}

function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  cancellation: MeasurementCancellation,
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      cancellation.cancelled = true;
      reject(new Error(`js heap measurement timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  // `Promise.race` keeps a handler on `work`, so a late rejection from the
  // straggler is absorbed here rather than surfacing as an unhandled rejection.
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

/**
 * A page-scoped session cannot list targets (`Target.getTargets` is browser-scoped), so the workers are reached the way DevTools reaches them: `Target.setAutoAttach` with `flatten.
 * Nothing is paused (`waitForDebuggerOnStart: false`) and nothing is enabled, so the workers never notice; the whole thing is a handful of round trips.
 */
export async function handleMeasureJsHeaps(
  event: IpcMainInvokeEvent,
): Promise<RendererJsHeapBreakdown | null> {
  const contents = event.sender;
  if (contents.isDestroyed()) return null;
  const debuggerApi = contents.debugger;
  if (debuggerApi.isAttached()) {
    log.warn(
      "[diagnostics] js heap measurement skipped: a debugger is already attached to this window",
    );
    return null;
  }
  const attachedWorkers = new Map<string, AttachedWorkerTarget>();
  const onMessage: DebuggerMessageListener = (_event, method, params) => {
    if (method !== "Target.attachedToTarget") return;
    const target = readAttachedWorkerTarget(params);
    if (target === null) return;
    attachedWorkers.set(target.sessionId, target);
  };
  try {
    debuggerApi.attach("1.3");
  } catch (err) {
    log.warn("[diagnostics] js heap measurement could not attach", {
      error: describeLogError(err),
    });
    return null;
  }
  debuggerApi.on("message", onMessage);
  const cancellation: MeasurementCancellation = { cancelled: false };
  try {
    const isolates = await withTimeout(
      measureIsolates(
        debuggerApi,
        contents.getURL(),
        attachedWorkers,
        cancellation,
      ),
      JS_HEAP_MEASURE_TIMEOUT_MS,
      cancellation,
    );
    const pid = contents.getOSProcessId();
    const metric = app.getAppMetrics().find((entry) => entry.pid === pid);
    const breakdown: RendererJsHeapBreakdown = {
      capturedAt: Date.now(),
      workingSetBytes:
        metric === undefined ? null : metric.memory.workingSetSize * 1024,
      isolates,
    };
    log.info("[diagnostics] js heaps measured", {
      isolates: isolates.length,
      usedBytes: isolates.reduce((sum, isolate) => sum + isolate.usedBytes, 0),
      totalBytes: isolates.reduce(
        (sum, isolate) => sum + isolate.totalBytes,
        0,
      ),
      embedderBytes: isolates.reduce(
        (sum, isolate) => sum + (isolate.embedderBytes ?? 0),
        0,
      ),
      backingStorageBytes: isolates.reduce(
        (sum, isolate) => sum + (isolate.backingStorageBytes ?? 0),
        0,
      ),
    });
    return breakdown;
  } catch (err) {
    log.warn("[diagnostics] js heap measurement failed", {
      error: describeLogError(err),
    });
    return null;
  } finally {
    debuggerApi.removeListener("message", onMessage);
    if (debuggerApi.isAttached()) {
      try {
        debuggerApi.detach();
      } catch (err) {
        log.warn("[diagnostics] js heap measurement detach failed", {
          error: describeLogError(err),
        });
      }
    }
  }
}

async function measureIsolates(
  debuggerApi: Electron.Debugger,
  pageUrl: string,
  attachedWorkers: ReadonlyMap<string, AttachedWorkerTarget>,
  cancellation: MeasurementCancellation,
): Promise<ReadonlyArray<RendererJsHeapIsolate>> {
  const isolates: RendererJsHeapIsolate[] = [];
  const page = readHeapUsage(
    await debuggerApi.sendCommand("Runtime.getHeapUsage", {}),
  );
  if (page !== null) isolates.push({ kind: "page", url: pageUrl, ...page });
  // Every guard below is read in the same synchronous step as the command it
  // protects, so a cancellation cannot slip between the two.
  if (cancellation.cancelled) return isolates;
  await debuggerApi.sendCommand("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  });
  // The attach announcements for existing workers are delivered before the
  // command's own response on the same ordered channel; one turn of the event
  // loop is the belt to that suspender, so a late event is not a missed row.
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  try {
    for (const worker of attachedWorkers.values()) {
      if (cancellation.cancelled) break;
      try {
        const usage = readHeapUsage(
          await debuggerApi.sendCommand(
            "Runtime.getHeapUsage",
            {},
            worker.sessionId,
          ),
        );
        if (usage === null) continue;
        isolates.push({ kind: "worker", url: worker.url, ...usage });
      } catch (err) {
        // A worker that exited between the attach and the read. Its row is
        // simply absent; the others still answer.
        log.debug("[diagnostics] worker heap read failed", {
          url: worker.url,
          error: describeLogError(err),
        });
      }
    }
  } finally {
    if (!cancellation.cancelled) {
      try {
        await debuggerApi.sendCommand("Target.setAutoAttach", {
          autoAttach: false,
          waitForDebuggerOnStart: false,
          flatten: true,
        });
      } catch (err) {
        log.debug("[diagnostics] auto-attach cleanup failed", {
          error: describeLogError(err),
        });
      }
    }
  }
  return isolates;
}

const MEMORY_SAMPLE_INTERVAL_MS = 5 * 60_000;
const RENDERER_MEMORY_WARN_KB = 3 * 1024 * 1024;
const MEMORY_WARN_THROTTLE_MS = 60 * 60_000;
const lastMemoryWarnAtByPid = new Map<number, number>();

/** `.unref()` so it never holds the process open. */
export function startRendererMemorySampler(): void {
  const timer = setInterval(() => {
    const renderers = app
      .getAppMetrics()
      .filter((metric) => metric.type === "Tab");
    const now = Date.now();
    for (const renderer of renderers) {
      if (renderer.memory.workingSetSize < RENDERER_MEMORY_WARN_KB) continue;
      const lastWarnAt = lastMemoryWarnAtByPid.get(renderer.pid) ?? 0;
      if (now - lastWarnAt < MEMORY_WARN_THROTTLE_MS) continue;
      lastMemoryWarnAtByPid.set(renderer.pid, now);
      const fields = {
        pid: renderer.pid,
        workingSetKb: renderer.memory.workingSetSize,
        peakWorkingSetKb: renderer.memory.peakWorkingSetSize,
      };
      log.warn("[diagnostics] renderer memory approaching cap", fields);
      if (isSentryEnabled()) {
        SentryElectron.captureMessage(
          "renderer memory approaching old-space cap",
          {
            level: "warning",
            tags: { workingSetKb: String(renderer.memory.workingSetSize) },
          },
        );
      }
    }
    // Drop throttle state for renderers that no longer exist so the map
    // can't grow unbounded across renderer churn.
    const livePids = new Set(renderers.map((renderer) => renderer.pid));
    for (const pid of lastMemoryWarnAtByPid.keys()) {
      if (!livePids.has(pid)) lastMemoryWarnAtByPid.delete(pid);
    }
  }, MEMORY_SAMPLE_INTERVAL_MS);
  timer.unref();
}

let activeTraceCategories: readonly string[] | null = null;

export async function handleTraceStart(): Promise<boolean> {
  if (activeTraceCategories !== null) {
    log.warn("[diagnostics] trace already running");
    return false;
  }
  const categories = [
    "devtools.timeline",
    "v8",
    "v8.execute",
    "blink",
    "blink.user_timing",
    "disabled-by-default-v8.gc",
  ];
  await contentTracing.startRecording({
    included_categories: categories,
  });
  activeTraceCategories = categories;
  log.info("[diagnostics] trace started", { categories });
  return true;
}

export async function handleTraceStop(): Promise<string | null> {
  if (activeTraceCategories === null) {
    log.warn("[diagnostics] trace stop called with no active trace");
    return null;
  }
  const dir = await mkdtemp(join(tmpdir(), "traycer-trace-"));
  const filePath = join(dir, `trace-${Date.now()}.json`);
  const written = await contentTracing.stopRecording(filePath);
  activeTraceCategories = null;
  log.info("[diagnostics] trace stopped", { filePath: written });
  return written;
}
