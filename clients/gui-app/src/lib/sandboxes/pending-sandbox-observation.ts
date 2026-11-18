/** Provenance accompanies an observation; arrival time is never freshness evidence. */
export type PendingSandboxObservation =
  | { readonly kind: "none" }
  | { readonly kind: "intent" }
  | {
      readonly kind: "list";
      readonly sentAt: number | null;
      readonly mountedAt: number;
      readonly missingSandboxId?: string;
    }
  | { readonly kind: "stop-result"; readonly requestedAt: number | null }
  | { readonly kind: "wake-result"; readonly requestedAt: number | null }
  | {
      readonly kind: "dispatch-result";
      readonly chatId: string;
      readonly hostId: string;
    };

type HostObservation = "unknown" | "awake" | "resting" | "waking" | "ended";
export interface PendingSandboxPresence {
  readonly sandboxId: string;
  readonly rowSeen: boolean;
}

interface HeldSandboxRequest {
  readonly createdAt: number;
  readonly stopRequested?: boolean;
  readonly stopRequestedAt?: number;
  readonly observationRequestedAt?: number;
  readonly createdSandbox?: PendingSandboxPresence;
  readonly delivery?: {
    readonly chatId: string;
    readonly hostId: string;
  } | null;
  readonly dispatch?: {
    readonly input: { readonly chatId: string; readonly hostId: string };
  } | null;
}

function pendingRequestBoundary(
  request: HeldSandboxRequest | null,
  mountedAt: number,
): number {
  if (request === null) return mountedAt;
  return Math.max(
    request.createdAt,
    request.observationRequestedAt ??
      (request.dispatch !== null && request.dispatch !== undefined
        ? Infinity
        : request.createdAt),
    request.stopRequested === true
      ? (request.stopRequestedAt ?? Infinity)
      : request.createdAt,
  );
}

/** An operation result proves only its own currently held request. */
function confirmedObservationMatches(
  request: HeldSandboxRequest,
  observation: PendingSandboxObservation,
): boolean {
  switch (observation.kind) {
    case "stop-result":
      return (
        request.stopRequested === true &&
        observation.requestedAt !== null &&
        observation.requestedAt === request.stopRequestedAt
      );
    case "wake-result":
      return (
        request.stopRequested !== true &&
        observation.requestedAt !== null &&
        observation.requestedAt === request.observationRequestedAt
      );
    case "dispatch-result": {
      const identity = request.dispatch?.input ?? request.delivery;
      return (
        identity?.chatId === observation.chatId &&
        identity.hostId === observation.hostId
      );
    }
    default:
      return false;
  }
}

/** A matching failure remains current even when it proves no host state. */
export function pendingSandboxOperationResultCurrent(
  request: HeldSandboxRequest | null,
  observation: PendingSandboxObservation,
): boolean {
  switch (observation.kind) {
    case "stop-result":
    case "wake-result":
    case "dispatch-result":
      return (
        request !== null && confirmedObservationMatches(request, observation)
      );
    default:
      return true;
  }
}

/** All settlement evidence crosses this boundary, including confirmed operation results. */
export function decodePendingSandboxObservation(
  request: HeldSandboxRequest | null,
  host: HostObservation,
  observation: PendingSandboxObservation,
): HostObservation {
  if (observation.kind === "list")
    return observation.sentAt !== null &&
      observation.sentAt >
        pendingRequestBoundary(request, observation.mountedAt) &&
      !(
        observation.missingSandboxId !== undefined &&
        request?.createdSandbox?.sandboxId === observation.missingSandboxId &&
        !request.createdSandbox.rowSeen
      )
      ? host
      : "unknown";
  if (request === null) return "unknown";
  if (observation.kind === "intent") {
    // A named wake intent proves no settlement or readiness.
    return host === "resting" && request.stopRequested !== true
      ? host
      : "unknown";
  }
  return confirmedObservationMatches(request, observation) ? host : "unknown";
}
