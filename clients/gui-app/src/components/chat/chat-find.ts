// Barrel for the chat find surface. The implementation is split into focused
// modules so each has a single reason to change:
//   - chat-find-projection: transcript -> searchable rows/units + unit ids.
//   - chat-find-adapter: search state, match reconciliation, snapshot lifecycle.
//   - chat-find-highlighter: DOM/CSS Custom Highlight range painting + anchors.
// Consumers keep importing from "@/components/chat/chat-find".

export {
  buildChatFindRows,
  markdownToChatSearchText,
  chatFindMessageContentUnitId,
  chatFindSegmentUnitId,
  chatFindActivityGroupSummaryUnitId,
  chatFindActivityGroupChildHeaderUnitId,
  chatFindSubagentHeaderUnitId,
  chatFindSubagentBodyUnitId,
  chatFindA2ASendBodyUnitId,
  chatFindA2AReceivedBodyUnitId,
  type ChatFindRow,
  type ChatFindUnit,
} from "@/components/chat/chat-find-projection";

export {
  createChatFindAdapter,
  type ChatFindAdapter,
  type ChatFindReconcileTarget,
  type ChatFindRevealTarget,
} from "@/components/chat/chat-find-adapter";

export { queryMountedChatFindUnit } from "@/components/chat/chat-find-highlighter";
