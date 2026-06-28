import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";

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
} satisfies Readonly<Record<ProviderId, GuiHarnessId>>;

const DEFAULT_PROVIDER_ID_ORDER = Object.keys(GUI_HARNESS_BY_PROVIDER_ID);
const DEFAULT_GUI_HARNESS_ORDER = Object.values(GUI_HARNESS_BY_PROVIDER_ID);

const UNKNOWN_PROVIDER_RANK = Number.MAX_SAFE_INTEGER;

export function providerIdToGuiHarnessId(providerId: ProviderId): GuiHarnessId {
  return GUI_HARNESS_BY_PROVIDER_ID[providerId];
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
