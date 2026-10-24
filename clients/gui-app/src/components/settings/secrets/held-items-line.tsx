import { useState, type ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  heldItemsGroupedByHost,
  heldRowsFromReview,
  type HeldItemsGroup,
} from "@/components/settings/move/held-from-review";
import { heldItemsLineText } from "@/components/settings/move/held-items-line-copy";
import { RetrospectiveSession } from "@/components/settings/move/retrospective-session";
import { usePersonalHostName } from "@/components/settings/personal/personal-page-context";
import { Button } from "@/components/ui/button";
import { useEnvironmentReviewRead } from "@/hooks/environment/use-environment-reads";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * Secrets page held-items line (`3 items from MacBook Pro are not in use ·
 * Review them`). Self-retiring: omitted when no held row is left. Opens the
 * retrospective sheet for that host's held rows.
 */
export interface HeldItemsLineProps {
  readonly client: HostClient<HostRpcRegistry>;
  readonly hostId: string | null;
}

export function HeldItemsLine(props: HeldItemsLineProps): ReactNode {
  const review = useEnvironmentReviewRead(
    props.client,
    props.hostId,
    props.hostId !== null,
  );
  const groups = heldItemsGroupedByHost(review.data?.entries ?? []);
  if (groups.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1.5" data-testid="held-items-line">
      {groups.map((group) => (
        <HeldItemsGroupLine
          key={group.hostId === null ? "unhosted" : group.hostId}
          group={group}
          client={props.client}
          reviewHostId={props.hostId}
        />
      ))}
    </ul>
  );
}

function HeldItemsGroupLine(props: {
  readonly group: HeldItemsGroup;
  readonly client: HostClient<HostRpcRegistry>;
  readonly reviewHostId: string | null;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const stopHostId = props.group.hostId ?? props.reviewHostId;
  const stopClient = useHostClientForHostId(stopHostId);
  const entry = useHostDirectoryEntry(stopHostId);
  const personalName = usePersonalHostName();
  const hostName = entry?.label ?? personalName ?? "this computer";
  return (
    <li>
      <Button
        type="button"
        variant="link"
        size="inline-xs-wrap"
        data-testid={`held-items-line-${stopHostId ?? "none"}`}
        onClick={() => setOpen(true)}
      >
        {heldItemsLineText(props.group.entries.length, hostName)}
      </Button>
      <RetrospectiveSession
        client={props.client}
        reviewHostId={props.reviewHostId}
        stopClient={stopClient}
        stopHostId={stopHostId}
        hostName={hostName}
        open={open}
        held={heldRowsFromReview(props.group.entries)}
        onOpenChange={setOpen}
      />
    </li>
  );
}
