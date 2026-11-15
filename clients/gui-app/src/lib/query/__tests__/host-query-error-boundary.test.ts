import { CancelledError } from "@tanstack/react-query";
import {
  HostRequestControlFlowError,
  type HostRequestControlFlowReason,
} from "@traycer-clients/shared/host-client/host-request-coordinator";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { describe, expect, it } from "vitest";
import { HostBelowMinimumError } from "@/lib/host/host-below-minimum-error";
import {
  HostControlFlowCancelledError,
  hostControlFlowReasonOf,
  withHostMutationErrorBoundary,
  withHostQueryErrorBoundary,
} from "@/lib/query/host-query-error-boundary";

// The boundary is where a coordinator rejection becomes a TanStack
// cancellation. The cancellation used to carry nothing, so a caller that
// logged it could not tell a waiter it cancelled from an authority it lost;
// it now keeps the coordinator's reason.

const REASONS: readonly HostRequestControlFlowReason[] = [
  "waiter-cancelled",
  "authority-superseded",
  "coordinator-disposed",
];

async function rejectionOf(run: () => Promise<unknown>): Promise<unknown> {
  return withHostQueryErrorBoundary("providers.awaitLogin", run).then(
    () => {
      throw new Error("expected the boundary to reject");
    },
    (error: unknown) => error,
  );
}

describe("withHostQueryErrorBoundary - coordinator control flow", () => {
  it("turns a local below-minimum failure into a silent, reverting cancellation", async () => {
    const belowMinimum = new HostBelowMinimumError({
      requestId: "floor-query",
      method: "environment.status",
    });
    const error = await rejectionOf(() => Promise.reject(belowMinimum));

    expect(error).toBeInstanceOf(CancelledError);
    expect(error).not.toBeInstanceOf(HostControlFlowCancelledError);
    if (!(error instanceof CancelledError)) {
      throw new Error("expected a CancelledError");
    }
    expect(error.revert).toBe(true);
    expect(error.silent).toBe(true);
  });

  it("preserves the local below-minimum HostRpcError at the mutation boundary", async () => {
    const belowMinimum = new HostBelowMinimumError({
      requestId: "floor-mutation",
      method: "terminal.create",
    });
    const error = await withHostMutationErrorBoundary("terminal.create", () =>
      Promise.reject(belowMinimum),
    ).then(
      () => {
        throw new Error("expected the mutation boundary to reject");
      },
      (rejection: unknown) => rejection,
    );

    expect(error).toBe(belowMinimum);
    expect(error).toBeInstanceOf(HostRpcError);
    expect(error).not.toBeInstanceOf(CancelledError);
  });

  it.each(REASONS)(
    "rethrows a %s rejection as a TanStack cancellation that keeps the reason",
    async (reason) => {
      const error = await rejectionOf(() =>
        Promise.reject(new HostRequestControlFlowError(reason)),
      );

      expect(error).toBeInstanceOf(CancelledError);
      expect(error).toBeInstanceOf(HostControlFlowCancelledError);
      expect(hostControlFlowReasonOf(error)).toBe(reason);
      if (!(error instanceof CancelledError)) {
        throw new Error("expected a CancelledError");
      }
      expect(error.revert).toBe(true);
      expect(error.silent).toBe(true);
    },
  );

  it("leaves any other rejection as a non-cancellation with no control-flow reason", async () => {
    const error = await rejectionOf(() => Promise.reject(new Error("boom")));

    expect(hostControlFlowReasonOf(error)).toBeNull();
    expect(error).not.toBeInstanceOf(CancelledError);
  });

  it("reports no reason for a plain TanStack cancellation the boundary did not mint", () => {
    expect(
      hostControlFlowReasonOf(new CancelledError({ silent: true })),
    ).toBeNull();
  });
});
