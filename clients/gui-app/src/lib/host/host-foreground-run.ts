import type { HostLifecycleView } from "@traycer-clients/shared/platform/runner-host";

/**
 * Whether this machine's running host was started by a person in a terminal
 * (`traycer host start`) rather than by the service - main's
 * `applied.admittedAs`, pushed live with the rest of the lifecycle view.
 *
 * The mode does not govern that run, and the app leaves it alone: it never
 * stops, restarts or updates it (the CLI refuses a desktop-origin attempt
 * with `E_HOST_NOT_SERVICE_RUN`). So every control that would do one of those
 * is disabled with the reason, and every line that states what the mode does
 * says "started in a terminal" instead.
 *
 * `null` - no enforcing supervisor, or one from a CLI that predates the field
 * - says nothing either way, and is NOT a foreground run: those surfaces keep
 * their ordinary controls, and the CLI's refusal is the backstop.
 */
export function isForegroundHostRun(
  view: HostLifecycleView | undefined,
): boolean {
  return view !== undefined && view.applied.admittedAs === "foreground";
}
