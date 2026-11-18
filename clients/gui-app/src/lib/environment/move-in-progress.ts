import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";

const MOVE_STOPPED_REASONS: Readonly<Partial<Record<string, string>>> = {
  stalled: "it timed out",
  failed: "it couldn't finish",
};

/**
 * Why a move stopped, by `setup.state`: it ran out of time, or it failed.
 * `setup.state` is an open string, so a name an object inherits
 * (`constructor`) is no reason: that move is still under way.
 */
export function moveStoppedReason(state: string): string | null {
  return Object.hasOwn(MOVE_STOPPED_REASONS, state)
    ? (MOVE_STOPPED_REASONS[state] ?? null)
    : null;
}

/**
 * Where this computer's move into Personal stands, read from `setup` alone.
 *
 * `status.consent` says NOTHING about a move that is running, and reading it
 * that way inverts both answers. On the wire the consent is the migration
 * MARKER's, and the host writes that marker after the upload finishes
 * (`traycer-host/src/domain/environment/migration/migrator.ts`, step 5:
 * "the marker with its consent … after which the environment domain starts").
 * So a first move runs with `consent: null` from the accept to the last item,
 * while a computer that stopped sharing keeps the old marker's consent -
 * including its `acceptedAt` - for as long as it rests at `awaiting_consent`
 * waiting to be asked again.
 *
 * `setup.stage` and `setup.state` are open strings in the protocol, so both
 * predicates below are written as exclusions: a move is past the accept
 * unless it is still waiting for one, and it can still progress unless it has
 * stopped. A state neither of them names is treated as a move under way,
 * which is the reading that keeps a person informed rather than silent.
 */
export function moveIsPastTheAccept(
  status: EnvironmentStatusResponseV11,
): boolean {
  const setup = status.setup;
  return (
    setup !== null &&
    setup.stage === "moving_settings" &&
    setup.state !== "awaiting_consent"
  );
}

/** Accepted, and stalled or failed: it waits for its Retry. */
export function moveHasStopped(status: EnvironmentStatusResponseV11): boolean {
  const setup = status.setup;
  return (
    setup !== null &&
    moveIsPastTheAccept(status) &&
    moveStoppedReason(setup.state) !== null
  );
}

/** Waiting for the person's `Move to Personal`. */
export function moveAwaitsConsent(
  status: EnvironmentStatusResponseV11,
): boolean {
  const setup = status.setup;
  return (
    setup !== null &&
    setup.stage === "moving_settings" &&
    setup.state === "awaiting_consent"
  );
}

/** Accepted, and neither finished nor stopped: items are moving right now. */
export function moveIsRunning(status: EnvironmentStatusResponseV11): boolean {
  const setup = status.setup;
  if (setup === null) return false;
  return moveIsPastTheAccept(status) && moveStoppedReason(setup.state) === null;
}
