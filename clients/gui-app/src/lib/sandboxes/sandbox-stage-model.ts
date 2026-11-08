import type { AuthenticatedUser } from "@traycer/protocol/auth";
import type {
  SandboxCatalogue,
  SandboxHourlyPrice,
  SandboxCataloguePricing,
  SandboxCatalogueRegion,
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
  roundUpToStep,
  sandboxShapeProblem,
} from "@/lib/sandboxes/sandbox-pricing";
import {
  notEnoughCreditsLine,
  teamAllowanceShortLine,
  audienceClause,
  costLine,
  fundedRowPrice,
  moveClause,
  reachSentence,
  restingStorageClause,
  TEAM_USE_AND_ACCESS_CLAUSE,
  unpricedCostLine,
  type SandboxConfigurationCopy,
} from "@/lib/sandboxes/sandbox-strings";

const MB_PER_GIB = 1024;

/** The built-in default shape: 2 vCPU, 4 GB. */
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

/** The first provider that can quote this OS, region and size. */
export function stageProviderForShape(
  catalogue: SandboxCatalogue,
  shape: StageSize,
): SandboxCatalogueProvider | null {
  return (
    catalogue.providers.find(
      (provider) =>
        provider.creatable &&
        provider.os.includes(shape.os) &&
        provider.regions.some((region) => region.id === shape.region) &&
        stageQuotedSize(provider, shape) !== null,
    ) ?? null
  );
}

/** Whether a stage's size is this listed shape; an unset disk uses the rung's disk. */
export function stageSizeIsRung(
  rung: SandboxShapeRung,
  size: Pick<StageShape, "cpus" | "memoryMb" | "diskMb">,
): boolean {
  return (
    size.cpus === rung.cpus &&
    size.memoryMb === rung.memoryMb &&
    (size.diskMb === null || size.diskMb === rung.diskMb)
  );
}

interface StageGeometry {
  readonly cpus: number;
  readonly memoryMb: number;
  readonly diskMb: number;
}

interface QuotedStageSize {
  readonly shape: StageGeometry;
  readonly exact: boolean;
}

/** The allocated geometry the server quotes, or a lower bound when an older server omits its disk step. */
export function stageQuotedSize(
  provider: SandboxCatalogueProvider,
  requestedSize: Pick<StageShape, "cpus" | "memoryMb" | "diskMb">,
): QuotedStageSize | null {
  if (provider.shapes !== null) {
    const matching = provider.shapes.filter((candidate) =>
      stageSizeIsRung(candidate, requestedSize),
    );
    const rung =
      (requestedSize.diskMb === null
        ? matching.find((candidate) => candidate.default)
        : undefined) ?? matching.at(0);
    return rung === undefined
      ? null
      : {
          shape: {
            cpus: rung.cpus,
            memoryMb: rung.memoryMb,
            diskMb: rung.diskMb,
          },
          exact: true,
        };
  }
  if (sandboxShapeProblem(provider.shape, requestedSize) !== null) return null;
  const bounds = provider.shape;
  const requestedDisk = requestedSize.diskMb ?? bounds.diskDefaultMb;
  if (
    !Number.isSafeInteger(requestedDisk) ||
    requestedDisk < bounds.diskMinMb ||
    requestedDisk > bounds.diskMaxMb
  )
    return null;
  const diskMb =
    bounds.diskStepMb === undefined
      ? requestedDisk
      : Math.min(
          bounds.diskMaxMb,
          roundUpToStep(requestedDisk, bounds.diskStepMb, bounds.diskMinMb),
        );
  return {
    shape: { ...roundSandboxShape(bounds, requestedSize), diskMb },
    exact:
      bounds.diskStepMb !== undefined || requestedDisk === bounds.diskDefaultMb,
  };
}

/** The listed shape a provider defaults to, or `null` when it lists none. */
export function defaultShapeRung(
  provider: SandboxCatalogueProvider,
): SandboxShapeRung | null {
  return provider.shapes?.find((rung) => rung.default) ?? null;
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
  return {
    os,
    ...providerDefaultSize(provider),
    region: provider.regions[0].id,
    idleMinutes: STAGE_DEFAULT_IDLE_MINUTES,
    destroyAfterRestingMinutes: STAGE_DEFAULT_DESTROY_AFTER_RESTING_MINUTES,
  };
}

