import { useEffect } from "react";
import { subscribeAppSuspendRelease } from "@/lib/registries/app-suspend-release";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";

/**
 * Releases hidden epics, warm chats and lingering terminals as the installed
 * mobile app is sent to the background (see `releaseForAppSuspend`). A no-op
 * everywhere else. Mounted once at the app root OUTSIDE `HostReadyGate`, next
 * to `ChatSessionWakeRetryController`, for the same reason: the sessions it
 * releases outlive the gate, so a background edge landing while the host is
 * unavailable must still be heard.
 */
export function AppSuspendReleaseController() {
  const runnerHost = useRunnerHostOrNull();
  useEffect(() => {
    return subscribeAppSuspendRelease(runnerHost);
  }, [runnerHost]);
  return null;
}
