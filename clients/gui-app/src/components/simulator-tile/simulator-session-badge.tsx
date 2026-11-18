import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";

export function SimulatorSessionBadge(props: {
  readonly busy: boolean;
  readonly booted: boolean;
  readonly open: boolean;
}) {
  if (props.busy) {
    return (
      <AgentSpinningDots
        className="shrink-0"
        testId={undefined}
        variant={undefined}
        tone="muted"
      />
    );
  }
  if (props.open) {
    return (
      <Badge variant="info" size="xs" className="shrink-0">
        Open
      </Badge>
    );
  }
  if (!props.booted) return null;
  return (
    <Badge variant="success" size="xs" className="shrink-0">
      Running
    </Badge>
  );
}
