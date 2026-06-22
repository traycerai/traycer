import type { ReactNode } from "react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import type { AgentSpinnerVariant } from "@/components/ui/agent-spinner-variant";
import { Card, CardContent } from "@/components/ui/card";

export interface CenteredCardProps {
  readonly message: string;
  readonly spinnerVariant: AgentSpinnerVariant | null;
  readonly testId: string | null;
}

/**
 * Full-viewport centered message card used by the app's pre-ready surfaces
 * (auth-session restore, "no host connected", host runtime init). Shared so the
 * `TraycerApp` shell and the routed `HostReadyGate` render an identical card.
 */
export function CenteredCard(props: CenteredCardProps): ReactNode {
  const containerProps =
    props.testId === null ? {} : { "data-testid": props.testId };
  return (
    <div
      {...containerProps}
      className="flex min-h-svh w-full items-center justify-center bg-background p-6 text-foreground"
    >
      <Card className="w-full max-w-sm">
        <CardContent className="flex flex-col items-center gap-4 py-6 text-center text-ui-sm">
          {props.spinnerVariant === null ? null : (
            <AgentSpinningDots
              testId="centered-card-agent-spinner"
              variant={props.spinnerVariant}
              className="text-muted-foreground"
            />
          )}
          <p>{props.message}</p>
        </CardContent>
      </Card>
    </div>
  );
}
