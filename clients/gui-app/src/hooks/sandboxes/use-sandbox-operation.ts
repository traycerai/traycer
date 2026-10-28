import { useCallback } from "react";
import { hashKey, type Mutation } from "@tanstack/react-query";
import {
  sandboxSupportReference,
  type SandboxLifecycleVerb,
} from "@traycer/protocol/host/sandbox-control";
import { SandboxOperationError } from "@/hooks/sandboxes/sandbox-failure-copy";
import { useMutationStateOf } from "@/hooks/use-mutation-state-of";
import {
  SandboxDestroySkippedError,
  type SandboxDestroyRequest,
} from "@/hooks/sandboxes/use-sandbox-destroy-mutation";
import { sandboxMutationKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";

export type SandboxRowVerb = SandboxLifecycleVerb | "destroy";

export type SandboxRowOperation =
  | { readonly kind: "pending"; readonly verb: SandboxRowVerb }
  | { readonly kind: "skipped"; readonly message: string }
  | {
      readonly kind: "failed";
      readonly verb: SandboxRowVerb;
      readonly error: Error;
      readonly code: string | null;
      readonly reference: string;
      readonly destroyRequest: SandboxDestroyRequest;
    };

/**
 * The newest operation for one sandbox, shared across rows, confirmations and
 * Details. A mutation key identifies records; it does not share an observer's
 * `isPending`. Read the cache itself, including settled failures, and use the
 * cache's monotonic order so two presses in one millisecond cannot tie.
 */
export function useSandboxOperation(
  sandboxId: string,
): SandboxRowOperation | null {
  const userId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  const verbKey = hashKey(sandboxMutationKeys.verb(sandboxId));
  const destroyKey = hashKey(sandboxMutationKeys.destroy(sandboxId));
  const predicate = useCallback(
    (mutation: Mutation) => {
      const key = hashKey(mutation.options.mutationKey ?? []);
      const context = mutation.state.context;
      return (
        (key === verbKey || key === destroyKey) &&
        typeof context === "object" &&
        context !== null &&
        "userId" in context &&
        context.userId === userId
      );
    },
    [verbKey, destroyKey, userId],
  );
  const select = useCallback(
    (mutation: Mutation) => ({
      order: mutation.mutationId,
      verb:
        hashKey(mutation.options.mutationKey ?? []) === destroyKey
          ? "destroy"
          : mutation.state.variables,
      variables: mutation.state.variables,
      status: mutation.state.status,
      error: mutation.state.error,
    }),
    [destroyKey],
  );
  const operations = useMutationStateOf({ predicate }, select);
  const latest = operations.reduce<(typeof operations)[number] | null>(
    (newest, entry) =>
      newest === null || entry.order > newest.order ? entry : newest,
    null,
  );
  if (latest === null || !isRowVerb(latest.verb)) return null;
  if (latest.status === "pending") {
    return { kind: "pending", verb: latest.verb };
  }
  if (latest.status !== "error" || latest.error === null) return null;
  if (latest.error instanceof SandboxDestroySkippedError) {
    return { kind: "skipped", message: latest.error.message };
  }
  const failure =
    latest.error instanceof SandboxOperationError ? latest.error.failure : null;
  const code = failure?.kind === "refused" ? failure.code : null;
  const reference =
    sandboxSupportReference(code) ?? sandboxSupportReference(latest.verb);
  if (reference === null) {
    throw new Error(`Missing sandbox support reference for ${latest.verb}`);
  }
  return {
    kind: "failed",
    verb: latest.verb,
    error: latest.error,
    code,
    reference,
    destroyRequest: destroyRetryRequest(latest.variables),
  };
}

function isRowVerb(value: unknown): value is SandboxRowVerb {
  return (
    value === "start" ||
    value === "resume" ||
    value === "suspend" ||
    value === "stop" ||
    value === "destroy"
  );
}

function destroyRetryRequest(value: unknown): SandboxDestroyRequest {
  if (
    typeof value === "object" &&
    value !== null &&
    "idleOnly" in value &&
    value.idleOnly === true &&
    "startedBy" in value &&
    (typeof value.startedBy === "string" || value.startedBy === null)
  ) {
    return { idleOnly: true, startedBy: value.startedBy };
  }
  return undefined;
}
