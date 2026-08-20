import { useCallback, useState } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  DraftDocument,
  DraftsClaimResponse,
} from "@traycer/protocol/host";
import type { HostRpcRegistry } from "@/lib/host";
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

/**
 * First-edit claim through the tab's connected host. `unsupported-version`
 * is a typed unavailable reason, not a generic failure.
 */
export function useDraftClaim(client: HostClient<HostRpcRegistry> | null): {
  readonly claiming: boolean;
  readonly claim: (draftId: string) => Promise<DraftClaimResult>;
} {
  const [claiming, setClaiming] = useState(false);
  const claim = useCallback(
    async (draftId: string): Promise<DraftClaimResult> => {
      if (client === null) return { status: "failed" };
      setClaiming(true);
      try {
        const response = await client.request("drafts.claim", { draftId });
        if (response.status === "unavailable") {
          return { status: "unavailable", reason: response.reason };
        }
        return { status: response.status, draft: response.draft };
      } catch (error: unknown) {
        if (isDraftsCapabilityMissing(error)) {
          return { status: "unsupported" };
        }
        return { status: "failed" };
      } finally {
        setClaiming(false);
      }
    },
    [client],
  );
  return { claiming, claim };
}

export function draftClaimUserMessage(result: DraftClaimResult): string | null {
  switch (result.status) {
    case "ok":
    case "already-owned":
    case "unsupported":
      return null;
    case "failed":
      return "Could not take over this draft. Try again.";
    case "unavailable":
      switch (result.reason) {
        case "unsupported-version":
          return "This draft needs a newer Traycer to open.";
        case "plan-ineligible":
          return null;
        case "not-found":
          return "This draft is no longer available.";
        case "not-published":
          return "This draft has not been backed up yet.";
        case "publication-not-ready":
          return "Backup is not ready on this host yet.";
      }
  }
}
