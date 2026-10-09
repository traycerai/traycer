import type { SandboxShapeBounds } from "@traycer/protocol/host/sandbox-control";

const MC_PER_CREDIT = 1000;
const MB_PER_GIB = 1024;

/** Millicredits as a credit amount for copy: two decimals below 10, else whole. */
export function formatCredits(mc: number): string {
  const credits = mc / MC_PER_CREDIT;
  return credits < 10 ? credits.toFixed(2) : Math.round(credits).toString();
}

/**
 * A credit amount the user is told to ADD, in the same format, rounded UP:
 * hundredths below 10 credits, whole credits above. A balance or a rate
 * rounds to nearest (`formatCredits`); a top-up rounded down would leave the
 * account short and the retry refused again.
 */
export function formatCreditsRequired(mc: number): string {
  const centicredits = Math.ceil(mc / (MC_PER_CREDIT / 100));
  const credits = centicredits / 100;
  return credits < 10 ? credits.toFixed(2) : Math.ceil(credits).toString();
}

/** Megabytes as copy: GB from 1 GB up (one decimal when not whole), else MB. */
export function formatMemory(memoryMb: number): string {
  if (memoryMb < MB_PER_GIB) return `${memoryMb} MB`;
  const gib = memoryMb / MB_PER_GIB;
  return Number.isInteger(gib) ? `${gib} GB` : `${gib.toFixed(1)} GB`;
}

/**
 * Rounds UP to the step from the minimum, as the server's `quoteShape` does,
 * so the form shows the shape that will actually be created. Two decimals:
 * the server's `cpus` column is DECIMAL(6, 2).
 */
export function roundUpToStep(
  value: number,
  step: number,
  min: number,
): number {
  if (step <= 0) return value;
  const steps = Math.ceil((value - min) / step - 1e-9);
  return Math.round((min + Math.max(0, steps) * step) * 100) / 100;
}

export interface SandboxShape {
  readonly cpus: number;
  readonly memoryMb: number;
}

/** The shape the server will create for a request, within the bounds. */
export function roundSandboxShape(
  bounds: SandboxShapeBounds,
  requested: SandboxShape,
): SandboxShape {
  return {
    cpus: Math.min(
      bounds.cpuMax,
      roundUpToStep(requested.cpus, bounds.cpuStep, bounds.cpuMin),
    ),
    memoryMb: Math.min(
      bounds.memoryMaxMb,
      roundUpToStep(
        requested.memoryMb,
        bounds.memoryStepMb,
        bounds.memoryMinMb,
      ),
    ),
  };
}

/**
 * Why a shape is outside the catalogue, or `null` when it is inside: the
 * server's `quoteShape` checks in the server's order (vCPU, memory, then the
 * memory per vCPU of the ROUNDED shape), so the form refuses exactly what
 * `400 shape_not_offered` would, before sending it. The server stays the
 * authority.
 */
export function sandboxShapeProblem(
  bounds: SandboxShapeBounds,
  requested: SandboxShape,
): string | null {
  if (
    !Number.isFinite(requested.cpus) ||
    requested.cpus < bounds.cpuMin ||
    requested.cpus > bounds.cpuMax
  ) {
    return `vCPU must be between ${bounds.cpuMin} and ${bounds.cpuMax}.`;
  }
  if (
    !Number.isFinite(requested.memoryMb) ||
    requested.memoryMb < bounds.memoryMinMb ||
    requested.memoryMb > bounds.memoryMaxMb
  ) {
    return `Memory must be between ${formatMemory(bounds.memoryMinMb)} and ${formatMemory(bounds.memoryMaxMb)}.`;
  }
  const rounded = roundSandboxShape(bounds, requested);
  const perCpu = rounded.memoryMb / rounded.cpus;
  if (perCpu < bounds.memoryPerCpuMinMb || perCpu > bounds.memoryPerCpuMaxMb) {
    return `With ${rounded.cpus} vCPU, memory must be between ${formatMemory(rounded.cpus * bounds.memoryPerCpuMinMb)} and ${formatMemory(rounded.cpus * bounds.memoryPerCpuMaxMb)}.`;
  }
  return null;
}
