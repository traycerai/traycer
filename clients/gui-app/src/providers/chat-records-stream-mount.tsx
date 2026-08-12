import { useEffect, type ReactNode } from "react";
import {
  ChatRecordsStreamClient,
  type ChatRecordDelta,
} from "@traycer-clients/shared/host-transport/chat-records-stream-client";
import {
  useStreamMethodSupport,
  useWsStreamClient,
} from "@/lib/host/stream-runtime-context";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";

/**
 * The record-change PUSH stream, mounted once per app.
 *
 * ## Host-scoped, not per-tab
 *
 * `host.chatRecords.subscribe` is one subscription for every epic the host has
 * open PLUS its own-row changes, which exist outside any epic's lifetime (the
 * outbox drains whether or not the epic it belongs to is open). So the mount
 * sits beside `WorktreeChangedStreamMount` at app scope and frames name their
 * epic; routing them to the right open-epic session is this component's whole
 * job. A per-tab mount would open a socket per tab to say the same things and
 * would still miss the own-row deltas.
 *
 * ## Push is the trigger; the poll is the backup
 *
 * `useEpicSyncChatRecords`'s 20s `epic.listChatRecords` poll stays armed and
 * unchanged. This only removes latency: a host that predates the method never
 * advertises it, `useStreamMethodSupport` resolves `"unsupported"`, no client
 * is constructed, and the record table refreshes exactly as it did before. The
 * same arm covers a reconnect gap - deltas missed while the socket was down are
 * repaired by the next poll rather than by a replay no host retains a log for.
 *
 * ## A delta for an epic with no live session is DROPPED, deliberately
 *
 * The registry is peeked, not acquired: constructing an epic session because a
 * record changed would open a Y.Doc replica and a stream for an epic nobody is
 * looking at. A closed epic re-reads the whole list when it next opens, so the
 * only thing dropping costs is freshness for a surface that is not on screen.
 * `peek` rather than `get` so a background delta cannot reorder the MRU and
 * evict the epic the user is actually in.
 */
export function ChatRecordsStreamMount(): ReactNode {
  const wsStreamClient = useWsStreamClient();
  const support = useStreamMethodSupport("host.chatRecords.subscribe");
  // Not read by the effect body - it is the REBUILD key. The stream is bound to
  // whichever host the app-wide client is dialling, and the open-epic sessions
  // it feeds are rebuilt on a host change too (`EpicSessionProvider`'s session
  // key), so the subscription has to be torn down and reopened with them rather
  // than keep pushing a previous host's rows into fresh stores.
  const hostId = useReactiveActiveHostId();

  useEffect(() => {
    if (
      wsStreamClient === null ||
      hostId === null ||
      support === "unsupported"
    ) {
      return;
    }
    const applyDelta = (delta: ChatRecordDelta): void => {
      const handle = getOpenEpicRegistry().peek(delta.epicId);
      if (handle === null) return;
      handle.store.getState().applyChatRecordDelta(delta);
    };
    const stream = new ChatRecordsStreamClient({
      wsStreamClient,
      callbacks: {
        onDelta: applyDelta,
        onConnectionStatus: () => undefined,
      },
    });
    return () => {
      stream.close();
    };
  }, [hostId, support, wsStreamClient]);

  return null;
}
