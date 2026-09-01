export type ResourceMemoryMetric = "pss" | "rss";

export interface ResourceMemoryUsage {
  readonly rssBytes: number | null;
  readonly pssBytes: number | null;
  readonly privateBytes: number | null;
}

export interface ResourceMemoryProjection {
  readonly app:
    | (ResourceMemoryUsage & {
        readonly process: ResourceMemoryUsage | null;
      })
    | null;
  readonly hostTree: ResourceMemoryUsage | null;
  readonly other:
    | (ResourceMemoryUsage & {
        readonly processes: readonly ResourceMemoryUsage[];
      })
    | null;
  readonly restricted: ResourceMemoryUsage | null;
  readonly owners: readonly (ResourceMemoryUsage & {
    readonly processes: readonly ResourceMemoryUsage[];
  })[];
}

function hasPss(usage: ResourceMemoryUsage): boolean {
  return usage.pssBytes !== null;
}

/**
 * PSS is selected only when the complete displayed host scope can support it.
 * Electron's metrics are working-set values, so including Desktop deliberately
 * selects the compatible RSS/working-set view for every row and total.
 */
export function selectResourceMemoryMetric(
  projection: ResourceMemoryProjection,
  includesDesktopWorkingSet: boolean,
): ResourceMemoryMetric {
  if (includesDesktopWorkingSet || projection.hostTree === null) return "rss";
  const all = [
    projection.hostTree,
    ...(projection.app === null
      ? []
      : [
          projection.app,
          ...(projection.app.process === null ? [] : [projection.app.process]),
        ]),
    ...(projection.other === null
      ? []
      : [projection.other, ...projection.other.processes]),
    ...(projection.restricted === null ? [] : [projection.restricted]),
    ...projection.owners.flatMap((owner) => [owner, ...owner.processes]),
  ];
  return all.every(hasPss) ? "pss" : "rss";
}

/** Caller chooses PSS only after complete-scope validation above. */
export function resourceMemoryBytes(
  usage: ResourceMemoryUsage,
  metric: ResourceMemoryMetric,
): number | null {
  return metric === "pss" ? usage.pssBytes : usage.rssBytes;
}

/** A containing total is known only when every included reading is known. */
export function sumCompleteMemoryBytes(
  values: readonly (number | null)[],
): number | null {
  let total = 0;
  for (const value of values) {
    if (value === null) return null;
    total += value;
  }
  return total;
}

export function resourceMemoryLabel(
  metric: ResourceMemoryMetric,
  includesDesktopWorkingSet: boolean,
): string {
  if (metric === "pss") return "Proportional memory (PSS)";
  return includesDesktopWorkingSet
    ? "Resident / working-set memory"
    : "Resident memory (RSS)";
}

export function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}
