/**
 * Periodic renderer resource sampler.
 *
 * Retention bugs in this app are not visible as a spike - they show up as a
 * heap that correlates with how long the window has been open. A single
 * reading cannot show that, so every sample carries a session-age bucket and a
 * heap slope computed over a rolling window; the pair is what distinguishes
 * "this user has a lot open" from "this session is accumulating".
 *
 * Two channels, deliberately different frequencies:
 *   - PostHog (here): one sample every 15 min, plus a pressure event when the
 *     JS heap crosses a tier. Low volume, aggregate-queryable across users.
 *   - `lib/perf/perf-telemetry.ts`: high-frequency, opt-in, local ndjson for
 *     when a single machine needs to be dissected.
 *
 * The desktop process metrics are best-effort: a browser build (or a bridge
 * failure) reports `null` for them rather than suppressing the sample, because
 * the JS heap is the primary signal and is available either way.
 */

import {
  Analytics,
  AnalyticsEvent,
  type AnalyticsEventProperties,
  type AnalyticsResourcePressureTier,
  type AnalyticsSessionAgeBucket,
} from "@/lib/analytics";
import {
  desktopAppResourceUsageFromMetrics,
  getDesktopDiagnosticsBridge,
} from "@/lib/resources/desktop-app-resource-usage";

const BYTES_PER_MB = 1024 * 1024;
const MS_PER_HOUR = 3_600_000;

export const RESOURCE_SAMPLE_INTERVAL_MS = 15 * 60_000;
/** First sample is deferred past boot so it measures a settled renderer
 * rather than the hydration transient. */
export const RESOURCE_FIRST_SAMPLE_DELAY_MS = 60_000;
/** 8 samples at the 15-minute cadence = a 2-hour slope window: long enough to
 * ignore per-turn churn, short enough to still move within one sitting. */
const SLOPE_WINDOW_SAMPLES = 8;
const MIN_SLOPE_SAMPLES = 3;
const PRESSURE_REPEAT_THROTTLE_MS = MS_PER_HOUR;

/**
 * Tiers are on the JS heap, not the working set: the renderer's old-space
 * ceiling is 4 GB, so `critical` still leaves room to report before an
 * allocation failure takes the window down with the event unsent.
 */
const PRESSURE_TIERS: ReadonlyArray<{
  readonly tier: AnalyticsResourcePressureTier;
  readonly jsHeapMb: number;
}> = [
  { tier: "critical", jsHeapMb: 3072 },
  { tier: "high", jsHeapMb: 2304 },
  { tier: "elevated", jsHeapMb: 1536 },
];

const TIER_RANK: Readonly<Record<AnalyticsResourcePressureTier, number>> = {
  elevated: 1,
  high: 2,
  critical: 3,
};

export interface HeapSample {
  readonly atMs: number;
  readonly jsHeapMb: number;
}

export interface JsHeapReading {
  readonly usedMb: number;
  readonly limitMb: number | null;
}

export interface RendererUsageReading {
  readonly workingSetMb: number;
  readonly cpuPercent: number;
}

/** Workload context supplied by the mount site, so this module stays free of
 * store imports and remains directly testable. */
export interface ResourceTelemetryContext {
  readonly openTabs: number;
}

export interface ResourceTelemetryEmitter {
  readonly sample: (
    properties: AnalyticsEventProperties[AnalyticsEvent.AppResourceSample],
  ) => void;
  readonly pressure: (
    properties: AnalyticsEventProperties[AnalyticsEvent.AppResourcePressure],
  ) => void;
}

export interface ResourceTelemetryDeps {
  readonly now: () => number;
  readonly startedAtMs: number;
  readonly readJsHeap: () => JsHeapReading | null;
  readonly readRendererUsage: () => Promise<RendererUsageReading | null>;
  readonly collectContext: () => ResourceTelemetryContext;
  readonly emit: ResourceTelemetryEmitter;
}

export interface ResourceTelemetrySampler {
  /** Take and emit exactly one sample. Exposed for tests and for the pressure
   * path; production drives it from `start`. */
  readonly sampleOnce: () => Promise<void>;
  readonly start: () => () => void;
}

export function sessionAgeBucket(ageMs: number): AnalyticsSessionAgeBucket {
  const hours = ageMs / MS_PER_HOUR;
  if (hours < 1) return "under_1h";
  if (hours < 4) return "1_to_4h";
  if (hours < 12) return "4_to_12h";
  return "over_12h";
}

/**
 * Least-squares slope of heap against time, in MB/hour. `null` until the
 * window holds enough points to mean anything, and when every sample landed at
 * the same instant (a zero-variance x, which would divide by zero).
 */
export function heapSlopeMbPerHour(
  samples: ReadonlyArray<HeapSample>,
): number | null {
  if (samples.length < MIN_SLOPE_SAMPLES) return null;
  const hours = samples.map((sample) => sample.atMs / MS_PER_HOUR);
  const meanHours = hours.reduce((sum, value) => sum + value, 0) / hours.length;
  const meanHeap =
    samples.reduce((sum, sample) => sum + sample.jsHeapMb, 0) / samples.length;
  const covariance = samples.reduce(
    (sum, sample, index) =>
      sum + (hours[index] - meanHours) * (sample.jsHeapMb - meanHeap),
    0,
  );
  const variance = hours.reduce(
    (sum, value) => sum + (value - meanHours) ** 2,
    0,
  );
  if (variance === 0) return null;
  return roundToTenth(covariance / variance);
}

