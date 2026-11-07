import type {
  ConfigAgentMemoriesResponse,
  ConfigAgentMemoriesSetResponse,
} from "@traycer/protocol/host/config/schemas";
import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";

export type AgentMemoryWriteProgress =
  | { readonly kind: "settled" }
  | { readonly kind: "queued" }
  | { readonly kind: "waiting" }
  | { readonly kind: "unconfirmed" }
  | { readonly kind: "failed" }
  | { readonly kind: "stale" }
  | { readonly kind: "refused" };

/** Absence is never acceptance; a saved write needs its own revision and value. */
export function agentMemoryWriteProgress(input: {
  readonly answer: ConfigAgentMemoriesSetResponse;
  readonly asked: boolean;
  readonly read: ConfigAgentMemoriesResponse;
  readonly queue: EnvironmentStatusResponseV11 | undefined;
}): AgentMemoryWriteProgress {
  const { answer, read } = input;
  if (
    read.environmentId !== null &&
    read.environmentId !== answer.environmentId
  ) {
    return { kind: "settled" };
  }
  if (answer.state === "queued") {
    const refused = input.queue?.pendingUploads.find(
      (entry) =>
        entry.uploadId === answer.uploadId && entry.receipt === "refused",
    );
    if (refused !== undefined) {
      return {
        kind: refused.code === "ENVIRONMENT_WRITE_STALE" ? "stale" : "refused",
      };
    }
    return { kind: "queued" };
  }
  if (answer.revision === null) return { kind: "unconfirmed" };
  if (
    read.environmentId === null ||
    read.revision === null ||
    read.revision < answer.revision
  ) {
    return { kind: "waiting" };
  }
  return { kind: read.enabled === input.asked ? "settled" : "unconfirmed" };
}
