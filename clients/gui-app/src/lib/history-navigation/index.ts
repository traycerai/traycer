/**
 * History-navigation core library — the pure logic layer behind in-app
 * back/forward navigation. No UI, no provider mounting, no keybinding wiring;
 * the input surfaces and the prune-lifecycle ticket consume these.
 *
 * The controller surface itself (`getHistoryController`,
 * `PersistentHistoryController`) lives in `@/lib/persistent-history` and is
 * re-exported here so dependents can import the whole feature from
 * `@/lib/history-navigation`.
 */
export {
  getHistoryController,
  type PersistentHistoryController,
} from "@/lib/persistent-history";

export { useHistoryNavAvailable } from "@/lib/history-navigation/use-history-nav-available";
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
