import { useEffect, type ReactNode } from "react";
import {
  ChatRecordsStreamClient,
  type ChatRecordsStreamDelta,
} from "@traycer-clients/shared/host-transport/chat-records-stream-client";
import {
  useStreamMethodSupport,
  useWsStreamClient,
} from "@/lib/host/stream-runtime-context";
import { useAddressableHostId } from "@/hooks/host/use-addressable-host-id";
import {
  getEpicSessionHandleHostId,
  getOpenEpicRegistry,
} from "@/lib/registries/epic-session-registry";

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
 *
 * ## A delta is applied only to a session bound to THIS stream's host
 *
 * `epicId` alone does not identify a destination. An epic session is pinned to
 * the host it was established on and survives an app-wide host change - a
 * re-point in flight, or a tab reopened on its original host - so the registry
 * can hold a session on host A while this subscription is dialling host B.
 * Routing by `epicId` alone would then apply B's rows to A's store: a record
 * that does not exist on A's plane would render in A's session, and every
 * affordance on it would address the wrong host. The session-scoped record
 * hooks (`use-epic-chat-records.ts`, `use-epic-tui-agent-records.ts`) already
 * read through `useEpicSessionHostClient` for exactly this reason; the stamp
 * comparison is how a host-scoped subscription reaches the same answer.
 *
 * A skipped delta costs latency only - the session's own 20s list read against
 * its own host is the backup for every dropped frame, as above.
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
    const applyDelta = (delta: ChatRecordsStreamDelta): void => {
      // Peek, not acquire, for every delta kind - a record change must never
      // construct an epic session or reorder the MRU (see the doc above).
      const handle = getOpenEpicRegistry().peek(delta.epicId);
      if (handle === null) return;
      // The session's host, not just its epic - see the doc above. Both
      // record tables are gated, not only the terminal-agent one: a chat row
      // from the wrong host is the same contamination with the same
      // consequences.
      if (getEpicSessionHandleHostId(handle) !== hostId) return;
      // One stream, two record tables: the @1.1 terminal-agent kinds go to
      // the terminal-agent reducer, everything else to the chat reducer.
      if (delta.kind === "tuiUpsert" || delta.kind === "tuiRemove") {
        handle.store.getState().applyTuiAgentRecordDelta(delta);
        return;
      }
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
