import type {
  HostControllerStatus,
  HostEnsureFailure,
} from "@traycer-clients/shared/platform/runner-host";

/**
 * The last failed ensure - its own message and the CLI's code - for a SETTLED
 * failure surface, or `null`.
 *
 * Read from main's `HostControllerStatus.lastEnsureFailure` rather than from
 * the renderer's converge error, because most ensures are not the renderer's:
 * the launch ensure and its retry ladder run in main, and before this field
 * their failure reached no window at all - a Task Scheduler task disabled by
 * hand left "Starting Traycer…" on screen with nothing saying why. Main owns
 * the field's lifetime (set by every failed ensure, cleared by the next ok one
 * or once the host is reachable), so it cannot outlive the failure the way
 * `provisioningError` does.
 *
 * Shown verbatim whatever the code: the CLI's messages are written for the
 * person reading them, and the gate card already showed a Retry's message
 * verbatim.
 *
 * `null` while an ensure is in flight - the controller's mutation lane or this
 * renderer's own converge - so a failure is never shown under an attempt that
 * may yet succeed.
 */
export function settledEnsureFailure(
  status: HostControllerStatus | undefined,
  convergePending: boolean,
): HostEnsureFailure | null {
  if (status === undefined || convergePending || status.mutation !== null) {
    return null;
  }
  return status.lastEnsureFailure;
}
