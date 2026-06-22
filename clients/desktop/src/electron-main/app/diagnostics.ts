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
import { log } from "./logger";
import { isSentryEnabled } from "./crash-reporter-state";

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
