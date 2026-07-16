import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";

export function ProgressToastIcon() {
  return (
    <AgentSpinningDots
      testId={undefined}
      variant="orbit"
      className="size-4 text-current"
    />
  );
}
