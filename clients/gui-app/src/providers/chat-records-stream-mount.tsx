import { useEffect, type ReactNode } from "react";
import {
  ChatRecordsStreamClient,
  type ChatRecordDelta,
} from "@traycer-clients/shared/host-transport/chat-records-stream-client";
import { acquireHostConnection } from "@traycer-clients/shared/host-client/host-connection-registry";
import { isReopenableHostStreamClose } from "@traycer-clients/shared/host-client/host-connection-reconnect-engine";
import {
  useStreamHostId,
  useStreamMethodSupport,
  useWsStreamClient,
} from "@/lib/host/stream-runtime-context";
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
/**
 * A session that stayed open at least this long before closing counts as
 * healthy, resetting the reopen lane's backoff even if it carried no deltas.
 * Mirrors the reconnect engine's rebuild-pacer healthy-lifetime constant.
 */
const HEALTHY_SESSION_RESET_MS = 30_000;

export function ChatRecordsStreamMount(): ReactNode {
  const wsStreamClient = useWsStreamClient();
  const support = useStreamMethodSupport("host.chatRecords.subscribe");
  // Both the rebuild key AND the identity `acquireHostConnection` below binds
  // the reopen lane to - so it MUST come off the same `StreamRuntimeBinding`
  // as `wsStreamClient`, not a separately-updating resolver
  // (`useAddressableHostId` reads `readiness.hostId`, which the runtime's own
  // doc warns can name a different machine during a swap). One binding, one
  // answer: the lane always belongs to the host the client is dialling.
  const hostId = useStreamHostId();

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
      let openedAtMs = 0;
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
            if (status === "open") {
              openedAtMs = Date.now();
              return;
            }
            if (status === "closed") {
              // Deltas are the only frame this stream carries, so a healthy
              // but QUIET session would otherwise never reset the lane and
              // the backoff would ratchet one-way across the client's
              // lifetime. A session that stayed open past the healthy-dwell
              // is evidence enough (same shape as the engine's rebuild
              // pacer's healthy-lifetime reset).
              if (
                openedAtMs !== 0 &&
                Date.now() - openedAtMs >= HEALTHY_SESSION_RESET_MS
              ) {
                reopenScheduler.resetBackoff();
              }
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
