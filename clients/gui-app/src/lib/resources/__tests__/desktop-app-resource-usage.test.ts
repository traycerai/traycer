import { afterEach, describe, expect, it, vi } from "vitest";
import {
  desktopAppResourceUsageFromMetrics,
  getDesktopDiagnosticsBridge,
  type DesktopProcessMetricsSnapshot,
} from "@/lib/resources/desktop-app-resource-usage";

function snapshot(
  appMetrics: DesktopProcessMetricsSnapshot["appMetrics"],
): DesktopProcessMetricsSnapshot {
  return { appMetrics };
}

function setRunnerHost(value: object): void {
  Object.defineProperty(globalThis, "runnerHost", {
    configurable: true,
    value,
  });
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "runnerHost");
});

describe("getDesktopDiagnosticsBridge", () => {
  it("returns the diagnostics bridge when getMetrics is present", () => {
    const getMetrics = vi.fn(() => Promise.resolve(snapshot([])));
    setRunnerHost({
      platform: {
        diagnostics: {
          getMetrics,
        },
      },
    });

    expect(getDesktopDiagnosticsBridge()).toEqual({ getMetrics });
  });

  it("returns null when runnerHost is missing", () => {
    expect(getDesktopDiagnosticsBridge()).toBeNull();
  });

  it("returns null for missing platform diagnostics", () => {
    setRunnerHost({ platform: {} });

    expect(getDesktopDiagnosticsBridge()).toBeNull();
  });

  it("returns null for malformed diagnostics", () => {
    setRunnerHost({
      platform: {
        diagnostics: {},
      },
    });

    expect(getDesktopDiagnosticsBridge()).toBeNull();
  });
});

describe("desktopAppResourceUsageFromMetrics", () => {
  it("groups Electron app metrics into main, renderer, and other usage", () => {
    const usage = desktopAppResourceUsageFromMetrics(
      snapshot([
        {
          pid: 10,
          type: "Browser",
          cpu: { percentCPUUsage: 0.5 },
          memory: { workingSetSize: 100 },
        },
        {
          pid: 11,
          type: "Tab",
          cpu: { percentCPUUsage: 0.25 },
          memory: { workingSetSize: 200 },
        },
        {
          pid: 12,
          type: "renderer",
          cpu: { percentCPUUsage: 0.75 },
          memory: { workingSetSize: 300 },
        },
        {
          pid: 13,
          type: "GPU",
          cpu: { percentCPUUsage: 1.5 },
          memory: { workingSetSize: 400 },
        },
      ]),
      123,
    );

    expect(usage.sampledAt).toBe(123);
    expect(usage.main).toEqual({
      cpuPercent: 0.5,
      rssBytes: 100 * 1024,
      processCount: 1,
    });
    expect(usage.renderer).toEqual({
      cpuPercent: 1,
      rssBytes: 500 * 1024,
      processCount: 2,
    });
    expect(usage.other).toEqual({
      cpuPercent: 1.5,
      rssBytes: 400 * 1024,
      processCount: 1,
    });
    expect(usage.cpuPercent).toBe(3);
    expect(usage.rssBytes).toBe(1000 * 1024);
    expect(usage.processCount).toBe(4);
  });

  it("clamps negative and non-finite metric values to zero", () => {
    const usage = desktopAppResourceUsageFromMetrics(
      snapshot([
        {
          pid: 10,
          type: "Browser",
          cpu: { percentCPUUsage: Number.NaN },
          memory: { workingSetSize: -10 },
        },
        {
          pid: 0,
          type: "Tab",
          cpu: { percentCPUUsage: -1 },
          memory: { workingSetSize: Number.POSITIVE_INFINITY },
        },
      ]),
      123,
    );

    expect(usage.cpuPercent).toBe(0);
    expect(usage.rssBytes).toBe(0);
    expect(usage.processCount).toBe(1);
  });
});
