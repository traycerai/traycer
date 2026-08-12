import type { ReactNode } from "react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";

export function DiffHighlightLoading(props: {
  readonly testId: string;
}): ReactNode {
  return (
    <div className="flex min-h-24 items-center justify-center text-muted-foreground">
      <AgentSpinningDots
        className={undefined}
        testId={props.testId}
        variant={undefined}
      />
    </div>
  );
}
