import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useSubagentContinueAsChatAction } from "@/components/chat/segments/subagent-continue-as-chat";

/**
 * The control itself, wherever the open view draws it. Draws nothing where
 * the action is not offered.
 */
export function SubagentContinueAsChatButton(props: {
  readonly testId: string;
}) {
  const action = useSubagentContinueAsChatAction();
  if (action === null) return null;
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      disabled={action.isPending}
      onClick={action.run}
      data-testid={props.testId}
    >
      Continue as chat
      {action.isPending ? (
        <AgentSpinningDots
          className="ml-1"
          testId={`${props.testId}-pending`}
          variant={undefined}
        />
      ) : null}
    </Button>
  );
}
