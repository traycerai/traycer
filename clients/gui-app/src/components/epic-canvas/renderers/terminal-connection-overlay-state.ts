import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { TerminalLifecycleStatus } from "@/stores/terminals/terminal-session-store";

export type TerminalConnectionOverlayState =
  "reconnecting" | "recovering" | "lost";

/**
 * Resolve which connection overlay (if any) a terminal/TUI tile should show from
 * its session status. `null` means connected/healthy - no overlay. A "lost"
 * session shows the automatic-recovery spinner until recovery is exhausted, then
 * the manual Reconnect prompt; a running session whose transport is mid-reconnect
 * shows the transient spinner. The initial "creating" window shows nothing (the
 * tile's own loading skeleton covers it).
 */
export function resolveTerminalOverlayState(input: {
  readonly status: TerminalLifecycleStatus;
  readonly connectionStatus: StreamConnectionStatus;
  readonly recoveryExhausted: boolean;
}): TerminalConnectionOverlayState | null {
  if (input.status === "lost") {
    return input.recoveryExhausted ? "lost" : "recovering";
  }
  if (input.status === "running" && input.connectionStatus !== "open") {
    return "reconnecting";
  }
  return null;
}
