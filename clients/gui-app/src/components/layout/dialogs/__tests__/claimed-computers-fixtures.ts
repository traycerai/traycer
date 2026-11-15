import type { ClaimedComputersResult } from "@traycer-clients/shared/auth/claimed-computers";
import type { EnvironmentListResponseV11 } from "@traycer/protocol/host/environment/contracts";

export const CLAIMED_COMPUTERS_RESULTS = {
  notFound: { kind: "not-found" },
  unauthorized: { kind: "unauthorized" },
  failed: { kind: "failed" },
} satisfies Record<string, ClaimedComputersResult>;

export function organizationEnvironment(
  environmentId: string,
  label: string,
): EnvironmentListResponseV11["environments"][number] {
  return {
    environmentId,
    ownerKind: "organization",
    ownerId: `owner-${environmentId}`,
    roomId: `room-${environmentId}`,
    label,
    effectiveRole: "viewer",
    kind: "team",
    hostCount: 0,
    providerHandle: null,
  };
}

export function environmentList(
  environments: readonly EnvironmentListResponseV11["environments"][number][],
): EnvironmentListResponseV11 {
  return { environments: [...environments] };
}

export interface DeferredClaimRead {
  readonly promise: Promise<ClaimedComputersResult>;
  readonly resolve: (result: ClaimedComputersResult) => void;
  readonly reject: (error: Error) => void;
  readonly attachSignal: (
    signal: AbortSignal,
  ) => Promise<ClaimedComputersResult>;
  readonly signalAborted: boolean;
}

/** A held AuthService read that rejects when its TanStack query is cancelled. */
export function deferredClaimRead(): DeferredClaimRead {
  let resolvePromise: (result: ClaimedComputersResult) => void = () => {
    throw new Error("deferred claim read has not initialized");
  };
  let rejectPromise: (error: Error) => void = () => {
    throw new Error("deferred claim read has not initialized");
  };
  let observedSignal: AbortSignal | null = null;
  const promise = new Promise<ClaimedComputersResult>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
    attachSignal: (signal) => {
      observedSignal = signal;
      const abort = (): void => {
        rejectPromise(new DOMException("claim read cancelled", "AbortError"));
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
      return promise.finally(() => signal.removeEventListener("abort", abort));
    },
    get signalAborted() {
      return observedSignal?.aborted ?? false;
    },
  };
}
