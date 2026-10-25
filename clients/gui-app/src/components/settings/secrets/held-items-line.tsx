import { useState, type ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  heldItemsGroupedByHost,
  heldRowsFromReview,
  type HeldItemsGroup,
} from "@/components/settings/move/held-from-review";
import {
  heldItemsHostName,
  heldItemsLineText,
} from "@/components/settings/move/held-items-line-copy";
import { findHostOption } from "@/components/settings/host-scope/host-scope-model";
import { useHostOptions } from "@/components/settings/host-scope/use-host-options";
import { RetrospectiveSession } from "@/components/settings/move/retrospective-session";
import { usePersonalHostName } from "@/components/settings/personal/personal-page-context";
import { Button } from "@/components/ui/button";
import { useEnvironmentReviewRead } from "@/hooks/environment/use-environment-reads";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * Secrets page held-items line (`1 value and 1 command from MacBook Pro are
 * on hold until you choose · Review them`). Self-retiring: omitted when no held row is left. Opens the
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
  const { hosts } = useHostOptions();
  const personalName = usePersonalHostName();
  // The directory lists only hosts this window can dial; the account's list
  // names the rest, an offline computer among them.
  const hostName = heldItemsHostName(
    [findHostOption(hosts, stopHostId)?.name ?? null, entry?.label ?? null],
    { isSource: stopHostId === props.reviewHostId, name: personalName },
  );
  return (
    <li>
      <Button
        type="button"
        variant="link"
        size="inline-xs-wrap"
        data-testid={`held-items-line-${stopHostId ?? "none"}`}
        onClick={() => setOpen(true)}
      >
        {heldItemsLineText(
          {
            values: props.group.entries.filter(
              (entry) => entry.reason !== "executable_entry",
            ).length,
            commands: props.group.entries.filter(
              (entry) => entry.reason === "executable_entry",
            ).length,
          },
          hostName,
        )}
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
