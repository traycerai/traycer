import type { ReactNode } from "react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { HostOverviewNotice } from "@/components/settings/panels/host-overview-status-card";
import {
  describeCliShellFailure,
  describeOverviewDegrade,
  type OverviewDegradeReason,
} from "@/components/settings/panels/host-overview-model";
import type { HostOverviewUpdatesSummary } from "@/components/settings/panels/host-overview-updates-state";
import { SETTINGS_ROW_STACK } from "@/components/settings/settings-row-layout";
import { cn } from "@/lib/utils";

/**
 * The card body's whole update surface: one sentence and up to two buttons.
 *
 * This is what the released layout got right and the restructure lost — the
 * answer in the card, the decisions behind a disclosure. Update now is primary
 * and appears only when there is a newer version to move to; Check now is quiet
 * and always available.
 */
export function HostOverviewUpdatesRegion(props: {
  readonly summary: HostOverviewUpdatesSummary;
  readonly degrade: OverviewDegradeReason | null;
}): ReactNode {
  const { summary } = props;
  if (props.degrade !== null) {
    return (
      <HostOverviewNotice testId="host-overview-updates-degraded">
        {describeOverviewDegrade(props.degrade, summary.hostName)}
      </HostOverviewNotice>
    );
  }
  return (
    <div
      className="flex flex-col border-t border-border/40"
      data-testid="host-overview-updates"
    >
      <div
        className={cn(
          "flex flex-wrap items-center justify-between gap-3 px-5 py-2.5 text-ui-sm",
          SETTINGS_ROW_STACK.container,
        )}
      >
        {/* `role="status"`: the check runs on its own now, so this sentence
            changes with no user action to anchor it — a live region is the
            only way a screen-reader user learns a check started or failed. */}
        <span
          role="status"
          className={cn(
            "min-w-0 flex-1 text-muted-foreground",
            SETTINGS_ROW_STACK.label,
          )}
        >
          {summary.description}
        </span>
        <div
          className={cn(
            "flex flex-wrap items-center justify-end gap-2",
            SETTINGS_ROW_STACK.control,
          )}
        >
          {summary.updatableVersion === null ? null : (
            <Button
              type="button"
              variant="default"
              size="sm"
              disabled={summary.busy || summary.installing || summary.checking}
              data-testid="host-overview-update-now"
              onClick={summary.onUpdateLatest}
            >
              {summary.installing ? (
                <AgentSpinningDots
                  className="mr-2 size-3"
                  testId={undefined}
                  variant={undefined}
                />
              ) : null}
              Update now
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={summary.checking || summary.busy}
            data-testid="host-overview-update-check"
            onClick={summary.onCheck}
          >
            {summary.checking ? (
              <AgentSpinningDots
                className="mr-2 size-3"
                testId={undefined}
                variant={undefined}
              />
            ) : null}
            Check now
          </Button>
        </div>
      </div>
      {summary.transientFailure === null ? null : (
        <HostOverviewNotice testId="host-overview-update-attempt-failed">
          {describeCliShellFailure(summary.transientFailure, summary.hostName)}
        </HostOverviewNotice>
      )}
    </div>
  );
}
