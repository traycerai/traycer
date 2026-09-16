import { useCallback } from "react";
import type { UseMutationResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  DraftsRetractRequest,
  DraftsRetractResponse,
} from "@traycer/protocol/host";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { draftsMutationKeys } from "@/lib/query-keys/drafts-mutation-keys";
import { isDraftsCapabilityMissing } from "@/lib/drafts/draft-capability";

export type DraftRetractResult =
  | { readonly status: "retracted" }
  /** The cloud row was already gone. */
  | { readonly status: "absent" }
  /** A host that predates `drafts.retract`; nothing was retracted. */
  | { readonly status: "unsupported" }
  | { readonly status: "failed" };

export type DraftRetractMutationResult = UseMutationResult<
  DraftsRetractResponse,
  HostRpcError,
  DraftsRetractRequest
>;

export interface DraftRetractControl {
  /** The full mutation - pending state, error, reset. */
  readonly mutation: DraftRetractMutationResult;
  /**
   * The retract as its callers need it: every outcome typed, so a host
   * without the method reaches the caller's no-op instead of a rejected
   * promise.
   */
  readonly retract: (draftId: string) => Promise<DraftRetractResult>;
}

/**
 * Retract the cloud row of a draft another host owns, through `client`'s
 * host (History's, which need not hold any row for it). Ownership never
 * moves: this is the one cross-host mutation a drafts client makes, a
 * delete on the user's own authority. The owning host tombstones its local
 * row when it finds the cloud row gone.
 *
 * No `onError` toast, and no other surface either: a History delete of a
 * foreign row either drops the local mirror (`retracted`, `absent`) or
 * leaves the row where it is (`unsupported`, `failed`) for the next
 * attempt. Nothing about draft ownership is ever shown.
 */
export function useDraftRetract(
  client: HostClient<HostRpcRegistry> | null,
): DraftRetractControl {
  const mutation = useHostMutation<HostRpcRegistry, "drafts.retract">({
    client,
    method: "drafts.retract",
    mapVariables: (variables: DraftsRetractRequest) => variables,
    options: { mutationKey: draftsMutationKeys.retract() },
  });
  const { mutateAsync } = mutation;
  const retract = useCallback(
    async (draftId: string): Promise<DraftRetractResult> => {
      if (client === null) return { status: "failed" };
      try {
        const response = await mutateAsync({ draftId });
        return { status: response.retracted ? "retracted" : "absent" };
      } catch (error: unknown) {
        if (isDraftsCapabilityMissing(error)) {
          return { status: "unsupported" };
        }
        return { status: "failed" };
      }
    },
    [client, mutateAsync],
  );
  return { mutation, retract };
}
