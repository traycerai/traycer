import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { AgentRow } from "@/hooks/agent/use-agent-stop-controls";

/**
 * Shown when the owner stops a chat that has active sub-agents it spawned.
 * Lets them either stop just this agent's turn or cascade the stop to the
 * whole delegated subtree. Only raised when at least one descendant is
 * actively working - a leaf chat stops with no prompt.
 */
export function StopChildrenDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly agents: ReadonlyArray<AgentRow>;
  readonly onStopAll: () => void;
  readonly onStopOnlyThis: () => void;
}) {
  const count = props.agents.length;
  const plural = count === 1 ? "" : "s";
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        className="w-full min-w-0 gap-0 overflow-hidden p-0"
        style={{ maxWidth: "min(92vw, 34rem)" }}
        showCloseButton={false}
        data-testid="stop-children-dialog"
      >
        <DialogHeader className="space-y-1 px-6 pt-6 pb-2">
          <DialogTitle className="text-base font-semibold">
            Also stop {count} sub-agent{plural}?
          </DialogTitle>
          <DialogDescription>
            This agent has {count} active sub-agent{plural} it started. Stop
            just this agent, or stop it and everything it delegated to?
          </DialogDescription>
        </DialogHeader>

        <ul className="m-0 flex max-h-[min(40vh,16rem)] list-none flex-col gap-0.5 overflow-y-auto px-6 py-2 chat-scrollbar-native-thin">
          {props.agents.map((agent) => (
            <li
              key={agent.id}
              className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-sm"
            >
              <span className="block min-w-0 flex-1 truncate text-foreground/85">
                {agent.title}
              </span>
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-ui-xs uppercase text-muted-foreground">
                {agent.surface}
              </span>
            </li>
          ))}
        </ul>

        <DialogFooter className="mx-0 mb-0 mt-2 gap-2 rounded-b-xl border-t border-border/40 bg-muted/10 px-6 py-4">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => props.onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={props.onStopOnlyThis}
            data-testid="stop-children-only-this"
          >
            Only this agent
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={props.onStopAll}
            data-testid="stop-children-stop-all"
          >
            Stop all
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
