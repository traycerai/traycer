import type { CommandSendFailure } from "@traycer-clients/shared/replica-runtime";

/**
 * First re-drive delay for a host that refused a write because its idempotency cache was full,
 * doubled per attempt by the queue and clamped by `COMMAND_SELF_RETRY_MAX_DELAY_MS`.
 */
const COMMAND_SATURATION_RETRY_BASE_MS = 2_000;

/**
 * First re-drive delay for a write whose unary dial kept failing while this epic's lanes stayed
 * up, doubled per attempt by the queue on the same clamp.
 */
const COMMAND_DIAL_RETRY_BASE_MS = 2_000;
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

/** The intent's wire form, narrowed. */
/** The ARTIFACT-shaped intents: every one keyed by an `artifactId`. */
function readArtifactIntent(
  value: object,
  kind: string,
): EpicWriteCommandIntent | null {
  const artifactId: unknown = Reflect.get(value, "artifactId");
  if (typeof artifactId !== "string") return null;
  const title: unknown = Reflect.get(value, "title");
  switch (kind) {
    case "rename-artifact":
      return typeof title === "string"
        ? { kind: "rename-artifact", artifactId, title }
        : null;
    case "delete-artifact":
      return { kind: "delete-artifact", artifactId };
    case "reparent-artifact": {
      const parentId: unknown = Reflect.get(value, "parentId");
      if (parentId !== null && typeof parentId !== "string") return null;
      return { kind: "reparent-artifact", artifactId, parentId };
    }
    case "update-artifact-status": {
      const artifactType: unknown = Reflect.get(value, "artifactType");
      const status = ticketStatusSchema.safeParse(Reflect.get(value, "status"));
      if (!status.success) return null;
      if (artifactType !== "ticket" && artifactType !== "story") return null;
      return {
        kind: "update-artifact-status",
        artifactId,
        artifactType,
        status: status.data,
      };
    }
    default:
      return null;
  }
}

export function readWriteCommandIntent(
  value: unknown,
): EpicWriteCommandIntent | null {
  if (typeof value !== "object" || value === null) return null;
  const kind: unknown = Reflect.get(value, "kind");
  if (typeof kind !== "string") return null;
  if (kind === "update-epic-title") {
    const title: unknown = Reflect.get(value, "title");
    const updatedAt: unknown = Reflect.get(value, "updatedAt");
    return typeof title === "string" && typeof updatedAt === "number"
      ? { kind, title, updatedAt }
      : null;
  }
  return readArtifactIntent(value, kind);
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

/** A failure that was already classified, on the other side of the bridge. */
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
  // First, and it must stay first: this failure has already been through this function on the other
  // thread.
  if (error instanceof RelayedWriteCommandFailureError) return error.failure;
  if (
    error instanceof RetryableTransportError ||
    error instanceof StaleHostBindingAuthorityError ||
    error instanceof EpicWriteCommandTransportUnavailableError
  ) {
    // Whether the DIAL is what ran out, which is the only member of this
    // branch that is owed no wake-up. See `retryAfterMs` below.
    const dialExhausted = error instanceof RetryableTransportError;
    return {
      kind: "queued",
      reason: error instanceof Error ? error.message : String(error),
      boundedRetry: dialExhausted,
      // A self-timer for the dial failure ONLY, and the asymmetry is the whole point: this field asks
      // "will anything ever wake this command", and the three members of the branch answer differently.
      retryAfterMs: dialExhausted ? COMMAND_DIAL_RETRY_BASE_MS : null,
    };
  }
  if (error instanceof HostTransportFailureError) {
    return { kind: "unknown-outcome", reason: error.message };
  }
  if (error instanceof HostRpcError) {
    if (error.code === "E_IDEMPOTENCY_CACHE_SATURATED") {
      // The host emitted this only before resolver dispatch. Keep the command queued with its stable
      // key: a retry is safe and may succeed once replay capacity returns.
      return {
        kind: "queued",
        reason: error.message,
        boundedRetry: false,
        retryAfterMs: COMMAND_SATURATION_RETRY_BASE_MS,
      };
    }
    if (error.code === "E_IDEMPOTENCY_OUTCOME_UNKNOWN") {
      // The host retained the key but could not prove the original resolver's result by its in-flight
      // ceiling.
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
