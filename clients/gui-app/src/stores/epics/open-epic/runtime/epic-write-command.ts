import type { CommandSendFailure } from "@traycer-clients/shared/replica-runtime";
import {
  HostRpcError,
  HostTransportFailureError,
  RetryableTransportError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { StaleHostBindingAuthorityError } from "@traycer-clients/shared/host-client/host-binding-authority-registry";
import type { TicketStatus } from "@traycer/protocol/common/registry";

export type EpicWriteCommandIntent =
  | {
      readonly kind: "rename-artifact";
      readonly artifactId: string;
      readonly title: string;
    }
  | {
      readonly kind: "delete-artifact";
      readonly artifactId: string;
    }
  | {
      readonly kind: "reparent-artifact";
      readonly artifactId: string;
      readonly parentId: string | null;
    }
  | {
      readonly kind: "update-artifact-status";
      readonly artifactId: string;
      readonly artifactType: "ticket" | "story";
      readonly status: TicketStatus;
    }
  | {
      readonly kind: "update-epic-title";
      readonly title: string;
      readonly updatedAt: number;
    };

export interface EpicWriteCommandSender {
  currentHostId(): string | null;
  send(
    commandId: string,
    intent: EpicWriteCommandIntent,
  ): Promise<{ readonly hostId: string }>;
}

export class EpicWriteCommandTransportUnavailableError extends Error {
  constructor() {
    super("No host requester is attached to this epic session");
    this.name = "EpicWriteCommandTransportUnavailableError";
  }
}

export function classifyEpicWriteCommandFailure(
  error: unknown,
): CommandSendFailure {
  if (
    error instanceof RetryableTransportError ||
    error instanceof StaleHostBindingAuthorityError ||
    error instanceof EpicWriteCommandTransportUnavailableError
  ) {
    return {
      kind: "queued",
      reason: error instanceof Error ? error.message : String(error),
      boundedRetry: error instanceof RetryableTransportError,
    };
  }
  if (error instanceof HostTransportFailureError) {
    return { kind: "unknown-outcome", reason: error.message };
  }
  if (error instanceof HostRpcError) {
    if (error.code === "E_IDEMPOTENCY_CACHE_SATURATED") {
      // The host emitted this only before resolver dispatch. Keep the command
      // queued with its stable key: a later reconnect drain is safe and may
      // succeed once replay capacity returns.
      return { kind: "queued", reason: error.message, boundedRetry: true };
    }
    if (error.code === "E_IDEMPOTENCY_OUTCOME_UNKNOWN") {
      // The host retained the key but could not prove the original resolver's
      // result by its in-flight ceiling. Never auto-retry an ambiguous write;
      // the overlay's authoritative echo/TTL path owns reconciliation.
      return { kind: "unknown-outcome", reason: error.message };
    }
    return {
      kind: "rejected",
      resolution: {
        kind: "rejected",
        code: error.code,
        reason: error.message,
        retryable: false,
      },
    };
  }
  return {
    kind: "rejected",
    resolution: {
      kind: "rejected",
      code: "RPC_ERROR",
      reason: error instanceof Error ? error.message : String(error),
      retryable: false,
    },
  };
}
