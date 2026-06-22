/**
 * Generic tab strip store. Owns the canonical strip order across all
 * tab kinds (epic, draft, history, settings). Per-kind data lives in
 * the relevant source store; system tabs (history/settings) are
 * stored here as singletons.
 *
 * Renderers should consume `useHeaderTabs()` from `./use-header-tabs`
 * and look up per-kind behavior via the registry.
 *
 * Reconciliation install: owned by `WindowsBridgeProvider`. The
 * provider sets the hydration gate's ready-promise before triggering
 * `installTabsStoreReconciliation()` so async snapshot arrival cannot
 * scramble the persisted strip order on cold start.
 */

export { useTabsStore } from "@/stores/tabs/store";
export { useHeaderTabs, getHeaderTabs } from "@/stores/tabs/use-header-tabs";
export {
  TAB_KINDS,
  tabRequestClose,
  tabDuplicate,
  tabResolveIntent,
  tabRouteOptions,
  tabActivate,
} from "@/stores/tabs/registry";
export type { HeaderTabKind } from "@/stores/tabs/registry";
export type {
  HeaderTab,
  TabRef,
  SystemTab,
  TabIcon,
  TabKindDescriptor,
  TabKindModule,
} from "@/stores/tabs/types";
