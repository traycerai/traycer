import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";

/**
 * Whether a surface should say it is re-syncing.
 *
 * TWO conditions, and the second is the whole point. A stream that is
 * `connecting` or `reconnecting` is not by itself worth saying anything about:
 * on a cold open the surface is showing a skeleton, which already says
 * "loading", and a second loading claim over it is noise. What earns the strip
 * is a surface that is showing REAL, POSSIBLY STALE CONTENT while its own
 * stream is off - the state that otherwise looks settled right up until a fresh
 * snapshot replaces it with no warning.
 *
 * `closed` is deliberately absent. The strip animates for as long as it is
 * mounted, so a terminal state must not reach it - a bar that spins forever
 * over a stream that will never return is a worse lie than no bar at all. Every
 * surface that mounts this already has its own account of a closed stream (the
 * Epic pill's `offline`, the chat composer's disabled state, the shell window's
 * error banner); this strip is about the recoverable window only.
 *
 * Exported separately from the component so a caller that needs the ANSWER
 * without rendering the strip can ask for it - the phone's tile bar suppresses
 * its own strip by asking whether the Epic's is already speaking.
 */
export function isStreamSyncing(
  status: StreamConnectionStatus,
  hasContent: boolean,
): boolean {
  return hasContent && (status === "connecting" || status === "reconnecting");
}

/**
 * The strip's word, escalated once the resync stops looking momentary.
 *
 * The two differ by a capital: "Task: Still syncing…" does not contain
 * "Syncing…", which is what lets a reader - and a test - tell them apart
 * without a second signal.
 */
export function streamSyncingLabel(escalated: boolean): string {
  return escalated ? "Still syncing…" : "Syncing…";
}
