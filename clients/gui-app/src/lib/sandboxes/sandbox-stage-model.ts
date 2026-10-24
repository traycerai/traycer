import type { AuthenticatedUser } from "@traycer/protocol/auth";
import type {
  SandboxCatalogue,
  SandboxCataloguePricing,
  SandboxCatalogueProvider,
  SandboxOs,
  SandboxShapeRung,
} from "@traycer/protocol/host/sandbox-control";
import {
  sandboxCreateTeams,
  teamCannotCoverAnHour,
  teamSandboxBalanceMc,
} from "@/components/hosts/sandbox-create-model";
import { sandboxBalanceMc } from "@/lib/sandboxes/sandbox-balance";
import {
  roundSandboxShape,
  sandboxShapeProblem,
} from "@/lib/sandboxes/sandbox-pricing";
import {
  addCreditsPriceClause,
  audienceClause,
  costLine,
  moveClause,
  reachSentence,
  restingStorageClause,
  sharedUseClause,
  teamClause,
  unpricedCostLine,
  type SandboxConfigurationCopy,
} from "@/lib/sandboxes/sandbox-strings";

const MB_PER_GIB = 1024;

/** The spec's default shape: 2 vCPU, 4 GB. */
const DEFAULT_SHAPE = {
  cpus: 2,
  memoryMb: 4 * MB_PER_GIB,
} as const;
/** Minutes a new sandbox idles before it suspends. */
export const STAGE_DEFAULT_IDLE_MINUTES = 30;
/** Resting minutes before a new sandbox is destroyed: 7 days. */
export const STAGE_DEFAULT_DESTROY_AFTER_RESTING_MINUTES = 7 * 24 * 60;

/**
 * Where a staged sandbox is created: Personal or one of the person's teams.
 * A configuration is fixed at create and never changes.
 */
export type StageConfiguration =
  | { readonly kind: "personal" }
  | {
      readonly kind: "team";
      readonly teamId: string;
      readonly teamName: string;
    };

/** The id a configuration is remembered under: `personal` or the team id. */
export function stageConfigurationKey(
  configuration: StageConfiguration,
): string {
  return configuration.kind === "personal" ? "personal" : configuration.teamId;
}

export function stageConfigurationCopy(
  configuration: StageConfiguration,
): SandboxConfigurationCopy {
  return configuration.kind === "personal"
    ? { kind: "personal" }
    : { kind: "team", teamName: configuration.teamName };
}

/** Personal, then each of the person's teams by name. */
export function stageConfigurations(
  user: AuthenticatedUser | null,
): readonly StageConfiguration[] {
  return [
    { kind: "personal" },
    ...sandboxCreateTeams(user).map((team): StageConfiguration => ({
      kind: "team",
      teamId: team.teamId,
      teamName: team.name,
    })),
  ];
}

/** What a staged create asks the control plane for. */
export interface StageShape {
  readonly os: SandboxOs;
  readonly cpus: number;
  readonly memoryMb: number;
  /** `null` takes the provider's default disk. */
  readonly diskMb: number | null;
  readonly region: string;
  readonly idleMinutes: number;
  /** `null` keeps it until it is destroyed. */
  readonly destroyAfterRestingMinutes: number | null;
}

/**
 * The provider that serves an OS: the first offering it with a priced
 * region, as the server's `quoteShape` picks. `null` when none does.
 */
export function stageProviderFor(
  catalogue: SandboxCatalogue,
  os: SandboxOs,
): SandboxCatalogueProvider | null {
  return (
    catalogue.providers.find(
      (provider) =>
        provider.creatable &&
        provider.regions.length > 0 &&
        provider.os.includes(os),
    ) ?? null
  );
}

/** Linux first; Windows when no provider can create Linux. */
const STAGE_OS_PREFERENCE: readonly SandboxOs[] = ["linux", "windows"];

