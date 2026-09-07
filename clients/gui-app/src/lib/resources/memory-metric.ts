import { formatMemoryBytes } from "@/lib/resources/format-resource-usage";
import type {
  AppResourceUsage,
  HostTreeResourceUsage,
  OtherResourceUsage,
  OwnerResourceUsage,
  RestrictedResourceUsage,
} from "@/stores/resources/resources-store";

export type ResourceMemoryMetric = "pss" | "rss";

/** The three readings every `@1.5` row and aggregate carries. */
export interface ResourceMemoryUsage {
  readonly rssBytes: number | null;
  readonly pssBytes: number | null;
  readonly privateBytes: number | null;
}

export interface ResourceMemoryProjection {
  readonly app: AppResourceUsage | null;
  readonly hostTree: HostTreeResourceUsage | null;
  readonly other: OtherResourceUsage | null;
  readonly restricted: RestrictedResourceUsage | null;
  readonly owners: readonly OwnerResourceUsage[];
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
  const all: ResourceMemoryUsage[] = [
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
  return all.every((usage) => usage.pssBytes !== null) ? "pss" : "rss";
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

/**
 * The one rendering of an unavailable reading. Split deliberately: the dash is
 * decoration (`aria-hidden`) wherever a row shows it, and the words are what a
 * screen reader or a tooltip gets - never `0 B`, which is a real measurement.
 */
export const UNAVAILABLE_DASH = "\u2014";

export function formatMemoryBytesOrUnavailable(bytes: number | null): string {
  return bytes === null ? "Unavailable" : formatMemoryBytes(bytes);
}
