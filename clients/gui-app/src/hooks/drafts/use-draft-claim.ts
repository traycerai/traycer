import { useCallback } from "react";
import type { UseMutationResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  DraftDocument,
  DraftsClaimRequest,
  DraftsClaimResponse,
} from "@traycer/protocol/host";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { draftsMutationKeys } from "@/lib/query-keys/drafts-mutation-keys";
import { isDraftsCapabilityMissing } from "@/lib/drafts/draft-capability";

export type DraftClaimUnavailableReason = Extract<
  DraftsClaimResponse,
  { status: "unavailable" }
>["reason"];

export type DraftClaimResult =
  | {
      readonly status: "ok" | "already-owned";
      readonly draft: DraftDocument;
    }
  | {
      readonly status: "unavailable";
      readonly reason: DraftClaimUnavailableReason;
    }
  | { readonly status: "unsupported" }
  | { readonly status: "failed" };

export type DraftClaimMutationResult = UseMutationResult<
  DraftsClaimResponse,
  HostRpcError,
  DraftsClaimRequest
>;

export interface DraftClaimControl {
  /** The full mutation - pending state, error, reset. */
  readonly mutation: DraftClaimMutationResult;
  /**
   * The claim as the authority banner needs it: every outcome typed, so a
   * refusal reaches the inline surface instead of a rejected promise.
   */
  readonly claim: (draftId: string) => Promise<DraftClaimResult>;
}

/**
 * First-edit claim through the tab's connected host. `unsupported-version`
 * is a typed unavailable reason, not a generic failure.
 *
 * No `onError` toast: the caller renders the refusal inline in
 * `DraftAuthorityBanner`, which is the one sanctioned reason to omit one.
 */
export function useDraftClaim(
  client: HostClient<HostRpcRegistry> | null,
): DraftClaimControl {
  const mutation = useHostMutation<HostRpcRegistry, "drafts.claim">({
    client,
    method: "drafts.claim",
    mapVariables: (variables: DraftsClaimRequest) => variables,
    options: { mutationKey: draftsMutationKeys.claim() },
  });
  const { mutateAsync } = mutation;
  const claim = useCallback(
    async (draftId: string): Promise<DraftClaimResult> => {
      if (client === null) return { status: "failed" };
      try {
        const response = await mutateAsync({ draftId });
        if (response.status === "unavailable") {
          return { status: "unavailable", reason: response.reason };
        }
        return { status: response.status, draft: response.draft };
      } catch (error: unknown) {
        if (isDraftsCapabilityMissing(error)) {
          return { status: "unsupported" };
        }
        return { status: "failed" };
      }
    },
    [client, mutateAsync],
  );
  return { mutation, claim };
}

/**
 * The one line the banner shows for an outcome that is not a takeover.
 * Every branch answers: the user pressed "Edit here" and the replica stayed
 * read-only, so a silent `null` reads as a dead button.
 */
export function draftClaimUserMessage(result: DraftClaimResult): string | null {
  switch (result.status) {
    case "ok":
    case "already-owned":
      return null;
    case "unsupported":
      return "This host is too old to take over a draft. Update it and try again.";
    case "failed":
      return "Could not take over this draft. Try again.";
    case "unavailable":
      switch (result.reason) {
        case "unsupported-version":
          return "This draft needs a newer Traycer to open.";
        case "plan-ineligible":
          return "Taking over a draft from another device needs a paid plan.";
        case "not-found":
          return "This draft is no longer available.";
        case "not-published":
          return "This draft has not been backed up yet.";
        case "publication-not-ready":
          return "Backup is not ready on this host yet.";
      }
  }
}
