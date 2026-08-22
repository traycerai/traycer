import { useEffect, type ReactNode } from "react";
import {
  ChatRecordsStreamClient,
  type ChatRecordDelta,
} from "@traycer-clients/shared/host-transport/chat-records-stream-client";
import { acquireHostConnection } from "@traycer-clients/shared/host-client/host-connection-registry";
import { isReopenableHostStreamClose } from "@traycer-clients/shared/host-client/host-connection-reconnect-engine";
import {
  useStreamMethodSupport,
  useWsStreamClient,
} from "@/lib/host/stream-runtime-context";
import { useAddressableHostId } from "@/hooks/host/use-addressable-host-id";
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
 * ## Terminal closes reopen on the host's lane
 *
 * The transport's bounded UNAUTHORIZED give-up (and any other terminal close)
 * disposes the session, and a disposed session ignores `requestReconnect` and
 * wake-time `forceReconnect` alike. This mount used to swallow connection
 * status entirely, so one terminal close left the push plane dead until
 * reload - new agents stopped appearing in the canvas until the 20s poll's
 * next success, and not at all while the poll was failing too. A reopen lane
 * on the host's shared reconnect engine rebuilds the client on the same
 * backoff every notification-family stream uses.
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
  const hostId = useAddressableHostId();

  useEffect(() => {
    if (
      wsStreamClient === null ||
      hostId === null ||
      support === "unsupported"
    ) {
      return;
    }
    // Narrowed capture: the guard above does not narrow `wsStreamClient`
    // inside the nested `openClient` function declaration.
    const streamClient = wsStreamClient;
    const applyDelta = (delta: ChatRecordDelta): void => {
      const handle = getOpenEpicRegistry().peek(delta.epicId);
      if (handle === null) return;
      handle.store.getState().applyChatRecordDelta(delta);
    };
    const hostConnection = acquireHostConnection(hostId);
    let disposed = false;
    let currentClient: ChatRecordsStreamClient | null = null;
    const reopenScheduler = hostConnection.reconnect.openReopenLane(() => {
      const client = currentClient;
      currentClient = null;
      client?.close();
      openClient();
    }, isReopenableHostStreamClose);

    function openClient(): void {
      if (disposed) return;
      let client: ChatRecordsStreamClient | null = null;
      client = new ChatRecordsStreamClient({
        wsStreamClient: streamClient,
        callbacks: {
          onDelta: (delta) => {
            if (currentClient !== client) return;
            // A delivered delta is the usable-session proof for this stream
            // (it has no initial state frame to reset on).
            reopenScheduler.resetBackoff();
            applyDelta(delta);
          },
          onConnectionStatus: (status, reason) => {
            if (currentClient !== client) return;
            if (status === "closed") {
              reopenScheduler.scheduleAfterClose(reason);
            }
          },
        },
      });
      currentClient = client;
    }

    openClient();
    return () => {
      disposed = true;
      reopenScheduler.dispose();
      const client = currentClient;
      currentClient = null;
      client?.close();
      hostConnection.release();
    };
  }, [hostId, support, wsStreamClient]);

  return null;
}
