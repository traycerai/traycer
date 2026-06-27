/**
 * Docs: see ./README.md
 *
 * Barrel for canonical palette action functions. Every command
 * source's `run` handler imports from here instead of reaching
 * into stores directly.
 */
export { openNewEpic, openNewEpicDraft } from "./new-epic";
export { duplicateEpicTab } from "./duplicate-tab";
export { goBack, goForward, type HistoryNavRouter } from "./history-navigation";
export {
  openCreatedChatWhenProjected,
  openNewChatInActiveTile,
  type CancelFn,
  type CreateChatCommandCallbacks,
  type CreateChatCommand,
  type CreatedChatOpenIntent,
  type NewChatSplitPosition,
} from "./new-chat";
export {
  ensureHistoryTab,
  ensureSettingsTab,
  type OpenSettingsOpts,
} from "./open-system-tab";
export {
  openTileIntoTargetGroup,
  type OpenTileIntoTargetGroupArgs,
} from "./open-into-target";