/** What a stage is priced and matched by: its OS, region and size. */
export type StageSize = Pick<
  StageShape,
  "os" | "region" | "cpus" | "memoryMb" | "diskMb"
>;

/** Whether a stage's size is this listed shape; an unset disk is the default. */
export function stageSizeIsRung(
  provider: SandboxCatalogueProvider,
  rung: SandboxShapeRung,
  size: Pick<StageShape, "cpus" | "memoryMb" | "diskMb">,
): boolean {
  return (
    size.cpus === rung.cpus &&
    size.memoryMb === rung.memoryMb &&
    (size.diskMb ?? provider.shape.diskDefaultMb) === rung.diskMb
  );
}

/** The listed shape a provider defaults to, or `null` when it lists none. */
export function defaultShapeRung(
  provider: SandboxCatalogueProvider,
): SandboxShapeRung | null {
  return provider.shapes?.find((rung) => rung.default) ?? null;
}

/**
 * Whether the provider offers a stage's size: one of its listed shapes, or
 * inside its bounds when it lists none.
 */
function stageSizeOffered(
  provider: SandboxCatalogueProvider,
  size: Pick<StageShape, "cpus" | "memoryMb" | "diskMb">,
): boolean {
  if (provider.shapes === null) {
    return sandboxShapeProblem(provider.shape, size) === null;
  }
  return provider.shapes.some((rung) => stageSizeIsRung(provider, rung, size));
}

/**
 * The shape a New row stages, of the first OS a provider can create (Linux,
 * else Windows) in its default region: the provider's default listed shape;
 * from a provider that lists none, 2 vCPU / 4 GB rounded into its bounds, or
 * its smallest shape when that one is outside them. `null` when no provider
 * can create either.
 */
export function defaultStageShape(
  catalogue: SandboxCatalogue,
): StageShape | null {
  const offered = STAGE_OS_PREFERENCE.map((os) => ({
    os,
    provider: stageProviderFor(catalogue, os),
  })).find((candidate) => candidate.provider !== null);
  if (offered === undefined || offered.provider === null) return null;
  const { os, provider } = offered;
  const rung = defaultShapeRung(provider);
  if (rung !== null) {
    return {
      os,
      cpus: rung.cpus,
      memoryMb: rung.memoryMb,
      diskMb: rung.diskMb,
      region: provider.regions[0].id,
      idleMinutes: STAGE_DEFAULT_IDLE_MINUTES,
      destroyAfterRestingMinutes: STAGE_DEFAULT_DESTROY_AFTER_RESTING_MINUTES,
    };
  }
  const bounds = provider.shape;
  const asked = roundSandboxShape(bounds, DEFAULT_SHAPE);
  const shape =
    sandboxShapeProblem(bounds, asked) === null
      ? asked
      : {
          cpus: bounds.cpuMin,
          memoryMb: Math.max(
            bounds.memoryMinMb,
            bounds.cpuMin * bounds.memoryPerCpuMinMb,
          ),
        };
  return {
    os,
    cpus: shape.cpus,
    memoryMb: shape.memoryMb,
    diskMb: null,
    region: provider.regions[0].id,
    idleMinutes: STAGE_DEFAULT_IDLE_MINUTES,
    destroyAfterRestingMinutes: STAGE_DEFAULT_DESTROY_AFTER_RESTING_MINUTES,
  };
}

/**
 * A remembered shape when the catalogue still offers it, else the default.
 * A region or OS withdrawn since the pick falls back rather than staging a
 * create the server would refuse.
 */
export function rememberedOrDefaultStageShape(
  catalogue: SandboxCatalogue,
  remembered: StageShape | null,
): StageShape | null {
  if (remembered !== null) {
    const provider = stageProviderFor(catalogue, remembered.os);
    if (
      provider !== null &&
      provider.regions.some((region) => region.id === remembered.region) &&
      stageSizeOffered(provider, remembered)
    ) {
      return remembered;
    }
  }
  return defaultStageShape(catalogue);
}

