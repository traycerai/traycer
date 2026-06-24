import { type ReactNode } from "react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { cn } from "@/lib/utils";

interface EpicActivityStatusIconProps {
  readonly status: "running" | "waiting";
  readonly subjectId: string;
  readonly testIdPrefix: string;
  readonly className: string | undefined;
}

export function EpicActivityStatusIcon(
  props: EpicActivityStatusIconProps,
): ReactNode {
  const waiting = props.status === "waiting";
  const testStatus = waiting ? "waiting" : "activity";
  return (
    <span
      className={cn(
        "inline-flex size-3.5 shrink-0 items-center justify-center",
        props.className,
      )}
      title={
        waiting ? "Task waiting for your approval" : "Task activity in progress"
      }
    >
      <AgentSpinningDots
        className={waiting ? "text-red-500" : "text-current"}
        testId={`${props.testIdPrefix}-${testStatus}-${props.subjectId}`}
        variant={waiting ? "waiting" : undefined}
      />
    </span>
  );
}
