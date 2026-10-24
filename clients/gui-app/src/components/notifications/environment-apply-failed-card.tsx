import type { ReactNode } from "react";
import { applyFailedBody } from "@/components/settings/members/copy";

/**
 * Extra content for `environment.apply.failed`. Details is the chip drawer
 * (`kind: "chip", key: ""`).
 */
export function EnvironmentApplyFailedCard(props: {
  readonly hostName: string;
  readonly itemKey: string;
  readonly reason: string;
  readonly details: ReactNode;
}): ReactNode {
  return (
    <div
      className="flex flex-col gap-1.5 text-ui-xs"
      data-testid="environment-apply-failed-card"
    >
      <p data-testid="environment-apply-failed-body">
        {applyFailedBody(props.hostName, props.itemKey, props.reason)}
      </p>
      {props.details}
    </div>
  );
}
