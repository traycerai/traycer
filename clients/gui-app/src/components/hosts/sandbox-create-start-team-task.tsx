import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

/**
 * The team sandbox create's success state for someone with no task owned
 * by the team yet, offering "Start a <team> task". It opens a landing draft on
 * the new sandbox; no task is created until the person sends.
 */
export function SandboxCreateStartTeamTask(props: {
  readonly teamSlug: string;
  readonly onStart: () => void;
  readonly onDone: () => void;
}): ReactNode {
  return (
    <div
      className="flex flex-wrap items-center justify-end gap-2"
      data-testid="sandbox-create-start-team-task"
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-testid="sandbox-create-start-team-task-done"
        onClick={props.onDone}
      >
        Done
      </Button>
      <Button
        type="button"
        size="sm"
        data-testid="sandbox-create-start-team-task-start"
        onClick={props.onStart}
      >
        {`Start a ${props.teamSlug} task`}
      </Button>
    </div>
  );
}
