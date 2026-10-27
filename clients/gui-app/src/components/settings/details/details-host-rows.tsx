import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { SandboxRetryApplyingButton } from "@/components/sandboxes/sandbox-retry-applying-button";
import type {
  DetailsHostStatus,
  DetailsRecovery,
} from "@/lib/settings-details-entry";
import {
  detailsRecoveryLabel,
  detailsTime,
} from "@/components/settings/details/details-copy";
import { unusedSettingLabel } from "@/components/settings/details/details-unused-setting";

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
  const occurrences = new Map<string, number>();
  return (
    <ul className="flex flex-col divide-y divide-border/60">
      {props.hosts.map((host) => {
        const identity = `${host.hostId}:${host.item ?? ""}:${host.state}:${host.at}`;
        // Different unused settings can share the same agent label.
        const occurrence = occurrences.get(identity) ?? 0;
        occurrences.set(identity, occurrence + 1);
        return (
          <li
            key={`${identity}:${occurrence}`}
            className="flex flex-wrap items-start justify-between gap-2 py-3"
          >
            <div className="min-w-0 flex-1">
              <p className="break-words font-medium">
                {host.state === "not_used"
                  ? `${unusedSettingLabel(host.item)} · not used on sandboxes`
                  : host.name}
                {host.item === null || host.state === "not_used"
                  ? null
                  : ` · ${host.item}`}
              </p>
              <p className="text-ui-xs text-muted-foreground">
                {host.state === "not_used" ? host.name : stateLabel(host.state)}
                {host.at === null ? null : ` · ${detailsTime(host.at)}`}
                {host.state === "not_used" || host.reason === null
                  ? null
                  : ` · ${host.reason}`}
              </p>
              {host.lastReportedAt === null ? null : (
                <p className="text-ui-xs text-muted-foreground">
                  Last reported {detailsTime(host.lastReportedAt)}
                </p>
              )}
            </div>
            <DetailsHostRecovery
              host={host}
              onRecover={props.onRecover}
              pending={props.pending}
            />
          </li>
        );
      })}
    </ul>
  );
}

function DetailsHostRecovery(props: {
  readonly host: DetailsHostStatus;
  readonly onRecover: (recovery: DetailsRecovery) => void;
  readonly pending: boolean;
}): ReactNode {
  const recovery = props.host.recovery;
  if (recovery === null) return null;
  if (recovery.kind === "apply")
    return (
      <SandboxRetryApplyingButton
        hostId={props.host.hostId}
        guestSetupFailed={recovery.guestSetupFailed}
      />
    );
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={props.pending}
      onClick={() => props.onRecover(recovery)}
    >
      {detailsRecoveryLabel(recovery, props.host.name)}
    </Button>
  );
}
