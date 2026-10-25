import { useContext, useState, type ReactNode } from "react";
import type { EnvironmentReviewEntry } from "@traycer/protocol/host/environment-schemas";
import { heldRowsFromReview } from "@/components/settings/move/held-from-review";
import { RetrospectiveSession } from "@/components/settings/move/retrospective-session";
import { PersonalPageContext } from "@/components/settings/personal/personal-page-context";
import { Button } from "@/components/ui/button";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";

/**
 * `Review` on one held value of a Personal page: opens the retrospective
 * sheet for that value alone. Nothing outside a Personal page.
 */
export function HeldValueReview(props: {
  readonly entry: EnvironmentReviewEntry;
}): ReactNode {
  const page = useContext(PersonalPageContext);
  const [open, setOpen] = useState(false);
  const stopHostId = props.entry.hostId ?? page?.hostId ?? null;
  const stopClient = useHostClientForHostId(stopHostId);
  const directory = useHostDirectoryEntry(stopHostId);
  if (page === null || page.client === null) return null;
  return (
    <>
      <Button
        type="button"
        variant="link"
        size="inline"
        data-testid="held-value-review"
        onClick={() => setOpen(true)}
      >
        Review
      </Button>
      <RetrospectiveSession
        client={page.client}
        reviewHostId={page.hostId}
        stopClient={stopClient}
        stopHostId={stopHostId}
        hostName={directory?.label ?? page.hostName}
        open={open}
        held={heldRowsFromReview([props.entry])}
        onOpenChange={setOpen}
      />
    </>
  );
}
