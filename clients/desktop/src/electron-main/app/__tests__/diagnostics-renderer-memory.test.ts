import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
  app: {
    getAppMetrics: vi.fn((): ReadonlyArray<Electron.ProcessMetric> => []),
  },
  contentTracing: {
    startRecording: vi.fn(() => Promise.resolve()),
    stopRecording: vi.fn(() => Promise.resolve("")),
  },
}));

vi.mock("electron-log", () => ({
  default: {
    transports: { file: { level: "info" }, console: { level: "info" } },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@sentry/electron/main", () => ({
  isInitialized: vi.fn((): boolean => true),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

import { addBreadcrumb, captureMessage } from "@sentry/electron/main";
import { app } from "electron";
import { markSentryEnabled } from "../crash-reporter-state";
import { startRendererMemorySampler } from "../diagnostics";

const SAMPLE_INTERVAL_MS = 5 * 60_000;
const THROTTLE_MS = 60 * 60_000;
const OVER_THRESHOLD_KB = 3 * 1024 * 1024 + 1024;

/**
 * The one metric shape the sampler reads. `type: "Tab"` because everything
 * else is filtered out before the threshold is even looked at.
 */
function rendererMetric(
  pid: number,
  workingSetKb: number,
): Electron.ProcessMetric {
  return {
    pid,
    type: "Tab",
    creationTime: 0,
    cpu: { percentCPUUsage: 0, idleWakeupsPerSecond: 0 },
    memory: { workingSetSize: workingSetKb, peakWorkingSetSize: workingSetKb },
  };
}

describe("startRendererMemorySampler", () => {
  beforeEach(() => {
    // The real flag, not a mock: it is a one-way boolean and the sampler's
    // Sentry branch is exactly what these cases are about.
    markSentryEnabled();
    vi.useFakeTimers();
    vi.mocked(app.getAppMetrics).mockReturnValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("captures one message and one breadcrumb on a renderer's first crossing", () => {
    vi.mocked(app.getAppMetrics).mockReturnValue([
      rendererMetric(101, OVER_THRESHOLD_KB),
    ]);
    startRendererMemorySampler();

    vi.advanceTimersByTime(SAMPLE_INTERVAL_MS);

    expect(vi.mocked(captureMessage)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(addBreadcrumb)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(addBreadcrumb)).toHaveBeenCalledWith({
      category: "renderer.memory",
      level: "warning",
      message: "renderer memory approaching old-space cap",
      data: {
        pid: 101,
        workingSetKb: OVER_THRESHOLD_KB,
        peakWorkingSetKb: OVER_THRESHOLD_KB,
      },
    });
  });

  it("adds a breadcrumb and no second message on the next throttled crossing for the same pid", () => {
    vi.mocked(app.getAppMetrics).mockReturnValue([
      rendererMetric(202, OVER_THRESHOLD_KB),
    ]);
    startRendererMemorySampler();

    vi.advanceTimersByTime(SAMPLE_INTERVAL_MS);
    expect(vi.mocked(captureMessage)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(addBreadcrumb)).toHaveBeenCalledTimes(1);

    // Every tick inside the hour is swallowed by the throttle; the first one
    // past it is the crossing that must stay breadcrumb-only.
    vi.advanceTimersByTime(THROTTLE_MS);

    expect(vi.mocked(captureMessage)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(addBreadcrumb)).toHaveBeenCalledTimes(2);
  });

  it("captures again for a renderer pid that has not crossed before", () => {
    vi.mocked(app.getAppMetrics).mockReturnValue([
      rendererMetric(303, OVER_THRESHOLD_KB),
    ]);
    startRendererMemorySampler();

    vi.advanceTimersByTime(SAMPLE_INTERVAL_MS);
    expect(vi.mocked(captureMessage)).toHaveBeenCalledTimes(1);

    vi.mocked(app.getAppMetrics).mockReturnValue([
      rendererMetric(303, OVER_THRESHOLD_KB),
      rendererMetric(404, OVER_THRESHOLD_KB),
    ]);
    vi.advanceTimersByTime(SAMPLE_INTERVAL_MS);

    expect(vi.mocked(captureMessage)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(captureMessage)).toHaveBeenLastCalledWith(
      "renderer memory approaching old-space cap",
      {
        level: "warning",
        tags: { workingSetKb: String(OVER_THRESHOLD_KB) },
      },
    );
    expect(vi.mocked(addBreadcrumb)).toHaveBeenCalledTimes(2);
  });

  it("stays silent while every renderer is under the threshold", () => {
    vi.mocked(app.getAppMetrics).mockReturnValue([
      rendererMetric(505, 1024 * 1024),
    ]);
    startRendererMemorySampler();

    vi.advanceTimersByTime(SAMPLE_INTERVAL_MS * 3);

    expect(vi.mocked(captureMessage)).not.toHaveBeenCalled();
    expect(vi.mocked(addBreadcrumb)).not.toHaveBeenCalled();
  });
});
