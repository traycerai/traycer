import type { ReactNode } from "react";
import type { TaskSandboxEndedHost } from "@/hooks/epic/use-task-sandbox-end";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { taskSandboxEndLine } from "@/lib/sandboxes/task-sandbox-end";

/**
 * Details available to every reader of this task, without owner-only reads.
 * Reading no chat, they promise none.
 */
export function TaskSandboxEndDetails(props: {
  readonly ended: TaskSandboxEndedHost;
}): ReactNode {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant="ghost">
          Details
        </Button>
      </DialogTrigger>
      <DialogContent data-testid="task-sandbox-end-details">
        <DialogHeader>
          <DialogTitle>{props.ended.name}</DialogTitle>
          <DialogDescription>
            {taskSandboxEndLine(props.ended.name, props.ended.end, false)}
          </DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  );
}
