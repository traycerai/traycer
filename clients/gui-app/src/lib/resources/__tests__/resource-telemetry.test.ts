import { describe, expect, it, vi } from "vitest";
import {
  createResourceTelemetrySampler,
  RESOURCE_FIRST_SAMPLE_DELAY_MS,
  RESOURCE_SAMPLE_INTERVAL_MS,
  heapSlopeMbPerHour,
  pressureTierFor,
  sessionAgeBucket,
  type JsHeapReading,
  type ResourceTelemetryEmitter,
} from "@/lib/resources/resource-telemetry";

const HOUR_MS = 3_600_000;

interface Harness {
  readonly sampleOnce: () => void;
  readonly sampleEvents: Array<Record<string, unknown>>;
  readonly pressureEvents: Array<Record<string, unknown>>;
  readonly setHeap: (reading: JsHeapReading | null) => void;
  readonly setNow: (value: number) => void;
}

function createHarness(): Harness {
  const sampleEvents: Array<Record<string, unknown>> = [];
  const pressureEvents: Array<Record<string, unknown>> = [];
  let heap: JsHeapReading | null = { usedMb: 100, limitMb: 4096 };
  let now = 0;

  const emit: ResourceTelemetryEmitter = {
    sample: (properties) => {
      sampleEvents.push({ ...properties });
    },
    pressure: (properties) => {
      pressureEvents.push({ ...properties });
    },
  };

  const sampler = createResourceTelemetrySampler({
    now: () => now,
    startedAtMs: 0,
    readJsHeap: () => heap,
    collectContext: () => ({ openTabs: 3 }),
    emit,
  });

  return {
    sampleOnce: sampler.sampleOnce,
    sampleEvents,
    pressureEvents,
    setHeap: (reading) => {
      heap = reading;
    },
    setNow: (value) => {
      now = value;
    },
  };
}

describe("sessionAgeBucket", () => {
  it("buckets by elapsed hours at each boundary", () => {
    expect(sessionAgeBucket(0)).toBe("under_1h");
    expect(sessionAgeBucket(HOUR_MS - 1)).toBe("under_1h");
    expect(sessionAgeBucket(HOUR_MS)).toBe("1_to_4h");
    expect(sessionAgeBucket(4 * HOUR_MS)).toBe("4_to_12h");
    expect(sessionAgeBucket(12 * HOUR_MS)).toBe("over_12h");
    expect(sessionAgeBucket(40 * HOUR_MS)).toBe("over_12h");
  });
});

describe("heapSlopeMbPerHour", () => {
  it("withholds a slope until the window has enough points", () => {
    expect(heapSlopeMbPerHour([])).toBeNull();
    expect(
      heapSlopeMbPerHour([
        { atMs: 0, jsHeapMb: 100 },
        { atMs: HOUR_MS, jsHeapMb: 200 },
      ]),
    ).toBeNull();
  });

  it("measures a steady climb in MB per hour", () => {
    expect(
      heapSlopeMbPerHour([
        { atMs: 0, jsHeapMb: 100 },
        { atMs: HOUR_MS, jsHeapMb: 200 },
        { atMs: 2 * HOUR_MS, jsHeapMb: 300 },
      ]),
    ).toBe(100);
  });

  it("reports a negative slope while memory is being released", () => {
    expect(
      heapSlopeMbPerHour([
        { atMs: 0, jsHeapMb: 400 },
        { atMs: HOUR_MS, jsHeapMb: 300 },
        { atMs: 2 * HOUR_MS, jsHeapMb: 200 },
      ]),
    ).toBe(-100);
  });

  it("returns null when every sample shares one instant", () => {
    expect(
      heapSlopeMbPerHour([
        { atMs: 5, jsHeapMb: 100 },
        { atMs: 5, jsHeapMb: 200 },
        { atMs: 5, jsHeapMb: 300 },
      ]),
    ).toBeNull();
  });
});

describe("pressureTierFor", () => {
  it("maps heap size to the highest crossed tier at the desktop ceiling", () => {
    expect(pressureTierFor(1024, 4096)).toBeNull();
    expect(pressureTierFor(1536, 4096)).toBe("elevated");
    expect(pressureTierFor(2304, 4096)).toBe("high");
    expect(pressureTierFor(3072, 4096)).toBe("critical");
    expect(pressureTierFor(3900, 4096)).toBe("critical");
  });

  it("scales the tiers to a smaller heap ceiling", () => {
    // On a 2 GB ceiling the old absolute thresholds put `high` and `critical`
    // ABOVE the limit, so the tiers meant to fire before an allocation failure
    // could never fire at all.
    expect(pressureTierFor(768, 2048)).toBe("elevated");
    expect(pressureTierFor(1152, 2048)).toBe("high");
    expect(pressureTierFor(1536, 2048)).toBe("critical");
  });

  it("falls back to the desktop ceiling when the runtime reports no limit", () => {
    expect(pressureTierFor(1536, null)).toBe("elevated");
    expect(pressureTierFor(1024, null)).toBeNull();
  });
});