/**
 * A provider's default size: its default listed shape; of one that lists
 * none, 2 vCPU / 4 GB rounded into its bounds, or its smallest shape when
 * that one is outside them, on the provider's default disk.
 */
function providerDefaultSize(
  provider: SandboxCatalogueProvider,
): Pick<StageShape, "cpus" | "memoryMb" | "diskMb"> {
  const rung = defaultShapeRung(provider);
  if (rung !== null) {
    return { cpus: rung.cpus, memoryMb: rung.memoryMb, diskMb: rung.diskMb };
  }
  const bounds = provider.shape;
  const asked = roundSandboxShape(bounds, DEFAULT_SHAPE);
  if (sandboxShapeProblem(bounds, asked) === null) {
    return { ...asked, diskMb: null };
  }
  return {
    cpus: bounds.cpuMin,
    memoryMb: Math.max(
      bounds.memoryMinMb,
      bounds.cpuMin * bounds.memoryPerCpuMinMb,
    ),
    diskMb: null,
  };
}

/**
 * The shapes a configuration's defaults may name, Linux first: each OS's
 * provider's listed shapes, or its default size when it lists none, in its
 * default region.
 */
export function configurationShapeOptions(
  catalogue: SandboxCatalogue,
): readonly StageSize[] {
  return STAGE_OS_PREFERENCE.flatMap((os): StageSize[] => {
    const provider = stageProviderFor(catalogue, os);
    if (provider === null) return [];
    const region = provider.regions[0].id;
    if (provider.shapes === null) {
      return [{ os, region, ...providerDefaultSize(provider) }];
    }
    return provider.shapes.map((rung) => ({
      os,
      region,
      cpus: rung.cpus,
      memoryMb: rung.memoryMb,
      diskMb: rung.diskMb,
    }));
  });
}

/**
 * A configuration's defaults for a new sandbox, as its `sandbox_defaults`
 * item holds them: shared by everyone who creates there, edited on Settings ›
 * Sandboxes. `restingMinutes` `null` keeps a sandbox until it is destroyed.
 */
export interface SandboxConfigurationDefaults {
  readonly os: SandboxOs;
  readonly cpus: number;
  readonly memoryMb: number;
  readonly diskMb: number;
  readonly idleMinutes: number;
  readonly restingMinutes: number | null;
}

/**
 * What a configuration's New row stages when the person opens no gear: its
 * defaults' shape while the catalogue still offers it, in the provider's
 * default region, else `DEFAULT_SHAPE`; the defaults' periods
 * either way. With no defaults set, the built-in defaults. `null` when no provider can
 * create.
 */
export function configurationStageShape(
  catalogue: SandboxCatalogue,
  defaults: SandboxConfigurationDefaults | null,
): StageShape | null {
  const fallback = defaultStageShape(catalogue);
  if (defaults === null) return fallback;
  const periods = {
    idleMinutes: defaults.idleMinutes,
    destroyAfterRestingMinutes: defaults.restingMinutes,
  };
  const provider = stageProviderFor(catalogue, defaults.os);
  if (provider !== null && stageQuotedSize(provider, defaults) !== null) {
    return {
      os: defaults.os,
      cpus: defaults.cpus,
      memoryMb: defaults.memoryMb,
      diskMb: defaults.diskMb,
      region: provider.regions[0].id,
      ...periods,
    };
  }
  return fallback === null ? null : { ...fallback, ...periods };
}

/**
 * A staged shape as the configuration's defaults hold it, at the geometry
 * the provider allocates; `null` when the shape is no longer offered.
 */
export function stageShapeDefaults(
  catalogue: SandboxCatalogue,
  shape: StageShape,
): SandboxConfigurationDefaults | null {
  const provider = stageProviderForShape(catalogue, shape);
  if (provider === null) return null;
  const quoted = stageQuotedSize(provider, shape);
  if (quoted === null) return null;
  return {
    os: shape.os,
    ...quoted.shape,
    idleMinutes: shape.idleMinutes,
    restingMinutes: shape.destroyAfterRestingMinutes,
  };
}

/**
 * The shape a New row's gear opens on: the person's remembered pick while
 * the catalogue still offers it, else the configuration's. A region or OS
 * withdrawn since the pick falls back rather than staging a create the
 * server would refuse.
 */
