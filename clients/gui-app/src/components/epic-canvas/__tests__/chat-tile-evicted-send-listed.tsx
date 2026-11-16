import { useState, type ReactNode } from "react";
import type {
  ChatRecordSummaryV12,
  ChatRecordSummaryV15,
} from "@traycer/protocol/host/epic/chat-records";
import { useOpenEpicHandle } from "@/providers/use-open-epic-handle";

/** The epic's chat list, which names this chat as one its host dropped. */
export function ListedEvicted(props: {
  readonly children: ReactNode;
  readonly chatId: string;
  readonly record: ChatRecordSummaryV12 &
    Pick<ChatRecordSummaryV15, "starterUserId">;
}): ReactNode {
  const handle = useOpenEpicHandle();
  const [listed] = useState(() => {
    const store = handle.store.getState();
    store.applyChatRecords([props.record], null);
    store.applyChatRecordEvictions([{ chatId: props.chatId, evicted: true }]);
    return true;
  });
  return listed ? props.children : null;
}
