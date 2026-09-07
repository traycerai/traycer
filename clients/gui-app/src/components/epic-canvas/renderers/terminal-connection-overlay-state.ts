import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { TerminalLifecycleStatus } from "@/stores/terminals/terminal-session-store";

export type TerminalConnectionOverlayState =
  | "reconnecting"
  | "recovering"
  | "lost";

/**
 * Resolve which connection overlay (if any) a terminal/TUI tile should show from its session status.
 * `null` means connected/healthy - no overlay.
 */
export function resolveTerminalOverlayState(input: {
  readonly status: TerminalLifecycleStatus;
  readonly connectionStatus: StreamConnectionStatus;
  readonly recoveryExhausted: boolean;
}): TerminalConnectionOverlayState | null {
  if (input.status === "lost" || input.status === "reaped") {
    return input.recoveryExhausted ? "lost" : "recovering";
  }
  if (input.status === "running" && input.connectionStatus !== "open") {
    return "reconnecting";
  }
  return null;
}