/**
 * The hourly price a stage is shown at: the shape's own, computed from the
 * region's per-unit rates. A server without them prices only each region's
 * SMALLEST shape, so the figure is then exact for that shape and a lower
 * bound (`exact: false`, read as "from") for any larger one.
 */
export interface StagePrice {
  readonly awakeMcPerHour: number;
  readonly exact: boolean;
}

/** A size's awake price an hour from a region's per-unit rates. */
function ratedAwakeMcPerHour(
  rates: SandboxCataloguePricing,
  size: { readonly cpus: number; readonly memoryMb: number },
  diskMb: number,
): number {
  return Math.round(
    (size.cpus * rates.vcpuHourMillicredits +
      (size.memoryMb / MB_PER_GIB) * rates.memoryGbHourMillicredits +
      (diskMb / MB_PER_GIB) * rates.diskGbHourMillicredits) *
      rates.multiplier,
  );
}

/** A provider's smallest listed shape: fewest vCPU, then memory, then disk. */
function smallestShapeRung(
  shapes: readonly SandboxShapeRung[],
): SandboxShapeRung | null {
  return shapes.reduce<SandboxShapeRung | null>((smallest, rung) => {
    if (smallest === null) return rung;
    const order =
      rung.cpus - smallest.cpus ||
      rung.memoryMb - smallest.memoryMb ||
      rung.diskMb - smallest.diskMb;
    return order < 0 ? rung : smallest;
  }, null);
}

/**
 * The region's smallest shape: its price, and whether `shape` is it, by its
 * cpus, memory and disk (an unset disk is the provider's default). Of a
 * provider that lists its shapes, the smallest listed one, priced from the
 * region's rates when it has them.
 */
export function stageSmallestShape(
  catalogue: SandboxCatalogue,
  shape: StageSize,
): { readonly isStaged: boolean; readonly awakeMcPerHour: number } | null {
  const provider = stageProviderFor(catalogue, shape.os);
  if (provider === null) return null;
  const region =
    provider.regions.find((candidate) => candidate.id === shape.region) ?? null;
  if (region === null) return null;
  const smallestRung =
    provider.shapes === null ? null : smallestShapeRung(provider.shapes);
  if (smallestRung !== null) {
    return {
      isStaged: stageSizeIsRung(provider, smallestRung, shape),
      awakeMcPerHour:
        region.pricing === null
          ? region.fromPriceMcPerHour.awakeMc
          : ratedAwakeMcPerHour(
              region.pricing,
              smallestRung,
              smallestRung.diskMb,
            ),
    };
  }
  const bounds = provider.shape;
  const smallestMemoryMb = Math.max(
    bounds.memoryMinMb,
    bounds.cpuMin * bounds.memoryPerCpuMinMb,
  );
  return {
    isStaged:
      shape.cpus === bounds.cpuMin &&
      shape.memoryMb === smallestMemoryMb &&
      (shape.diskMb ?? bounds.diskDefaultMb) === bounds.diskMinMb,
    awakeMcPerHour: region.fromPriceMcPerHour.awakeMc,
  };
}

export function stagePrice(
  catalogue: SandboxCatalogue,
  shape: StageSize,
): StagePrice | null {
  const provider = stageProviderFor(catalogue, shape.os);
  const region =
    provider?.regions.find((candidate) => candidate.id === shape.region) ??
    null;
  const smallest = stageSmallestShape(catalogue, shape);
  if (provider === null || region === null || smallest === null) return null;
  const rates = region.pricing;
  if (rates === null) {
    return {
      awakeMcPerHour: smallest.awakeMcPerHour,
      exact: smallest.isStaged,
    };
  }
  const diskMb = shape.diskMb ?? provider.shape.diskDefaultMb;
  return {
    awakeMcPerHour: ratedAwakeMcPerHour(rates, shape, diskMb),
    exact: true,
  };
}

