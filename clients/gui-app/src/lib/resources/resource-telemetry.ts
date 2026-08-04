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
 * Tiers are on the JS heap, not the working set, and are expressed as a
 * FRACTION of the measured ceiling rather than as absolute megabytes.
 *
 * The absolute values these replace (3072/2304/1536) were derived from the
 * desktop's 4 GB old-space limit, but Chromium sizes `jsHeapSizeLimit` from
 * device memory, so a low-memory client can OOM around 2 GB - below two of the
 * three thresholds. The tiers meant to fire before an allocation failure were
 * exactly the ones that could never fire, for exactly the population most
 * likely to hit one. The fractions reproduce the old thresholds at a 4 GB
 * limit and keep their meaning everywhere else.
 */
const PRESSURE_TIERS: ReadonlyArray<{
  readonly tier: AnalyticsResourcePressureTier;
  readonly limitFraction: number;
}> = [
  { tier: "critical", limitFraction: 0.75 },
  { tier: "high", limitFraction: 0.5625 },
  { tier: "elevated", limitFraction: 0.375 },
];
/** Fallback ceiling when the runtime does not expose one, so the tiers keep
 * the behaviour they had when they were absolute. */
const ASSUMED_JS_HEAP_LIMIT_MB = 4096;

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
  readonly collectContext: () => ResourceTelemetryContext;
  readonly emit: ResourceTelemetryEmitter;
}

export interface ResourceTelemetrySampler {
  /** Take and emit exactly one sample. Exposed for tests and for the pressure
   * path; production drives it from `start`. */
  readonly sampleOnce: () => void;
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
  jsHeapLimitMb: number | null,
): AnalyticsResourcePressureTier | null {
  const limit =
    jsHeapLimitMb === null || jsHeapLimitMb <= 0
      ? ASSUMED_JS_HEAP_LIMIT_MB
      : jsHeapLimitMb;
  const match = PRESSURE_TIERS.find(
    (entry) => jsHeapMb >= limit * entry.limitFraction,
  );
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

/*
 * Process CPU and working set are deliberately NOT sampled here.
 *
 * The only renderer-side source is `app.getAppMetrics()`, whose
 * `percentCPUUsage` is a delta against the last call and is accumulated per
 * pid in the main process - one shared bookmark for every caller. Sampling it
 * would corrupt the Resource Monitor's live reading (its next 1 Hz tick would
 * measure a sub-second window) and would itself report an interval defined by
 * whichever other poller ran last, not the 15 minutes this sampler implies.
 * A number that cannot be compared across samples or aggregated across users
 * is worse than no number, and the JS heap is the signal this event exists
 * for. Restoring CPU here needs a sampler-owned delta source, not this one.
 */

export function createResourceTelemetrySampler(
  deps: ResourceTelemetryDeps,
): ResourceTelemetrySampler {
  const heapHistory: HeapSample[] = [];
  let lastPressureAtMs: number | null = null;
  let lastPressureTier: AnalyticsResourcePressureTier | null = null;

  // Dropping the process-metrics read left this path fully synchronous, so
  // there is no longer an await window a teardown could slip through. The
  // `stopped` latch stays as the explicit guarantee: a sample must never emit
  // for a renderer that is being torn down, whatever the path grows back into.
  let stopped = false;

  const sampleOnce = (): void => {
    if (stopped) return;
    const heap = deps.readJsHeap();
    // No heap reading means no primary signal; process metrics alone would not
    // be interpretable, so skip the sample entirely.
    if (heap === null) return;
    const at = deps.now();
    heapHistory.push({ atMs: at, jsHeapMb: heap.usedMb });
    if (heapHistory.length > SLOPE_WINDOW_SAMPLES) heapHistory.shift();

    const context = deps.collectContext();
    const measurement = {
      js_heap_mb: heap.usedMb,
      js_heap_limit_mb: heap.limitMb,
      heap_slope_mb_per_h: heapSlopeMbPerHour(heapHistory),
      session_age_bucket: sessionAgeBucket(at - deps.startedAtMs),
      open_tabs: context.openTabs,
    };
    deps.emit.sample(measurement);

    const tier = pressureTierFor(heap.usedMb, heap.limitMb);
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
    stopped = false;
    const firstTimer = window.setTimeout(() => {
      sampleOnce();
    }, RESOURCE_FIRST_SAMPLE_DELAY_MS);
    const repeatTimer = window.setInterval(() => {
      sampleOnce();
    }, RESOURCE_SAMPLE_INTERVAL_MS);
    return () => {
      stopped = true;
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
  // `performance.now()` rather than `Date.now()`: both the session-age bucket
  // and the least-squares heap slope are differences between stamps, and the
  // wall clock can step backwards (NTP correction, manual change, resume from
  // sleep). A backward step makes a day-old session report `under_1h` - the
  // one axis the event exists to correlate heap against - and makes the slope
  // regression's x-axis non-monotonic, which can flip its sign and report a
  // leaking session as releasing memory.
  //
  // Anchored at 0, the document's time origin, NOT at `performance.now()` when
  // this bridge mounts. The event reports the age of the renderer session, so
  // it has to include app boot - and anchoring at mount would additionally
  // reset the age to zero on any remount, which is precisely when a long-lived
  // window is most interesting.
  const startedAtMs = 0;
  const sampler = createResourceTelemetrySampler({
    now: () => performance.now(),
    startedAtMs,
    readJsHeap,
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
