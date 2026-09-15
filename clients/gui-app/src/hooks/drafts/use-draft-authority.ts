import { useCallback, useState } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { DraftPublication } from "@traycer/protocol/host";
import type { HostRpcRegistry } from "@/lib/host";
import { draftRequiresClaim } from "@/lib/drafts/draft-authority";
import { applyIncomingDraftDocument } from "@/lib/drafts/draft-mirror-coordinator";
import { useHostLabel } from "@/hooks/host/use-host-label";
import { draftClaimUserMessage, useDraftClaim } from "./use-draft-claim";
import { draftPublicationLabel } from "@/lib/drafts/draft-publication-label";

export interface DraftAuthorityControl {
  readonly readOnly: boolean;
  readonly ownerLabel: string;
  readonly claiming: boolean;
  readonly claimError: string | null;
  readonly publicationLabel: string | null;
  readonly claim: () => Promise<void>;
}

export function useDraftAuthorityControl(args: {
  readonly draftId: string | null;
  readonly ownerHostId: string | null;
  readonly origin: "own" | "replica" | null;
  readonly tabHostId: string | null;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly publication: DraftPublication | null;
}): DraftAuthorityControl {
  const { mutation: claimMutation, claim: claimDraft } = useDraftClaim(
    args.client,
  );
  const [claimError, setClaimError] = useState<string | null>(null);
  // The banner is the one place the user meets the owning host, so it names
  // the machine the way every other surface does. A host this directory does
  // not list (removed from the account, or not fetched yet) has no name to
  // give - and a raw host id is a UUID, not an answer.
  const ownerLabel = useHostLabel(args.ownerHostId) ?? "another device";
  const readOnly =
    args.tabHostId !== null &&
    args.draftId !== null &&
    draftRequiresClaim(args.ownerHostId, args.origin, args.tabHostId);
  const claim = useCallback(async (): Promise<void> => {
    if (args.draftId === null) return;
    const result = await claimDraft(args.draftId);
    if (result.status === "ok" || result.status === "already-owned") {
      setClaimError(null);
      await applyIncomingDraftDocument(result.draft);
      return;
    }
    setClaimError(draftClaimUserMessage(result));
  }, [args.draftId, claimDraft]);
  return {
    readOnly,
    ownerLabel,
    claiming: claimMutation.isPending,
    claimError,
    publicationLabel: draftPublicationLabel(args.publication),
    claim,
  };
}
