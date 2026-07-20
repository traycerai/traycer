import type { GuiHarnessId } from "@traycer/protocol/host/index";
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderId,
} from "@traycer/protocol/host/provider-schemas";

export interface OrderedProvider {
  readonly providerId: ProviderId;
  readonly harnessId: GuiHarnessId;
}

const PROVIDER_ID_ORDER = [
  "codex",
  "claude-code",
  "opencode",
  "traycer",
  "openrouter",
  "droid",
  "cursor",
  "copilot",
  "grok",
  "kiro",
  "kilocode",
  "kimi",
  "qwen",
  "amp",
  "devin",
  "pi",
] as const satisfies ReadonlyArray<ProviderId>;

type MissingProviderIdFromOrder = Exclude<
  ProviderId,
  (typeof PROVIDER_ID_ORDER)[number]
>;

type ExhaustiveOrderedProviders = [MissingProviderIdFromOrder] extends [never]
  ? ReadonlyArray<OrderedProvider>
  : readonly [
      "Missing ProviderId in PROVIDER_ID_ORDER",
      MissingProviderIdFromOrder,
    ];

const GUI_HARNESS_BY_PROVIDER_ID = {
  codex: "codex",
  "claude-code": "claude",
  opencode: "opencode",
  traycer: "traycer",
  openrouter: "openrouter",
  droid: "droid",
  cursor: "cursor",
  copilot: "copilot",
  grok: "grok",
  kiro: "kiro",
  kilocode: "kilocode",
  kimi: "kimi",
  qwen: "qwen",
  amp: "amp",
  devin: "devin",
  pi: "pi",
} satisfies Readonly<Record<ProviderId, GuiHarnessId>>;

export const ORDERED_PROVIDERS: ExhaustiveOrderedProviders =
  PROVIDER_ID_ORDER.map((providerId) => ({
    providerId,
    harnessId: GUI_HARNESS_BY_PROVIDER_ID[providerId],
  }));

const DEFAULT_PROVIDER_ID_ORDER = PROVIDER_ID_ORDER;
const DEFAULT_GUI_HARNESS_ORDER = ORDERED_PROVIDERS.map(
  (provider) => provider.harnessId,
);

const UNKNOWN_PROVIDER_RANK = Number.MAX_SAFE_INTEGER;

export function providerIdToGuiHarnessId(providerId: ProviderId): GuiHarnessId {
  return GUI_HARNESS_BY_PROVIDER_ID[providerId];
}

/**
 * Total harness -> provider projection: every `GuiHarnessId` maps to its
 * `ProviderId` in `ORDERED_PROVIDERS`, `traycer` included. Use this for
 * surfaces that reason about a provider's usage/profile data regardless of
 * whether it has an external CLI login - e.g. the rate-limit profile picker
 * and the add-profile flow, both of which show Traycer Inference's own
 * profiles/usage even though it has no CLI to authenticate.
 *
 * For surfaces that gate on provider-CLI login specifically (reauth, seed
 * validation, cross-host clone continuity), use `providerCliIdForHarness`
 * instead - it excludes `traycer`, which has no provider-CLI concept at all.
 */
export function guiHarnessIdToProviderId(
  harnessId: GuiHarnessId,
): ProviderId | null {
  return (
    ORDERED_PROVIDERS.find((provider) => provider.harnessId === harnessId)
      ?.providerId ?? null
  );
}

/**
 * Harness ids with no provider-CLI login concept at all - kept as an
 * explicit, single-membership set (rather than a second hand-maintained
 * table) so adding a future CLI-less harness is a visible, deliberate edit
 * here instead of a silent divergence between two mappers. Currently only
 * `traycer` (Traycer's own inference, not an external CLI a user
 * authenticates).
 */
const HARNESS_IDS_WITHOUT_PROVIDER_CLI: ReadonlySet<GuiHarnessId> = new Set([
  "traycer",
]);

/**
 * Provider-CLI-scoped projection of `guiHarnessIdToProviderId`: identical
 * except it returns `null` for `HARNESS_IDS_WITHOUT_PROVIDER_CLI` members.
 * Use this for surfaces that gate on, seed, or migrate a provider-CLI login/
 * managed profile - the reauth gate, seeded-profile validation, cross-host
 * chat clone, and tombstoned-profile lookup all fall through to "nothing to
 * check" for a harness with no CLI login, rather than misreading
 * `guiHarnessIdToProviderId`'s `"traycer"` as a loggable-in provider.
 */
export function providerCliIdForHarness(
  harnessId: GuiHarnessId,
): ProviderId | null {
  if (HARNESS_IDS_WITHOUT_PROVIDER_CLI.has(harnessId)) return null;
  return guiHarnessIdToProviderId(harnessId);
}

export function providerDisplayName(providerId: ProviderId): string {
  if (providerId === "traycer") return "Traycer Inference";
  return PROVIDER_DISPLAY_NAMES[providerId];
}

export function sortGuiHarnessesByProviderOrder<
  T extends { readonly id: GuiHarnessId },
>(harnesses: ReadonlyArray<T>): ReadonlyArray<T> {
  return stableSortByRank(harnesses, (harness) =>
    rankInOrder(DEFAULT_GUI_HARNESS_ORDER, harness.id),
  );
}

export function sortProviderStatesByProviderOrder<
  T extends { readonly providerId: ProviderId },
>(providers: ReadonlyArray<T>): ReadonlyArray<T> {
  return stableSortByRank(providers, (provider) =>
    rankInOrder(DEFAULT_PROVIDER_ID_ORDER, provider.providerId),
  );
}

function rankInOrder<T extends string>(
  order: ReadonlyArray<T>,
  value: T,
): number {
  const index = order.indexOf(value);
  return index === -1 ? UNKNOWN_PROVIDER_RANK : index;
}

function stableSortByRank<T>(
  items: ReadonlyArray<T>,
  rank: (item: T) => number,
): ReadonlyArray<T> {
  return items
    .map((item, index) => ({ item, index, rank: rank(item) }))
    .toSorted((left, right) => {
      if (left.rank !== right.rank) return left.rank - right.rank;
      return left.index - right.index;
    })
    .map((entry) => entry.item);
}
