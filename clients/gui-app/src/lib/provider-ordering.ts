import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";

interface ProviderOrderEntry {
  readonly providerId: ProviderId;
  readonly guiHarnessId: GuiHarnessId;
}

const DEFAULT_PROVIDER_ORDER: ReadonlyArray<ProviderOrderEntry> = [
  { providerId: "codex", guiHarnessId: "codex" },
  { providerId: "claude-code", guiHarnessId: "claude" },
  { providerId: "opencode", guiHarnessId: "opencode" },
  { providerId: "traycer", guiHarnessId: "traycer" },
  { providerId: "openrouter", guiHarnessId: "openrouter" },
  { providerId: "droid", guiHarnessId: "droid" },
  { providerId: "cursor", guiHarnessId: "cursor" },
  { providerId: "copilot", guiHarnessId: "copilot" },
  { providerId: "grok", guiHarnessId: "grok" },
  { providerId: "kiro", guiHarnessId: "kiro" },
  { providerId: "kilocode", guiHarnessId: "kilocode" },
  { providerId: "kimi", guiHarnessId: "kimi" },
  { providerId: "qwen", guiHarnessId: "qwen" },
];

const DEFAULT_GUI_HARNESS_ORDER = DEFAULT_PROVIDER_ORDER.map(
  (entry) => entry.guiHarnessId,
);
const DEFAULT_PROVIDER_ID_ORDER = DEFAULT_PROVIDER_ORDER.map(
  (entry) => entry.providerId,
);
const GUI_HARNESS_BY_PROVIDER_ID = new Map(
  DEFAULT_PROVIDER_ORDER.map(providerOrderMapEntry),
);

const UNKNOWN_PROVIDER_RANK = Number.MAX_SAFE_INTEGER;

export function providerIdToGuiHarnessId(providerId: ProviderId): GuiHarnessId {
  const guiHarnessId = GUI_HARNESS_BY_PROVIDER_ID.get(providerId);
  if (guiHarnessId === undefined) {
    throw new Error(`Provider is missing GUI harness mapping: ${providerId}`);
  }
  return guiHarnessId;
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

function providerOrderMapEntry(
  entry: ProviderOrderEntry,
): readonly [ProviderId, GuiHarnessId] {
  return [entry.providerId, entry.guiHarnessId];
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
