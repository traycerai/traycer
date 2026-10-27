import type { ReactNode } from "react";

/**
 * Extra content for `environment.apply.failed`. Details is the chip drawer
 * (`kind: "chip", key: ""`).
 */
export function EnvironmentApplyFailedCard(props: {
  readonly hostName: string;
  readonly details: ReactNode;
}): ReactNode {
  return (
    <div
      className="flex flex-col gap-1.5 text-ui-xs"
      data-testid="environment-apply-failed-card"
    >
      <p data-testid="environment-apply-failed-body">
        {props.hostName}'s settings didn't apply.
      </p>
      {props.details}
    </div>
  );
}
