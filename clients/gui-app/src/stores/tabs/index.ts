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
  tabCommandCoordinator,
  getTabCommandLedger,
  getTabCommandCoordinatorDiagnostics,
  subscribeToTabCommandLedger,
} from "@/stores/tabs/tab-command-coordinator";
export {
  selectHeaderStripItemIds,
  selectHeaderMemberRefs,
  makeSelectHeaderItem,
  selectHostActiveItem,
  selectHostActiveSurfaceRefs,
  selectHostFocusedRef,
  selectHostRouteBackingRef,
  makeSelectChooserSide,
  makeSelectChooserIsFillable,
} from "@/stores/tabs/selectors";
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
  TabSurfaceCapabilities,
  TabSurfaceDescriptor,
} from "@/stores/tabs/types";
export type {
  PersistedTabStripLayout,
  SplitSide,
  SplitSideName,
  SplitStripItem,
  StripItem,
  TabStripItem,
} from "@/stores/tabs/layout";
export type {
  CreateDraftForSplitCommand,
  FillSplitSideCommand,
  ReplaceDraftWithEpicCommand,
  SeparateBeforeMoveResult,
  TabCommandCoordinatorDiagnostics,
  TabCommandLedger,
} from "@/stores/tabs/tab-command-coordinator";
