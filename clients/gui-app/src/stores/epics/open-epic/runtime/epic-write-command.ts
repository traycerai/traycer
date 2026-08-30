import type { CommandSendFailure } from "@traycer-clients/shared/replica-runtime";
import {
  HostRpcError,
  HostTransportFailureError,
  RetryableTransportError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { StaleHostBindingAuthorityError } from "@traycer-clients/shared/host-client/host-binding-authority-error";
import {
  commonRecordRegistry,
  type TicketStatus,
} from "@traycer/protocol/common/registry";
import { getRecordSchema } from "@traycer/protocol/framework/versioned-record";

/** The registry's own vocabulary, never a copy of it. */
const ticketStatusSchema = getRecordSchema(
  commonRecordRegistry,
  "ticket-status",
  "latest",
);

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

/**
 * The intent's wire form, narrowed.
 *
 * It crosses `command/enqueue` as `unknown` for the same reason
 * `main/write-command`'s does - it is the caller's clonable form and the
 * worker carries it opaquely - but the QUEUE is typed, so one side has to
 * narrow. Here, beside the union, so a member added above is one arm away from
 * the parser that has to accept it.
 *
 * `status` is validated with the REGISTRY's own schema rather than a list of
 * literals copied out of it: `TicketStatus` is registry-derived, and a copied
 * vocabulary rots against the registry the moment a status is added - silently,
 * by refusing a status the rest of the app accepts.
 *
 * Unrecognised payloads answer `null`, and the caller turns that into a
 * REFUSAL rather than an error. Enqueuing a malformed intent would mint an id
 * for a command that can never be dispatched, which is the never-settles hang.
 */
export function readWriteCommandIntent(
  value: unknown,
): EpicWriteCommandIntent | null {
  if (typeof value !== "object" || value === null) return null;
  const kind: unknown = Reflect.get(value, "kind");
  const artifactId: unknown = Reflect.get(value, "artifactId");
  const title: unknown = Reflect.get(value, "title");
  switch (kind) {
    case "rename-artifact":
      return typeof artifactId === "string" && typeof title === "string"
        ? { kind, artifactId, title }
        : null;
    case "delete-artifact":
      return typeof artifactId === "string" ? { kind, artifactId } : null;
    case "reparent-artifact": {
      const parentId: unknown = Reflect.get(value, "parentId");
      if (typeof artifactId !== "string") return null;
      if (parentId !== null && typeof parentId !== "string") return null;
      return { kind, artifactId, parentId };
    }
    case "update-artifact-status": {
      const artifactType: unknown = Reflect.get(value, "artifactType");
      const status = ticketStatusSchema.safeParse(Reflect.get(value, "status"));
      if (typeof artifactId !== "string" || !status.success) return null;
      if (artifactType !== "ticket" && artifactType !== "story") return null;
      return { kind, artifactId, artifactType, status: status.data };
    }
    case "update-epic-title": {
      const updatedAt: unknown = Reflect.get(value, "updatedAt");
      return typeof title === "string" && typeof updatedAt === "number"
        ? { kind, title, updatedAt }
        : null;
    }
    default:
      return null;
  }
}

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

/**
 * A failure that was already classified, on the other side of the bridge.
 *
 * `Error` does not survive structured clone, so a write command sent from the
 * worker is dispatched by MAIN, which owns the requester and therefore owns
 * the classification. What comes back is the classifier's own union - never a
 * thrown object the worker would have to reconstruct - and the queue's contract
 * is `classifyFailure(error)`, so the union has to be carried back INTO a throw
 * to reach it. This is that carrier, and the first branch below is where it
 * comes out again.
 *
 * The alternative was widening `CommandQueueOptions` to accept a pre-classified
 * failure, which would change a SHARED contract for one caller's transport.
 */
export class RelayedWriteCommandFailureError extends Error {
  readonly failure: CommandSendFailure;

  constructor(failure: CommandSendFailure) {
    super(`Write command failed on the main thread: ${failure.kind}`);
    this.name = "RelayedWriteCommandFailureError";
    this.failure = failure;
  }
}

export function classifyEpicWriteCommandFailure(
  error: unknown,
): CommandSendFailure {
  // First, and it must stay first: this failure has already been through this
  // function on the other thread. Re-classifying it would reduce a precise
  // `rejected` with its host code to the catch-all `RPC_ERROR` below.
  if (error instanceof RelayedWriteCommandFailureError) return error.failure;
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
      // succeed once replay capacity returns. Because the host proved it did
      // not run, this refusal must never arm the ambiguous-send deadline.
      return { kind: "queued", reason: error.message, boundedRetry: false };
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
