export {
  activateReadingPositionAccount,
  clearReadingPositionTombstones,
  deactivateReadingPositionAccount,
  deleteReadingPositionsForContent,
  deleteReadingPositionsForEpic,
  deleteReadingPositionView,
  flushLiveReadingPositions,
  flushLiveReadingPositionViews,
  flushPendingReadingPositionWrites,
  preserveReadingPositionViewsForMove,
  readReadingPosition,
  readExactReadingPosition,
  registerReadingPositionCapture,
  resetReadingPositionServiceForTests,
  saveReadingPosition,
  saveReadingPositionContentFallback,
  subscribeReadingPosition,
  tombstoneReadingPositionContent,
  tombstoneReadingPositionEpic,
  tombstoneReadingPositionEpics,
} from "@/lib/reading-position/service";
export { readingPositionIdentityForTileInstance } from "@/lib/reading-position/identity";
export { readingPositionIdentityForChat } from "@/lib/reading-position/chat-identity";
export type {
  ReadingPositionAnchorValidator,
  ReadingPositionDurability,
  ReadingPositionIdentity,
  ReadingPositionSurfaceKind,
} from "@/lib/reading-position/types";
