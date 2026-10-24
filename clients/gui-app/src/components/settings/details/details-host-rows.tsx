import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type {
  DetailsHostStatus,
  DetailsRecovery,
} from "@/lib/settings-details-entry";
import {
  detailsRecoveryLabel,
  detailsTime,
} from "@/components/settings/details/details-copy";

function stateLabel(state: string): string {
  switch (state) {
    case "applied":
      return "Applied";
    case "received":
      return "Received";
    case "pending":
    case "applying":
      return "Applying";
    case "saved":
      return "Saved";
    case "waiting_resume":
      return "applies when it resumes";
    case "unsupported":
      return "Update needed";
    case "requested":
    case "cleanup_requested":
      return "Cleanup requested";
    case "confirmed":
    case "destroyed":
      return "Destroyed";
    case "failed":
    case "not_applied":
      return "Not applied";
    case "offline":
      return "Waiting for a connection";
    case "revoked":
      return "Access revoked";
    default:
      return "Status unknown";
  }
}

/** These rows consume only authorized metadata supplied by their provider. */
export function DetailsHostRows(props: {
  readonly hosts: readonly DetailsHostStatus[];
  readonly onRecover: (recovery: DetailsRecovery) => void;
  readonly pending: boolean;
}): ReactNode {
  return (
    <ul className="flex flex-col divide-y divide-border/60">
      {props.hosts.map((host) => (
        <li
          key={`${host.hostId}:${host.item ?? ""}:${host.state}:${host.at}`}
          className="flex flex-wrap items-start justify-between gap-2 py-3"
        >
          <div className="min-w-0 flex-1">
            <p className="break-words font-medium">
              {host.name}
              {host.item === null ? null : ` · ${host.item}`}
            </p>
            <p className="text-ui-xs text-muted-foreground">
              {stateLabel(host.state)} · {detailsTime(host.at)}
              {host.reason === null ? null : ` · ${host.reason}`}
            </p>
            <p className="text-ui-xs text-muted-foreground">
              Last reported {detailsTime(host.lastReportedAt)}
            </p>
          </div>
          {host.recovery === null ? null : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={props.pending}
              onClick={() => {
                if (host.recovery !== null) props.onRecover(host.recovery);
              }}
            >
              {detailsRecoveryLabel(host.recovery, host.name)}
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}
