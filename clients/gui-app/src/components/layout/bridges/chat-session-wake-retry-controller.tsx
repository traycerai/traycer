import { useEffect } from "react";
import { subscribeChatSessionWakeRetry } from "@/lib/chats/chat-session-wake-retry";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";

/** Mounted once at the app root outside `HostReadyGate` (it needs only the runner host + the module-global
 * registry). */
export function ChatSessionWakeRetryController() {
  const runnerHost = useRunnerHostOrNull();
  useEffect(() => {
    return subscribeChatSessionWakeRetry(runnerHost);
  }, [runnerHost]);
  return null;
}
