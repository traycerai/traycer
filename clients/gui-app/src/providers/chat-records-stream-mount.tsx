import { useEffect, type ReactNode } from "react";
import {
  ChatRecordsStreamClient,
  type ChatRecordsStreamDelta,
} from "@traycer-clients/shared/host-transport/chat-records-stream-client";
import { acquireHostConnection } from "@traycer-clients/shared/host-client/host-connection-registry";
import { isReopenableHostStreamClose } from "@traycer-clients/shared/host-client/host-connection-reconnect-engine";
import {
  useStreamHostId,
  useStreamMethodSupport,
  useWsStreamClient,
} from "@/lib/host/stream-runtime-context";
import {
  getEpicSessionHandleHostId,
  getOpenEpicRegistry,
} from "@/lib/registries/epic-session-registry";

/** Host-scoped record-change push stream, mounted once per app. Peek, do not acquire; apply only to a session bound to this stream's host. Push is the trigger; the 20s poll is the backup. Terminal closes reopen on the host's reconnect lane. */
/**
 * Open this long before close resets reopen backoff even with no deltas.
 */
const HEALTHY_SESSION_RESET_MS = 30_000;

export function ChatRecordsStreamMount(): ReactNode {
  const wsStreamClient = useWsStreamClient();
  const support = useStreamMethodSupport("host.chatRecords.subscribe");
  // Rebuild key and reopen-lane identity must come off the same `StreamRuntimeBinding` as `wsStreamClient`.
  const hostId = useStreamHostId();

  useEffect(() => {
    if (
      wsStreamClient === null ||
      hostId === null ||
      support === "unsupported"
    ) {
      return;
    }
    // Narrowed capture: the guard above does not narrow `wsStreamClient` inside `openClient`.
    const streamClient = wsStreamClient;
    const applyDelta = (delta: ChatRecordsStreamDelta): void => {
      // Peek, not acquire: a record change must never construct an epic session or reorder the MRU.
      const handle = getOpenEpicRegistry().peek(delta.epicId);
      if (handle === null) return;
      // Gate on the session's host, not just its epic. Both record tables.
      if (getEpicSessionHandleHostId(handle) !== hostId) return;
      // One stream, two record tables: @1.1 terminal-agent kinds vs everything else.
      if (delta.kind === "tuiUpsert" || delta.kind === "tuiRemove") {
        handle.store.getState().applyTuiAgentRecordDelta(delta);
        return;
      }
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
            // A delivered delta is the usable-session proof for this stream (no initial state frame).
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
              // Quiet sessions never deliver a delta; a healthy-dwell open is enough to reset the lane.
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
