/** Docs: see ./README.md */
export { openNewEpic, openNewEpicIntent } from "./new-epic";
export { duplicateEpicTab } from "./duplicate-tab";
export {
  goBack,
  goForward,
  resolveEligibleHistoryTarget,
  type EligibleHistoryTarget,
  type HistoryNavRouter,
} from "./history-navigation";
export {
  openCreatedChatWhenProjected,
  openCreatedChatWhenProjectedWithNavigation,
  openNewChatInActiveTile,
  type CancelFn,
  type CreateChatCommandCallbacks,
  type CreateChatCommand,
  type CreatedChatOpenIntent,
  type OpenCreatedChatWhenProjectedWithNavigationArgs,
} from "./new-chat";
export {
  ensureHistoryTab,
  ensureSettingsTab,
  resolveHistoryTabIntent,
  resolveSettingsTabIntent,
  type OpenSettingsOpts,
} from "./open-system-tab";
export {
  openTileIntoTargetGroup,
  type OpenTileIntoTargetGroupArgs,
} from "./open-into-target";
