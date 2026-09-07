/**
 * History-navigation core library - the pure logic layer behind in-app back/forward navigation.
 * No UI, no provider mounting, no keybinding wiring; the input surfaces and the prune-lifecycle ticket consume these.
 */
export {
  getHistoryController,
  type PersistentHistoryController,
} from "@/lib/persistent-history";

export {
  historyNavChromeAvailable,
  useHistoryNavAvailable,
} from "@/lib/history-navigation/use-history-nav-available";
export {
  useHistoryNavState,
  type HistoryNavState,
} from "@/lib/history-navigation/use-history-nav-state";
export {
  isHistoryEntryDead,
  parseEpicTabHref,
  type ParsedEpicTabHref,
} from "@/lib/history-navigation/liveness";
export {
  isHistoryEntryEligible,
  findEligibleOffset,
  type HistoryEligibilityState,
} from "@/lib/history-navigation/eligibility";
export {
  installPruneScheduler,
  type PruneSchedulerOptions,
} from "@/lib/history-navigation/prune-scheduler";
