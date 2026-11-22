import { useCallback, useSyncExternalStore } from "react";
import { useOpenEpicHandle } from "@/providers/use-open-epic-handle";
import { useEpicSessionHostId } from "@/hooks/epic/use-epic-session-host-id";
import {
  agentSubtreeDeleteBlockedReason,
  agentSubtreeDeleteTargets,
} from "@/lib/epics/agent-subtree-delete";
import { getChatSessionRegistry } from "@/lib/registries/chat-session-registry";
import { subscribeAgentActivity } from "@/stores/agent-activity-store";
import { subscribeRecordWriteRouting } from "@/lib/host/owner-gone-write-routing";

/** Subscribe only while the lazy delete dialog is reading these subtree members. */
export function useAgentSubtreeDeleteBlocker(
  ids: readonly string[],
): string | null {
  const handle = useOpenEpicHandle();
  const sessionHostId = useEpicSessionHostId();
  const subscribe = useCallback(
    (notify: () => void) => {
      if (ids.length === 0) return () => undefined;
      const registry = getChatSessionRegistry();
      let sessionStops: Array<() => void> = [];
      const bindSessions = () => {
        for (const stop of sessionStops) stop();
        sessionStops = [];
        for (const target of agentSubtreeDeleteTargets(
          handle.store.getState(),
          ids,
          sessionHostId,
        )) {
          if (target.kind !== "chat" || target.hostId === null) continue;
          const session = registry.peek(
            handle.epicId,
            target.id,
            target.hostId,
          );
          if (session !== null)
            sessionStops.push(session.store.subscribe(notify));
        }
      };
      const changed = () => {
        bindSessions();
        notify();
      };
      bindSessions();
      const unsubscribeStore = handle.store.subscribe(changed);
      const unsubscribeRegistry = registry.subscribe(changed);
      const unsubscribeActivity = subscribeAgentActivity(notify);
      const unsubscribeRouting = subscribeRecordWriteRouting(notify);
      return () => {
        unsubscribeStore();
        unsubscribeRegistry();
        unsubscribeActivity();
        unsubscribeRouting();
        for (const stop of sessionStops) stop();
      };
    },
    [handle, ids, sessionHostId],
  );
  return useSyncExternalStore(subscribe, () =>
    ids.length === 0
      ? null
      : agentSubtreeDeleteBlockedReason(
          handle.store.getState(),
          handle.epicId,
          ids,
          sessionHostId,
        ),
  );
}
