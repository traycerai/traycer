import { RefreshCw } from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { cn } from "@/lib/utils";

export function RefreshIcon(props: {
  readonly refreshing: boolean;
  readonly className?: string;
  readonly testId?: string;
}) {
  if (props.refreshing) {
    return (
      <AgentSpinningDots
        className={props.className}
        testId={props.testId}
        variant={undefined}
      />
    );
  }
  return (
    <RefreshCw
      aria-hidden
      className={cn("size-4", props.className)}
      data-testid={props.testId}
    />
  );
}