describe("createResourceTelemetrySampler", () => {
  it("emits one sample carrying heap and workload context", () => {
    const harness = createHarness();
    harness.sampleOnce();

    expect(harness.sampleEvents).toHaveLength(1);
    expect(harness.sampleEvents[0]).toMatchObject({
      js_heap_mb: 100,
      js_heap_limit_mb: 4096,
      session_age_bucket: "under_1h",
      open_tabs: 3,
      heap_slope_mb_per_h: null,
    });
    expect(harness.pressureEvents).toHaveLength(0);
  });

  it("carries no process-metric fields", () => {
    // Process CPU/working set are sourced from a main-process accumulator that
    // is shared with the Resource Monitor pollers, so reading it here both
    // corrupts their numbers and yields an interval this sampler did not
    // define. The event deliberately ships neither field.
    const harness = createHarness();
    harness.sampleOnce();

    const sample = harness.sampleEvents[0];
    expect(sample).not.toHaveProperty("renderer_working_set_mb");
    expect(sample).not.toHaveProperty("renderer_cpu_percent");
  });

  it("stays silent when the heap cannot be read at all", () => {
    const harness = createHarness();
    harness.setHeap(null);
    harness.sampleOnce();

    expect(harness.sampleEvents).toHaveLength(0);
    expect(harness.pressureEvents).toHaveLength(0);
  });

  it("fills in a slope once the rolling window has enough samples", () => {
    const harness = createHarness();
    harness.setHeap({ usedMb: 100, limitMb: 4096 });
    harness.sampleOnce();
    harness.setNow(HOUR_MS);
    harness.setHeap({ usedMb: 200, limitMb: 4096 });
    harness.sampleOnce();
    harness.setNow(2 * HOUR_MS);
    harness.setHeap({ usedMb: 300, limitMb: 4096 });
    harness.sampleOnce();

    expect(harness.sampleEvents[0].heap_slope_mb_per_h).toBeNull();
    expect(harness.sampleEvents[2].heap_slope_mb_per_h).toBe(100);
  });

  it("throttles a sustained tier but reports an escalation immediately", () => {
    const harness = createHarness();
    harness.setHeap({ usedMb: 1600, limitMb: 4096 });
    harness.sampleOnce();
    expect(harness.pressureEvents).toHaveLength(1);
    expect(harness.pressureEvents[0]).toMatchObject({
      pressure_tier: "elevated",
    });

    // Same tier, minutes later: throttled.
    harness.setNow(15 * 60_000);
    harness.sampleOnce();
    expect(harness.pressureEvents).toHaveLength(1);

    // Escalation bypasses the throttle.
    harness.setNow(30 * 60_000);
    harness.setHeap({ usedMb: 3100, limitMb: 4096 });
    harness.sampleOnce();
    expect(harness.pressureEvents).toHaveLength(2);
    expect(harness.pressureEvents[1]).toMatchObject({
      pressure_tier: "critical",
    });
  });

  it("re-reports after the throttle window elapses", () => {
    const harness = createHarness();
    harness.setHeap({ usedMb: 1600, limitMb: 4096 });
    harness.sampleOnce();
    harness.setNow(HOUR_MS);
    harness.sampleOnce();

    expect(harness.pressureEvents).toHaveLength(2);
  });

  it("re-arms escalation after the heap falls out of every tier", () => {
    const harness = createHarness();
    harness.setHeap({ usedMb: 3100, limitMb: 4096 });
    harness.sampleOnce();
    expect(harness.pressureEvents).toHaveLength(1);

    // Back under every threshold - no pressure event, and the tier memory resets.
    harness.setNow(60_000);
    harness.setHeap({ usedMb: 200, limitMb: 4096 });
    harness.sampleOnce();
    expect(harness.pressureEvents).toHaveLength(1);

    // Climbing again reports immediately despite being inside the throttle window.
    harness.setNow(120_000);
    harness.setHeap({ usedMb: 3100, limitMb: 4096 });
    harness.sampleOnce();
    expect(harness.pressureEvents).toHaveLength(2);
  });

  it("stops sampling once the disposer runs", () => {
    vi.useFakeTimers();
    try {
      const readJsHeap = vi.fn((): JsHeapReading | null => ({
        usedMb: 100,
        limitMb: 4096,
      }));
      const sampler = createResourceTelemetrySampler({
        now: () => 0,
        startedAtMs: 0,
        readJsHeap,
        collectContext: () => ({ openTabs: 0 }),
        emit: { sample: () => {}, pressure: () => {} },
      });
      const dispose = sampler.start();
      dispose();
      vi.advanceTimersByTime(60 * 60_000);
      expect(readJsHeap).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createResourceTelemetrySampler timer schedule", () => {
  it("samples once at the first-delay boundary and again each interval", () => {
    vi.useFakeTimers();
    try {
      const readJsHeap = vi.fn(() => ({ usedMb: 100, limitMb: 4096 }));
      const sampler = createResourceTelemetrySampler({
        now: () => 0,
        startedAtMs: 0,
        readJsHeap,
        collectContext: () => ({ openTabs: 0 }),
        emit: { sample: () => {}, pressure: () => {} },
      });
      const dispose = sampler.start();

      // Nothing before the first-sample delay: the point of that delay is to
      // skip the hydration transient rather than measure it.
      vi.advanceTimersByTime(RESOURCE_FIRST_SAMPLE_DELAY_MS - 1);
      expect(readJsHeap).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(readJsHeap).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(RESOURCE_SAMPLE_INTERVAL_MS);
      expect(readJsHeap).toHaveBeenCalledTimes(2);

      dispose();
      vi.advanceTimersByTime(RESOURCE_SAMPLE_INTERVAL_MS * 3);
      expect(readJsHeap).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
