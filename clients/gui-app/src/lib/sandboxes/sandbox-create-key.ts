import type { SandboxControlFailure } from "@traycer-clients/shared/host-client/sandbox-control";
import type {
  SandboxCreateRequest,
  SandboxSummary,
} from "@traycer/protocol/host/sandbox-control";

/** Matches the create endpoint's 1–64 character clientRequestId contract. */
export function sandboxCreateKey(
  intent: "retry" | "team-setup" | "stage",
  id: string,
): string {
  const key = `${intent}:${id}`;
  if (id.length === 0 || key.length > 64) {
    throw new Error("Invalid sandbox create key length");
  }
  return key;
}

/** Derives a press's key from the failure it answers or repeats its refused send. */
export function sandboxCreateKeyForPress(
  baseKey: string,
  failedSandboxId: string | null,
  lastAttemptedKey: string | null,
): string {
  return failedSandboxId === null
    ? (lastAttemptedKey ?? baseKey)
    : sandboxCreateKey("retry", failedSandboxId);
}
/** All surfaces retry the same row with the same placement and shape. */
export function sandboxRetryCreate(row: SandboxSummary): SandboxCreateRequest {
  return {
    os: row.os,
    cpus: row.cpus,
    memoryMb: row.memoryMb,
    diskMb: row.diskMb,
    region: row.region,
    displayName: row.displayName,
    idleMinutes: row.idleMinutes,
    burst: false,
    createdByHostId: null,
    createdByAgentId: null,
    environmentId: row.environmentId,
    destroyAfterRestingMinutes: row.destroyAfterRestingMinutes ?? 0,
    createdByTaskId: row.createdByTaskId,
    clientRequestId: sandboxCreateKey("retry", row.id),
  };
}

/** A 402 may name its row without carrying the row's full view. */
export function sandboxRetryAfterRefusal(
  failure: SandboxControlFailure,
  attempted: SandboxCreateRequest,
): SandboxCreateRequest | null {
  if (failure.kind !== "refused" || failure.sandboxId === undefined)
    return null;
  return failure.sandbox === undefined
    ? {
        ...attempted,
        clientRequestId: sandboxCreateKey("retry", failure.sandboxId),
      }
    : sandboxRetryCreate(failure.sandbox);
}