export function pressureTierFor(
  jsHeapMb: number,
): AnalyticsResourcePressureTier | null {
  const match = PRESSURE_TIERS.find((entry) => jsHeapMb >= entry.jsHeapMb);
  return match === undefined ? null : match.tier;
}

/**
 * `performance.memory` is a non-standard Chromium surface, so it is narrowed
 * locally rather than assumed present - a browser build without it reports no
 * heap and the sampler stays silent instead of shipping `NaN`.
 */
export function readJsHeap(): JsHeapReading | null {
  if (typeof performance === "undefined") return null;
  const memory = (
    performance as Performance & {
      readonly memory:
        | {
            readonly usedJSHeapSize: number;
            readonly jsHeapSizeLimit: number;
          }
        | undefined;
    }
  ).memory;
  if (memory === undefined) return null;
  if (!Number.isFinite(memory.usedJSHeapSize)) return null;
  return {
    usedMb: roundToTenth(memory.usedJSHeapSize / BYTES_PER_MB),
    limitMb: Number.isFinite(memory.jsHeapSizeLimit)
      ? Math.round(memory.jsHeapSizeLimit / BYTES_PER_MB)
      : null,
  };
}

export async function readRendererUsage(): Promise<RendererUsageReading | null> {
  const bridge = getDesktopDiagnosticsBridge();
  if (bridge === null) return null;
  try {
    const snapshot = await bridge.getMetrics();
    const usage = desktopAppResourceUsageFromMetrics(snapshot, Date.now());
    return {
      workingSetMb: roundToTenth(usage.renderer.rssBytes / BYTES_PER_MB),
      cpuPercent: roundToTenth(usage.renderer.cpuPercent),
    };
  } catch {
    // Diagnostics are never allowed to surface a failure into the app.
    return null;
  }
}

export function createResourceTelemetrySampler(
  deps: ResourceTelemetryDeps,
): ResourceTelemetrySampler {
  const heapHistory: HeapSample[] = [];
  let lastPressureAtMs: number | null = null;
  let lastPressureTier: AnalyticsResourcePressureTier | null = null;

  const sampleOnce = async (): Promise<void> => {
    const heap = deps.readJsHeap();
    // No heap reading means no primary signal; process metrics alone would not
    // be interpretable, so skip the sample entirely.
    if (heap === null) return;
    const at = deps.now();
    heapHistory.push({ atMs: at, jsHeapMb: heap.usedMb });
    if (heapHistory.length > SLOPE_WINDOW_SAMPLES) heapHistory.shift();

    const usage = await deps.readRendererUsage();
    const context = deps.collectContext();
    const measurement = {
      js_heap_mb: heap.usedMb,
      js_heap_limit_mb: heap.limitMb,
      heap_slope_mb_per_h: heapSlopeMbPerHour(heapHistory),
      renderer_working_set_mb: usage === null ? null : usage.workingSetMb,
      renderer_cpu_percent: usage === null ? null : usage.cpuPercent,
      session_age_bucket: sessionAgeBucket(at - deps.startedAtMs),
      open_tabs: context.openTabs,
    };
    deps.emit.sample(measurement);

    const tier = pressureTierFor(heap.usedMb);
    if (tier === null) {
      // Dropping out of every band re-arms the escalation path, so a later
      // climb reports immediately instead of waiting out the throttle.
      lastPressureTier = null;
      return;
    }
    const previousTier = lastPressureTier;
    lastPressureTier = tier;
    const escalated =
      previousTier === null || TIER_RANK[tier] > TIER_RANK[previousTier];
    const throttleElapsed =
      lastPressureAtMs === null ||
      at - lastPressureAtMs >= PRESSURE_REPEAT_THROTTLE_MS;
    if (!escalated && !throttleElapsed) return;
    lastPressureAtMs = at;
    deps.emit.pressure({ ...measurement, pressure_tier: tier });
  };

  const start = (): (() => void) => {
    const firstTimer = window.setTimeout(() => {
      void sampleOnce();
    }, RESOURCE_FIRST_SAMPLE_DELAY_MS);
    const repeatTimer = window.setInterval(() => {
      void sampleOnce();
    }, RESOURCE_SAMPLE_INTERVAL_MS);
    return () => {
      window.clearTimeout(firstTimer);
      window.clearInterval(repeatTimer);
    };
  };

  return { sampleOnce, start };
}

/**
 * Production entry point: wires the real clock, readings, and PostHog emitter.
 * Returns the disposer so the mounting bridge can stop sampling on unmount.
 */
export function startResourceTelemetry(
  collectContext: () => ResourceTelemetryContext,
): () => void {
  const analytics = Analytics.getInstance();
  const startedAtMs = Date.now();
  const sampler = createResourceTelemetrySampler({
    now: () => Date.now(),
    startedAtMs,
    readJsHeap,
    readRendererUsage,
    collectContext,
    emit: {
      sample: (properties) => {
        analytics.track(AnalyticsEvent.AppResourceSample, properties);
      },
      pressure: (properties) => {
        analytics.track(AnalyticsEvent.AppResourcePressure, properties);
      },
    },
  });
  return sampler.start();
}

function roundToTenth(value: number): number {
  return Math.round(value * 10) / 10;
}
