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

/**
 * Snapshots process-wide and per-process resource usage for support
 * bundles. Combines `process.getProcessMemoryInfo()` (current process)
 * with `app.getAppMetrics()` (per child process: type, pid, cpu, memory).
 * Renderer attaches the result to bug reports.
 */
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

/**
 * On-demand V8 heap snapshot of the sender renderer. Returns the path the
 * snapshot was written to (a temp directory). Heavy operation - expect
 * the renderer to freeze for hundreds of ms while the heap walks.
 */
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

/**
 * Bounds the whole measurement. Every step is a single round trip to a
 * renderer that is alive enough to have sent this request, so a wait past this
 * is a wedged protocol session, not a slow one - and the `finally` below must
 * get to detach.
 */
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

/**
 * `usedSize` / `totalSize` are the JS heap. `embedderHeapUsedSize` and
 * `backingStorageSize` are the memory attributed to the isolate that sits
 * OUTSIDE it - Blink's own objects, and `ArrayBuffer`/WASM backing stores such
 * as a diff highlighter worker's Oniguruma engine. Both are experimental
 * protocol fields, so each is carried only when the build answers with it;
 * dropping them would undercount precisely the workers this readout measures.
 */
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

/**
 * `Target.attachedToTarget` params. Only dedicated workers are collected: a
 * service worker or a shared worker belongs to the browser context, not to
 * this window's process, and would be counted against the wrong renderer.
 */
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

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`js heap measurement timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

/**
 * Per-isolate JS heap usage for the sender renderer: the page, plus every
 * dedicated worker it currently runs.
 *
 * WHY. A heap snapshot (`handleTakeHeapSnapshot`) walks the main thread's
 * isolate and nothing else. The renderer also runs one V8 isolate per
 * dedicated worker - an epic runtime worker per live epic session, a pool of
 * diff highlighter workers - and none of their memory shows up in that file.
 * The 2026-09-03 staging investigation had a 1.5 GB renderer whose snapshot
 * accounted for 190 MB; this readout is what was missing to say where the rest
 * lived.
 *
 * HOW. Chrome DevTools Protocol over `webContents.debugger`, the same channel
 * the browser tiles use. A page-scoped session cannot list targets
 * (`Target.getTargets` is browser-scoped), so the workers are reached the way
 * DevTools reaches them: `Target.setAutoAttach` with `flatten: true`, which
 * attaches to every existing dedicated worker and announces each one with a
 * `Target.attachedToTarget` event carrying a session id. `Runtime.getHeapUsage`
 * on that session id answers for that isolate. Nothing is paused
 * (`waitForDebuggerOnStart: false`) and nothing is enabled, so the workers
 * never notice; the whole thing is a handful of round trips.
 *
 * Refuses, rather than shares, a debugger someone else has attached: the
 * auto-attach toggle is session-wide state, and flipping it under a browser
 * tile's debug session would detach the workers that session was tracking.
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
  try {
    const isolates = await withTimeout(
      measureIsolates(debuggerApi, contents.getURL(), attachedWorkers),
      JS_HEAP_MEASURE_TIMEOUT_MS,
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
): Promise<ReadonlyArray<RendererJsHeapIsolate>> {
  const isolates: RendererJsHeapIsolate[] = [];
  const page = readHeapUsage(
    await debuggerApi.sendCommand("Runtime.getHeapUsage", {}),
  );
  if (page !== null) isolates.push({ kind: "page", url: pageUrl, ...page });
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
    await debuggerApi.sendCommand("Target.setAutoAttach", {
      autoAttach: false,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
  }
  return isolates;
}

const MEMORY_SAMPLE_INTERVAL_MS = 5 * 60_000;
// Renderer working-set (KB) past which we surface a breadcrumb. The renderer
// old-space ceiling is 4 GB (see `configureV8HeapSize`), raised
// "conservatively; bump if telemetry shows usage approaching this" - 3 GB
// working-set is that "approaching the cap" signal made observable.
const RENDERER_MEMORY_WARN_KB = 3 * 1024 * 1024;
// A renderer that legitimately sits above the cap would otherwise fire a
// breadcrumb every sample tick; throttle the warn + Sentry event to at most
// once per renderer per hour so a sustained high-memory tab stays a signal,
// not a flood.
const MEMORY_WARN_THROTTLE_MS = 60 * 60_000;
const lastMemoryWarnAtByPid = new Map<number, number>();

/**
 * Low-frequency renderer-memory sampler. Logs per-renderer working-set and
 * breadcrumbs to Sentry when a renderer approaches the old-space cap, so the
 * "bump 4 GB if telemetry shows" loop the heap-size comment asks for actually
 * exists. `.unref()` so it never holds the process open.
 */
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

/**
 * Starts Chrome content tracing for in-the-field perf bugs. Captures a
 * curated set of categories - Chromium accepts a large set, but most
 * apps only need devtools + v8 + blink. Renderer should call `traceStop`
 * within a bounded time to avoid filling disk.
 */
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

/**
 * Stops the active trace and writes it to a temp file. Returns the path
 * so the renderer can attach it to a support ticket.
 */
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
