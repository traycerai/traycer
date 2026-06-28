import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";

const DEFAULT_GUI_HARNESS_ORDER: ReadonlyArray<GuiHarnessId> = [
  "codex",
  "claude",
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
];

const DEFAULT_PROVIDER_ORDER: ReadonlyArray<ProviderId> = [
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
];

const UNKNOWN_PROVIDER_RANK = Number.MAX_SAFE_INTEGER;

export function providerIdToGuiHarnessId(providerId: ProviderId): GuiHarnessId {
  switch (providerId) {
    case "claude-code":
      return "claude";
    case "codex":
      return "codex";
    case "opencode":
      return "opencode";
    case "cursor":
      return "cursor";
    case "traycer":
      return "traycer";
    case "grok":
      return "grok";
    case "qwen":
      return "qwen";
    case "kiro":
      return "kiro";
    case "droid":
      return "droid";
    case "kimi":
      return "kimi";
    case "copilot":
      return "copilot";
    case "kilocode":
      return "kilocode";
    case "openrouter":
      return "openrouter";
  }
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
    rankInOrder(DEFAULT_PROVIDER_ORDER, provider.providerId),
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
