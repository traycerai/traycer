import { CancelledError } from "@tanstack/react-query";
import { isHostRequestControlFlowError } from "@traycer-clients/shared/host-client/host-request-coordinator";
import { toHostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";

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
      throw new CancelledError({ revert: true, silent: true });
    }
    throw toHostRpcError(error, method);
  }
}
