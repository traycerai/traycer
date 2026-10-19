import {
  ENVIRONMENT_WRITE_STALE_CODE,
  type EnvironmentStaleWrite,
} from "@traycer/protocol/framework/environment-stale-write";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";

/**
 * A settings save that lost to a newer change. The host refuses it with
 * `ENVIRONMENT_WRITE_STALE` and says who changed the setting first; the page
 * re-reads (`useRereadOnStaleWrite`) and the person is told where the change
 * came from, so they can make theirs again on top of it.
 */
export function staleWriteOf(error: unknown): EnvironmentStaleWrite | null {
  return error instanceof HostRpcError ? staleWriteOfHostError(error) : null;
}

/**
 * Keyed on the code, as the envelope gates the detail: an error built
 * without the field (a test double, an older build) never reads as stale.
 */
export function staleWriteOfHostError(
  error: Pick<HostRpcError, "code" | "staleWrite">,
): EnvironmentStaleWrite | null {
  return error.code === ENVIRONMENT_WRITE_STALE_CODE ? error.staleWrite : null;
}

/**
 * The sentence for a stale save. A host's label is text the person typed, so
 * it is only ever rendered as text.
 */
export function staleWriteMessage(staleWrite: EnvironmentStaleWrite): string {
  const { changedBy } = staleWrite;
  if (changedBy.kind === "dashboard") {
    return "This setting was changed in the dashboard just now.";
  }
  return changedBy.hostLabel === null
    ? "This setting was changed on another host just now."
    : `This setting was changed on ${changedBy.hostLabel} just now.`;
}
