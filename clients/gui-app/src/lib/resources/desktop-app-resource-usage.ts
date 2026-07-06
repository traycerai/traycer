export interface DesktopAppProcessGroupUsage {
  readonly cpuPercent: number;
  readonly rssBytes: number;
  readonly processCount: number;
}

export interface DesktopAppResourceUsage {
  readonly sampledAt: number;
  readonly cpuPercent: number;
  readonly rssBytes: number;
  readonly processCount: number;
  readonly main: DesktopAppProcessGroupUsage;
  readonly renderer: DesktopAppProcessGroupUsage;
  readonly other: DesktopAppProcessGroupUsage;
}

export interface DesktopProcessMetric {
  readonly pid: number;
  readonly type: string;
  readonly cpu: { readonly percentCPUUsage: number };
  readonly memory: { readonly workingSetSize: number };
}

export interface DesktopProcessMetricsSnapshot {
  readonly appMetrics: readonly DesktopProcessMetric[];
}

export interface DesktopDiagnosticsBridge {
  readonly getMetrics: () => Promise<DesktopProcessMetricsSnapshot>;
}

interface RunnerHostWindowShape {
  readonly platform:
    | {
        readonly diagnostics:
          | {
              readonly getMetrics:
                (() => Promise<DesktopProcessMetricsSnapshot>) | undefined;
            }
          | undefined;
      }
    | undefined;
}

const EMPTY_GROUP: DesktopAppProcessGroupUsage = {
  cpuPercent: 0,
  rssBytes: 0,
  processCount: 0,
};

export function getDesktopDiagnosticsBridge(): DesktopDiagnosticsBridge | null {
  const host = (globalThis as { runnerHost?: RunnerHostWindowShape })
    .runnerHost;
  const getMetrics = host?.platform?.diagnostics?.getMetrics;
  return getMetrics === undefined ? null : { getMetrics };
}

export function desktopAppResourceUsageFromMetrics(
  snapshot: DesktopProcessMetricsSnapshot,
  sampledAt: number,
): DesktopAppResourceUsage {
  let main = EMPTY_GROUP;
  let renderer = EMPTY_GROUP;
  let other = EMPTY_GROUP;

  for (const metric of snapshot.appMetrics) {
    const usage = processMetricUsage(metric);
    if (metric.type === "Browser") {
      main = addProcessGroupUsage(main, usage);
    } else if (isRendererProcessType(metric.type)) {
      renderer = addProcessGroupUsage(renderer, usage);
    } else {
      other = addProcessGroupUsage(other, usage);
    }
  }

  return {
    sampledAt,
    cpuPercent: main.cpuPercent + renderer.cpuPercent + other.cpuPercent,
    rssBytes: main.rssBytes + renderer.rssBytes + other.rssBytes,
    processCount:
      main.processCount + renderer.processCount + other.processCount,
    main,
    renderer,
    other,
  };
}

function isRendererProcessType(type: string): boolean {
  const normalized = type.toLowerCase();
  return normalized === "renderer" || normalized === "tab";
}

function processMetricUsage(
  metric: DesktopProcessMetric,
): DesktopAppProcessGroupUsage {
  return {
    cpuPercent: normalizeFiniteNumber(metric.cpu.percentCPUUsage),
    rssBytes: normalizeFiniteNumber(metric.memory.workingSetSize) * 1024,
    processCount: metric.pid > 0 ? 1 : 0,
  };
}

function addProcessGroupUsage(
  current: DesktopAppProcessGroupUsage,
  next: DesktopAppProcessGroupUsage,
): DesktopAppProcessGroupUsage {
  return {
    cpuPercent: current.cpuPercent + next.cpuPercent,
    rssBytes: current.rssBytes + next.rssBytes,
    processCount: current.processCount + next.processCount,
  };
}

function normalizeFiniteNumber(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, value);
}
