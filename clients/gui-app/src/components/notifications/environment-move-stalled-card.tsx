import type { ReactNode } from "react";
import {
  moveStalledBody,
  openHostOverviewLabel,
} from "@/components/settings/members/copy";
import { Button } from "@/components/ui/button";

/**
 * Extra content for `environment.move.stalled`. Details: `kind: "move",
 * key: hostId`. Open Overview is a separate jump to the host's Overview.
 */
export function EnvironmentMoveStalledCard(props: {
  readonly hostName: string;
  readonly remaining: number;
  readonly reason: string;
  readonly details: ReactNode;
  readonly onOpenHostOverview: (() => void) | null;
}): ReactNode {
  return (
    <div
      className="flex flex-col gap-1.5 text-ui-xs"
      data-testid="environment-move-stalled-card"
    >
      <p data-testid="environment-move-stalled-body">
        {moveStalledBody(props.hostName, props.remaining, props.reason)}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {props.details}
        {props.onOpenHostOverview === null ? null : (
          <Button
            type="button"
            variant="link"
            size="sm"
            onClick={props.onOpenHostOverview}
            data-testid="environment-move-stalled-overview"
          >
            {openHostOverviewLabel()}
          </Button>
        )}
      </div>
    </div>
  );
}