export function rememberedOrConfigurationStageShape(
  catalogue: SandboxCatalogue,
  remembered: StageShape | null,
  defaults: SandboxConfigurationDefaults | null,
): StageShape | null {
  if (remembered !== null) {
    const provider = stageProviderFor(catalogue, remembered.os);
    if (
      provider !== null &&
      provider.regions.some((region) => region.id === remembered.region) &&
      stageQuotedSize(provider, remembered) !== null
    ) {
      return remembered;
    }
  }
  return configurationStageShape(catalogue, defaults);
}

/**
 * Exact shape prices take precedence over unit rates. Without either, the
 * served source quote is exact only for its own geometry and a lower bound
 * for a shape at least as large on every axis; a smaller disk is unpriced.
 */
export interface StagePrice {
  readonly awakeMcPerHour: number;
  readonly suspendedMcPerHour: number;
  readonly stoppedMcPerHour: number;
  readonly exact: boolean;
}

/**
 * A shape's hourly costs from the same rates and rounding the server bills.
 */
function ratedHourlyPrice(
  rates: SandboxCataloguePricing,
  quoted: QuotedStageSize,
): StagePrice {
  const size = quoted.shape;
  const memoryGib = size.memoryMb / MB_PER_GIB;
  const diskGib = size.diskMb / MB_PER_GIB;
  return {
    awakeMcPerHour: Math.ceil(
      (size.cpus * rates.vcpuHourMillicredits +
        memoryGib * rates.memoryGbHourMillicredits +
        diskGib * (rates.awakeDiskGbHourMillicredits ?? 0)) *
        rates.multiplier,
    ),
    suspendedMcPerHour: Math.ceil(
      (memoryGib *
        (rates.suspendedMemoryGbHourMillicredits ??
          rates.diskGbHourMillicredits) +
        diskGib * rates.diskGbHourMillicredits) *
        rates.multiplier,
    ),
    stoppedMcPerHour: Math.ceil(
      diskGib * rates.diskGbHourMillicredits * rates.multiplier,
    ),
    exact: quoted.exact,
  };
}

