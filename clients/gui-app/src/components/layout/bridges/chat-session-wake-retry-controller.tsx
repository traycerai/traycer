import { useEffect } from "react";
import { subscribeChatSessionWakeRetry } from "@/lib/chats/chat-session-wake-retry";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";

/**
 * Revives terminally-closed warm chat sessions on OS wake. The durable
 * transport already force-reconnects every LIVE session on the wake pulse, but
 * a session whose stream went terminal (`connectionStatus === "closed"`) has
 * no timer left and no retry affordance while its snapshot is on screen - its
 * composer / next-steps / approvals stayed dead until an app relaunch. This
 * bridge gives each such session one fresh dial per wake. Mounted once at the
 * app root OUTSIDE `HostReadyGate` (it needs only the runner host + the
 * module-global registry): warm sessions outlive the gate, so the listener
 * must too, or a wake landing during a host-unavailable window is silently
 * missed and never replayed.
 */
export function ChatSessionWakeRetryController() {
  const runnerHost = useRunnerHostOrNull();
  useEffect(() => {
    return subscribeChatSessionWakeRetry(runnerHost);
  }, [runnerHost]);
  return null;
}
