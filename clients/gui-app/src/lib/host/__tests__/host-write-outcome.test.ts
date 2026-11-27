import { describe, expect, it } from "vitest";
import {
  HostRpcError,
  HostTransportFailureError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import {
  markMayHaveReachedHost,
  markTargetAnswer,
  transportFailureBeforeSend,
} from "@traycer/protocol/host-transport/remote/rpc-types";
import { hostWriteFailureOutcome } from "@/lib/host/host-write-outcome";
import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";

const METHOD = "epic.setPinned";
const COMPUTER_HOST_ID = "computer-1";

function receivedPeerError(
  code: string,
  message: string,
  method: string,
): HostRpcError {
  const error = HostRpcError.fromWireEnvelope(
    { code, message },
    "request-1",
    method,
  );
  markTargetAnswer(error);
  return error;
}

describe("hostWriteFailureOutcome", () => {
  it.each([
    ["E_INVALID_ARGUMENT", "The request is invalid.", METHOD],
    [
      "E_INVALID_ARGUMENT",
      "epic.revokeCollaborator: not found",
      "epic.revokeCollaborator",
    ],
    [
      "E_INVALID_ARGUMENT",
      "epic.revokeCollaborator: the cloud refused the request",
      "epic.revokeCollaborator",
    ],
    ["UNAUTHORIZED", "Sign in is required.", METHOD],
    ["FORBIDDEN", "You cannot update this task.", METHOD],
    [
      "FORBIDDEN",
      "Sharing with this team requires a paid team plan",
      "epic.grantAccess",
    ],
    [
      "E_HOST_UNSUPPORTED",
      "Method 'epic.batchDelete' is not served by this host",
      "epic.batchDelete",
    ],
  ] as const)(
    "classifies the received %s envelope by the addressed peer",
    (code, message, method) => {
      const error = receivedPeerError(code, message, method);

      expect(hostWriteFailureOutcome(error, COMPUTER_HOST_ID)).toBe("refused");
      expect(hostWriteFailureOutcome(error, POOL_HOST_ID)).toBe("refused");
    },
  );

  it("keeps a plain pool RPC_ERROR unknown while treating the same received computer error as a refusal", () => {
    const error = receivedPeerError(
      "RPC_ERROR",
      "The pool failed the request.",
      METHOD,
    );

    expect(hostWriteFailureOutcome(error, COMPUTER_HOST_ID)).toBe("refused");
    expect(hostWriteFailureOutcome(error, POOL_HOST_ID)).toBe("unknown");
  });

  it("treats the recognized roomless-comment error as an explicit refusal from either peer", () => {
    const error = receivedPeerError(
      "RPC_ERROR",
      "No collaboration thread provider for this artifact",
      "epic.createCommentThread",
    );

    expect(hostWriteFailureOutcome(error, COMPUTER_HOST_ID)).toBe("refused");
    expect(hostWriteFailureOutcome(error, POOL_HOST_ID)).toBe("refused");
  });

  it("keeps the received idempotency uncertainty envelope unknown for either peer", () => {
    const error = receivedPeerError(
      "E_IDEMPOTENCY_OUTCOME_UNKNOWN",
      "The request outcome is unknown.",
      METHOD,
    );

    expect(hostWriteFailureOutcome(error, COMPUTER_HOST_ID)).toBe("unknown");
    expect(hostWriteFailureOutcome(error, POOL_HOST_ID)).toBe("unknown");
  });

  it("recognizes the transport producer's proof that no request frame was sent", () => {
    const error = transportFailureBeforeSend({
      message: "The local session closed before sending.",
      requestId: "request-before-send",
      method: METHOD,
    });

    expect(hostWriteFailureOutcome(error, COMPUTER_HOST_ID)).toBe("not-sent");
    expect(hostWriteFailureOutcome(error, POOL_HOST_ID)).toBe("not-sent");
  });

  it("keeps a post-send transport failure unknown for either peer", () => {
    const error = new HostTransportFailureError({
      code: "RPC_ERROR",
      message: "The response was not received.",
      requestId: "request-after-send",
      method: METHOD,
      fatalDetails: null,
    });

    expect(hostWriteFailureOutcome(error, COMPUTER_HOST_ID)).toBe("unknown");
    expect(hostWriteFailureOutcome(error, POOL_HOST_ID)).toBe("unknown");
  });

  it("keeps the receiver's task-read FATAL unknown by its exact sent-at-peer marker", () => {
    const error = new HostTransportFailureError({
      code: "RPC_ERROR",
      message: "Task read unavailable.",
      requestId: "request-fatal",
      method: METHOD,
      fatalDetails: {
        code: "TASK_READ_UNAVAILABLE",
        reason: "task read unavailable",
        retryable: true,
        incompatibleMethods: null,
        upgradeGuidance: null,
      },
    });
    markMayHaveReachedHost(error);

    expect(hostWriteFailureOutcome(error, COMPUTER_HOST_ID)).toBe("unknown");
    expect(hostWriteFailureOutcome(error, POOL_HOST_ID)).toBe("unknown");
  });

  it("does not treat a local non-response fatal with details as a received refusal", () => {
    const error = new HostTransportFailureError({
      code: "RPC_ERROR",
      message: "Local fatal before an answer frame.",
      requestId: "request-local-fatal",
      method: METHOD,
      fatalDetails: {
        code: "RPC_ERROR",
        reason: "Local fatal before an answer frame.",
        incompatibleMethods: null,
        upgradeGuidance: null,
      },
    });

    expect(hostWriteFailureOutcome(error, COMPUTER_HOST_ID)).toBe("unknown");
    expect(hostWriteFailureOutcome(error, POOL_HOST_ID)).toBe("unknown");
  });
});
