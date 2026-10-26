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

const STATE_LABELS: Readonly<Record<string, string>> = {
  applied: "Applied",
  received: "Received",
  pending: "Applying",
  applying: "Applying",
  saved: "Saved",
  waiting_resume: "applies when it resumes",
  unsupported: "Update needed",
  requested: "Cleanup requested",
  cleanup_requested: "Cleanup requested",
  confirmed: "Destroyed",
  destroyed: "Destroyed",
  failed: "Not applied",
  not_applied: "Not applied",
  offline: "Waiting for a connection",
  unconfirmed: "Hasn't confirmed",
  revoked: "Access revoked",
};

function stateLabel(state: string): string {
  return STATE_LABELS[state] ?? "Status unknown";
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
              {stateLabel(host.state)}
              {host.at === null ? null : ` · ${detailsTime(host.at)}`}
              {host.reason === null ? null : ` · ${host.reason}`}
            </p>
            {host.lastReportedAt === null ? null : (
              <p className="text-ui-xs text-muted-foreground">
                Last reported {detailsTime(host.lastReportedAt)}
              </p>
            )}
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
