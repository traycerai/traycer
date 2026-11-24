import type { SandboxControlFailure } from "@traycer-clients/shared/host-client/sandbox-control";
import type {
  SandboxCreateRequest,
  SandboxSummary,
} from "@traycer/protocol/host/sandbox-control";
import { v5 as uuidv5 } from "uuid";

/** Matches the create endpoint's 1–64 character clientRequestId contract. */
export function sandboxCreateKey(
  intent: "retry" | "team-setup" | "stage",
  id: string,
): string {
  if (id.length === 0) throw new Error("Invalid sandbox create key length");
  const key = `${intent}:${id}`;
  if (key.length <= 64 && !id.startsWith("~")) return key;
  // Reserve "~" for compact keys so a literal ID cannot alias one.
  const name = `traycer:sandbox-create:${JSON.stringify(key)}`;
  return `${intent}:~${uuidv5(name, uuidv5.URL)}`;
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

export function sandboxRetryFromRow(
  sandboxId: string,
  row: SandboxSummary | null | undefined,
): SandboxCreateRequest | null {
  return row?.id === sandboxId &&
    (row.state === "failed" || row.state === "destroyed")
    ? sandboxRetryCreate(row)
    : null;
}

/** A named refusal can authorize a body only when it carries the row's full view. */
export function sandboxRetryAfterRefusal(
  failure: SandboxControlFailure,
): SandboxCreateRequest | null {
  return failure.kind === "refused" && failure.sandboxId !== undefined
    ? sandboxRetryFromRow(failure.sandboxId, failure.sandbox)
    : null;
}
