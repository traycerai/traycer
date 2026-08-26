import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { TerminalLifecycleStatus } from "@/stores/terminals/terminal-session-store";

export type TerminalConnectionOverlayState =
  "reconnecting" | "recovering" | "lost";

/**
 * Resolve which connection overlay (if any) a terminal/TUI tile should show from
 * its session status. `null` means connected/healthy - no overlay. A "lost"
 * session (recoverable - see `TerminalLifecycleStatus`) shows the
 * automatic-recovery spinner until recovery is exhausted, then the manual
 * Reconnect prompt ("reattachable", Architecture §8). "Reaped" is equally
 * terminal for the current handle, but not for the durable terminal identity:
 * the host may already have restored it, so it follows the same bounded
 * recovery path. A running session whose transport is mid-reconnect shows the
 * transient spinner. The initial "creating" window shows nothing (the tile's
 * own loading skeleton covers it).
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
