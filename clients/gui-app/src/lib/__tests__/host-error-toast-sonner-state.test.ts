import { afterEach, describe, expect, it } from "vitest";
import { toast } from "sonner";
import {
  HostRpcError,
  HostTransportFailureError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import {
  toastFromHostError,
  toastUnknownOutcomeAfterRefusedRetry,
} from "@/lib/host-error-toast";

/**
 * Against the REAL Sonner store, not a mock: Sonner updates a toast that
 * reuses an id by merging the new data into the old (`{ ...toast, ...data }`),
 * so a field the later call leaves out keeps the earlier value. The
 * unknown-outcome notice shares one id across its callers, so every
 * uncertainty-only call must clear a description an earlier call set.
 */
const UNKNOWN_OUTCOME_ID = "host-transport-notice-unknown";

function storedUnknownOutcomeToast(): { readonly description?: unknown } {
  const stored = toast
    .getToasts()
    .find((entry) => entry.id === UNKNOWN_OUTCOME_ID);
  if (stored === undefined || !("title" in stored)) {
    throw new Error("expected the unknown-outcome toast in Sonner's store");
  }
  return stored;
}

function refusal(code: "FORBIDDEN" | "E_IDEMPOTENCY_OUTCOME_UNKNOWN") {
  return new HostRpcError({
    code,
    message: "refused",
    requestId: "req-2",
    method: "epic.create",
    fatalDetails: null,
  });
}

afterEach(() => {
  toast.dismiss();
});

describe("the shared unknown-outcome toast in Sonner's store", () => {
  it("drops a refused retry's guidance line when a later uncertainty-only notice replaces it", () => {
    toastUnknownOutcomeAfterRefusedRetry(
      refusal("FORBIDDEN"),
      "Couldn't create epic.",
    );
    expect(storedUnknownOutcomeToast().description).toBe(
      "The retry was refused: You don't have permission to do that.",
    );

    // A post-send drop on another gesture: the transport notice, same id.
    toastFromHostError(
      new HostTransportFailureError({
        code: "RPC_ERROR",
        message: "socket closed",
        requestId: "req-3",
        method: "epic.deleteChat",
        fatalDetails: null,
      }),
      "Couldn't delete agent.",
    );
    expect(storedUnknownOutcomeToast().description).toBeUndefined();

    // The helper's own no-guidance branch, after guidance was shown again.
    toastUnknownOutcomeAfterRefusedRetry(
      refusal("FORBIDDEN"),
      "Couldn't create epic.",
    );
    toastUnknownOutcomeAfterRefusedRetry(
      refusal("E_IDEMPOTENCY_OUTCOME_UNKNOWN"),
      "Couldn't create epic.",
    );
    expect(storedUnknownOutcomeToast().description).toBeUndefined();
  });
});
