import { SpawnAcknowledgementTimeoutError } from "@traycer-clients/shared/host-start-adoption/spawn-acknowledgement-error";

// A leaf on purpose: the runner reads it at its one capture site, and must not
// pull the host's service and marker readers (`spawn-ack-evidence.ts`) in.

/**
 * The Sentry tags for a captured error: three closed-set keys for a
 * spawn-acknowledgement timeout that carries evidence, `null` for anything
 * else.
 */
export function spawnAckSentryTags(
  error: unknown,
): Record<string, string> | null {
  if (!(error instanceof SpawnAcknowledgementTimeoutError)) return null;
  const evidence = error.evidence;
  if (evidence === null) return null;
  return {
    spawn_ack_proof: evidence.proof,
    spawn_ack_supervisor: evidence.supervisor,
    spawn_ack_marker: evidence.marker,
  };
}
