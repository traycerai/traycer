import type { HistoryScope } from "@/lib/history-scope";

let modalScope: HistoryScope = "all";
let promotionScope: HistoryScope = "all";

/** Registered only by the mounted modal; never persisted or read by loaders. */
export function registerHistoryModalScope(scope: HistoryScope): () => void {
  modalScope = scope;
  return () => {
    modalScope = "all";
  };
}

export function prepareHistoryScopeForPromotion(): void {
  promotionScope = modalScope;
}

export function consumeHistoryScopeForPromotion(): HistoryScope {
  const scope = promotionScope;
  promotionScope = "all";
  return scope;
}
