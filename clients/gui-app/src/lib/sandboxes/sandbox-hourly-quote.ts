import type {
  SandboxCatalogue,
  SandboxCatalogueProvider,
  SandboxOs,
} from "@traycer/protocol/host/sandbox-control";
import { formatCredits } from "@/lib/sandboxes/sandbox-pricing";
import {
  defaultStageShape,
  stagePrice,
} from "@/lib/sandboxes/sandbox-stage-model";
import {
  stagedNewShape,
  type StagedNewShape,
} from "@/lib/sandboxes/staged-sandbox-in-window";

/**
 * The hourly awake price a staged sandbox would meet, or the catalogue's
 * default shape when none is staged: the default listed shape, priced as the
 * stage is, of a provider that lists its shapes; else the smallest bound.
 * Regions of a provider without a list price only the smallest shape, so a
 * larger staged shape is a lower bound.
 */
export interface SandboxHourlyQuote {
  readonly awakeMc: number;
  readonly exact: boolean;
}

export function sandboxHourlyQuote(
  catalogue: SandboxCatalogue | undefined,
  staged: unknown,
): SandboxHourlyQuote | null {
  if (catalogue === undefined) return null;
  const shape = stagedNewShape(staged);
  if (shape === null) return defaultSmallestQuote(catalogue);
  return quoteForShape(catalogue, shape) ?? defaultSmallestQuote(catalogue);
}

/** `$0.12 an hour while awake`, or `from $0.12 an hour while awake`. */
export function formatAwakeHourlyPrice(quote: SandboxHourlyQuote): string {
  const dollars = `$${formatCredits(quote.awakeMc)}`;
  return quote.exact
    ? `${dollars} an hour while awake`
    : `from ${dollars} an hour while awake`;
}

function defaultSmallestQuote(
  catalogue: SandboxCatalogue,
): SandboxHourlyQuote | null {
  const provider = firstPricedProvider(catalogue, null);
  if (provider !== null && provider.shapes !== null) {
    const shape = defaultStageShape(catalogue);
    const price = shape === null ? null : stagePrice(catalogue, shape);
    if (price !== null) {
      return { awakeMc: price.awakeMcPerHour, exact: price.exact };
    }
  }
  const region = provider?.regions[0];
  if (region === undefined) return null;
  return { awakeMc: region.fromPriceMcPerHour.awakeMc, exact: true };
}

function quoteForShape(
  catalogue: SandboxCatalogue,
  shape: StagedNewShape,
): SandboxHourlyQuote | null {
  const os = sandboxOs(shape.os);
  if (os === null) return null;
  const provider = firstPricedProvider(catalogue, os);
  if (provider === null) return null;
  if (provider.shapes !== null) {
    const price = stagePrice(catalogue, { ...shape, os });
    return price === null
      ? null
      : { awakeMc: price.awakeMcPerHour, exact: price.exact };
  }
  const region =
    provider.regions.find((candidate) => candidate.id === shape.region) ??
    provider.regions[0];
  const bounds = provider.shape;
  const smallestMemoryMb = Math.max(
    bounds.memoryMinMb,
    bounds.cpuMin * bounds.memoryPerCpuMinMb,
  );
  return {
    awakeMc: region.fromPriceMcPerHour.awakeMc,
    exact: shape.cpus === bounds.cpuMin && shape.memoryMb === smallestMemoryMb,
  };
}

function firstPricedProvider(
  catalogue: SandboxCatalogue,
  os: SandboxOs | null,
): SandboxCatalogueProvider | null {
  return (
    catalogue.providers.find((provider) => {
      if (!provider.creatable || provider.regions.length === 0) return false;
      return os === null || provider.os.includes(os);
    }) ?? null
  );
}

function sandboxOs(value: string): SandboxOs | null {
  if (value === "linux" || value === "windows") return value;
  return null;
}
