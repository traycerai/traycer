import { CancelledError } from "@tanstack/react-query";
import {
  isHostRequestControlFlowError,
  type HostRequestControlFlowReason,
} from "@traycer-clients/shared/host-client/host-request-coordinator";
import { toHostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";

/**
 * The TanStack cancellation minted for coordinator control flow, carrying
 * the coordinator's reason. TanStack's own `CancelledError` keeps none: its
 * message is the literal "CancelledError", so a caller that logs it cannot
 * tell a waiter it cancelled from an authority it lost.
 */
export class HostControlFlowCancelledError extends CancelledError {
  readonly reason: HostRequestControlFlowReason;

  constructor(reason: HostRequestControlFlowReason) {
    super({ revert: true, silent: true });
    this.reason = reason;
  }
}

/** The coordinator reason a rejection carries, or `null` for any other error. */
export function hostControlFlowReasonOf(
  error: unknown,
): HostRequestControlFlowReason | null {
  return error instanceof HostControlFlowCancelledError ? error.reason : null;
}

/**
 * Normalizes GUI host-RPC query failures while preserving coordinator control
 * flow as TanStack cancellation. This is intentionally GUI-owned: it is the
 * only layer that may depend on both the coordinator error and TanStack.
 */
export async function withHostQueryErrorBoundary<T>(
  method: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isHostRequestControlFlowError(error)) {
      throw new HostControlFlowCancelledError(error.reason);
    }
    throw toHostRpcError(error, method);
  }
}