/**
 * The balance a create in this configuration draws on: the personal credits,
 * or the person's own assignment under the team. `null` while unknown.
 */
export function stageBalanceMc(
  user: AuthenticatedUser | null,
  configuration: StageConfiguration,
): number | null {
  return configuration.kind === "personal"
    ? sandboxBalanceMc(user)
    : teamSandboxBalanceMc(user, configuration.teamId);
}

/**
 * A zero or short balance: it cannot cover an hour at the stage's price
 * (the region's smallest shape's, from a server without per-unit rates).
 * Unknown either side is not short; the server's gate stays the authority
 * at send.
 */
export function stageNeedsCredits(
  balanceMc: number | null,
  price: StagePrice | null,
): boolean {
  return teamCannotCoverAnHour(
    balanceMc,
    price === null ? null : price.awakeMcPerHour,
  );
}

/** The audience the block speaks to: a task that has or may gain readers. */
export type StageAudience = "private" | "shared";

/** What the consequences block is composed from. */
export interface ConsequencesInput {
  readonly configuration: StageConfiguration;
  readonly price: StagePrice | null;
  readonly needsCredits: boolean;
  readonly audience: StageAudience;
  /**
   * A host of another configuration the task already holds, named, or
   * `your hosts` where the reader may not learn its name; `null` when the
   * task holds none.
   */
  readonly reachHost: string | null;
  /** The computer whose settings have not moved, or `null`. */
  readonly unmovedComputer: string | null;
}

export type ConsequenceClauseKind =
  | "price"
  | "audience"
  | "reach"
  | "team"
  | "resting-storage"
  | "shared-use"
  | "move";

export interface ConsequenceClause {
  readonly kind: ConsequenceClauseKind;
  readonly text: string;
}

/** The price clause, never collapsed: a price is not a disclosure. */
export function priceClause(input: ConsequencesInput): ConsequenceClause {
  const copy = stageConfigurationCopy(input.configuration);
  if (input.price === null) {
    return { kind: "price", text: unpricedCostLine(copy) };
  }
  if (input.needsCredits) {
    return {
      kind: "price",
      text: addCreditsPriceClause(input.price.awakeMcPerHour),
    };
  }
  const line = costLine(input.price.awakeMcPerHour, copy);
  return { kind: "price", text: input.price.exact ? line : `from ${line}` };
}

/**
 * Every clause the block shows in full, in the spec's order: the price
 * always; the audience when the task has or may gain readers; the reach when
 * it holds a host of another configuration; the team, resting-storage and
 * shared-use clauses on a team; the move clause on an unmoved computer.
 */
export function consequenceClauses(
  input: ConsequencesInput,
): readonly ConsequenceClause[] {
  const copy = stageConfigurationCopy(input.configuration);
  const clauses: ConsequenceClause[] = [priceClause(input)];
  if (input.audience === "shared") {
    clauses.push({ kind: "audience", text: audienceClause(copy) });
  }
  if (input.reachHost !== null) {
    clauses.push({ kind: "reach", text: reachSentence(input.reachHost) });
  }
  if (input.configuration.kind === "team") {
    clauses.push(
      { kind: "team", text: teamClause(input.configuration.teamName) },
      { kind: "resting-storage", text: restingStorageClause() },
      { kind: "shared-use", text: sharedUseClause() },
    );
  }
  if (input.unmovedComputer !== null) {
    clauses.push({ kind: "move", text: moveClause(input.unmovedComputer) });
  }
  return clauses;
}

/**
 * The context a full render is recorded under: the configuration, the
 * audience category and the wording version. An unchanged repeat of all
 * three collapses the block to its price.
 */
export function consequencesShownSubject(
  configuration: StageConfiguration,
  audience: StageAudience,
  wordingVersion: number,
): string {
  return [
    stageConfigurationKey(configuration),
    audience,
    String(wordingVersion),
  ].join("\u0000");
}