function exactShapePrice(
  region: SandboxCatalogueRegion,
  shape: StageGeometry,
): SandboxHourlyPrice | null {
  return (
    region.shapePrices?.find((entry) => sameGeometry(entry, shape))
      ?.priceMcPerHour ?? null
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

/** The geometry that produced the served from-price, matching the server's fromShape. */
function catalogueSourceGeometry(
  provider: SandboxCatalogueProvider,
): StageGeometry | null {
  if (provider.shapes !== null) return provider.shapes[0] ?? null;
  const bounds = provider.shape;
  return {
    cpus: bounds.cpuMin,
    memoryMb: Math.max(
      bounds.memoryMinMb,
      bounds.cpuMin * bounds.memoryPerCpuMinMb,
    ),
    diskMb: bounds.diskDefaultMb,
  };
}

function sameGeometry(left: StageGeometry, right: StageGeometry): boolean {
  return (
    left.cpus === right.cpus &&
    left.memoryMb === right.memoryMb &&
    left.diskMb === right.diskMb
  );
}

/** The true smallest offered shape's awake price; unknown when no served rates can price it. */
export function stageSmallestShape(
  catalogue: SandboxCatalogue,
  shape: StageSize,
): { readonly isStaged: boolean; readonly awakeMcPerHour: number } | null {
  const provider = stageProviderForShape(catalogue, shape);
  if (provider === null) return null;
  const region = provider.regions.find(
    (candidate) => candidate.id === shape.region,
  );
  const source = catalogueSourceGeometry(provider);
  if (region === undefined || source === null) return null;
  const smallest =
    provider.shapes === null
      ? { ...source, diskMb: provider.shape.diskMinMb }
      : smallestShapeRung(provider.shapes);
  if (smallest === null) return null;
  const minimum = stageQuotedSize(provider, smallest);
  const selected = stageQuotedSize(provider, shape);
  if (minimum === null || selected === null) return null;
  const exact = exactShapePrice(region, minimum.shape);
  if (
    exact === null &&
    region.pricing === null &&
    !sameGeometry(minimum.shape, source)
  )
    return null;
  return {
    isStaged: sameGeometry(selected.shape, minimum.shape),
    awakeMcPerHour:
      exact?.awakeMc ??
      (region.pricing === null
        ? region.fromPriceMcPerHour.awakeMc
        : ratedHourlyPrice(region.pricing, minimum).awakeMcPerHour),
  };
}

export function stagePrice(
  catalogue: SandboxCatalogue,
  shape: StageSize,
): StagePrice | null {
  const provider = stageProviderForShape(catalogue, shape);
  if (provider === null) return null;
  const region = provider.regions.find(
    (candidate) => candidate.id === shape.region,
  );
  const quoted = stageQuotedSize(provider, shape);
  if (region === undefined || quoted === null) return null;
  const exact = exactShapePrice(region, quoted.shape);
  if (exact !== null)
    return {
      awakeMcPerHour: exact.awakeMc,
      suspendedMcPerHour: exact.suspendedMc,
      stoppedMcPerHour: exact.stoppedMc,
      exact: quoted.exact,
    };
  if (region.pricing !== null) return ratedHourlyPrice(region.pricing, quoted);
  const source = catalogueSourceGeometry(provider);
  if (
    source === null ||
    quoted.shape.cpus < source.cpus ||
    quoted.shape.memoryMb < source.memoryMb ||
    quoted.shape.diskMb < source.diskMb
  )
    return null;
  return {
    awakeMcPerHour: region.fromPriceMcPerHour.awakeMc,
    suspendedMcPerHour: region.fromPriceMcPerHour.suspendedMc,
    stoppedMcPerHour: region.fromPriceMcPerHour.stoppedMc,
    exact: sameGeometry(quoted.shape, source),
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
  readonly os?: SandboxOs;
  readonly configuration: StageConfiguration;
  readonly price: StagePrice | null;
  readonly needsCredits: boolean;
  /** Ongoing billing stays visible even when the balance needs replenishing. */
  readonly billingStarted: boolean;
  readonly shortfallMc?: number | null;
  /** A team sandbox this action wakes, before the viewer takes over payment. */
  readonly wakingName?: string | null;
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
  | "move";

export interface ConsequenceClause {
  readonly kind: ConsequenceClauseKind;
  readonly text: string;
}

/** The price clause, never collapsed: a price is not a disclosure. */
export function priceClause(input: ConsequencesInput): ConsequenceClause {
  const copy = stageConfigurationCopy(input.configuration);
  if (input.needsCredits && !input.billingStarted) {
    return {
      kind: "price",
      text:
        copy.kind === "team"
          ? teamAllowanceShortLine(copy.teamName, input.shortfallMc ?? null)
          : notEnoughCreditsLine(input.shortfallMc ?? null),
    };
  }
  if (input.wakingName && copy.kind === "team") {
    return {
      kind: "price",
      text: `Waking ${input.wakingName} uses your ${copy.teamName} allowance and makes you the payer.`,
    };
  }
  if (input.price === null) {
    return { kind: "price", text: unpricedCostLine(copy) };
  }
  const line = costLine(input.price.awakeMcPerHour, copy);
  return { kind: "price", text: input.price.exact ? line : `from ${line}` };
}

/**
 * Every clause the block shows in full, in order: the price
 * always; the audience when the task has or may gain readers; the reach when
 * it holds a host of another configuration; shared use, payment, access and
 * resting storage on a team; the move clause on an unmoved computer.
 */
export function consequenceClauses(
  input: ConsequencesInput,
): readonly ConsequenceClause[] {
  const copy = stageConfigurationCopy(input.configuration);
  const price = priceClause(input);
  // Expanded team copy puts the payer beside shared use. The summary keeps
  // price and payer together when those consequences are collapsed.
  let priceText = price.text;
  if (
    copy.kind === "team" &&
    (!input.needsCredits || input.billingStarted) &&
    !input.wakingName
  ) {
    priceText =
      input.price === null
        ? "Billed by the hour while awake"
        : fundedRowPrice(input.price.awakeMcPerHour, input.price.exact);
  }
  const clauses: ConsequenceClause[] = [{ kind: "price", text: priceText }];
  if (input.audience === "shared") {
    clauses.push({ kind: "audience", text: audienceClause(copy) });
  }
  if (input.reachHost !== null) {
    clauses.push({ kind: "reach", text: reachSentence(input.reachHost) });
  }
  if (input.configuration.kind === "team") {
    clauses.push(
      {
        kind: "team",
        text: input.wakingName
          ? "Everyone in the team can use it; another member's agent can read what yours can."
          : TEAM_USE_AND_ACCESS_CLAUSE,
      },
      { kind: "resting-storage", text: restingStorageClause() },
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
