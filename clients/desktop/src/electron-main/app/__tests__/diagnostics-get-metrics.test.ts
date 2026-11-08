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

import { app } from "electron";
import { handleGetMetrics } from "../diagnostics";

const PROCESS_MEMORY: Electron.ProcessMemoryInfo = {
  private: 102_400,
  residentSet: 204_800,
  shared: 51_200,
};

function nativeMetric(
  pid: number,
  type: Electron.ProcessMetric["type"],
  percentCPUUsage: number,
): Electron.ProcessMetric {
  return {
    pid,
    type,
    creationTime: 0,
    cpu: { percentCPUUsage, idleWakeupsPerSecond: 3 },
    memory: { workingSetSize: 51_200, peakWorkingSetSize: 61_440 },
  };
}

describe("handleGetMetrics", () => {
  beforeEach(() => {
    // `getProcessMemoryInfo` exists only inside Electron's process object.
    Object.defineProperty(process, "getProcessMemoryInfo", {
      configurable: true,
      value: () => Promise.resolve(PROCESS_MEMORY),
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(process, "getProcessMemoryInfo");
    vi.mocked(app.getAppMetrics).mockReset();
  });

  it("preserves Electron's native machine share under the explicit IPC field", async () => {
    // Electron already reports machine share. The boundary changes the field
    // name to keep that unit distinct from host per-core CPU values.
    vi.mocked(app.getAppMetrics).mockReturnValue([
      nativeMetric(100, "Browser", 6.25),
      nativeMetric(200, "Tab", 0.5),
    ]);

    const metrics = await handleGetMetrics();

    expect(metrics.appMetrics).toEqual([
      {
        pid: 100,
        type: "Browser",
        creationTime: 0,
        cpu: { cpuSharePercent: 6.25, idleWakeupsPerSecond: 3 },
        memory: { workingSetSize: 51_200, peakWorkingSetSize: 61_440 },
      },
      {
        pid: 200,
        type: "Tab",
        creationTime: 0,
        cpu: { cpuSharePercent: 0.5, idleWakeupsPerSecond: 3 },
        memory: { workingSetSize: 51_200, peakWorkingSetSize: 61_440 },
      },
    ]);
    expect(metrics.main).toEqual(PROCESS_MEMORY);
  });
});
