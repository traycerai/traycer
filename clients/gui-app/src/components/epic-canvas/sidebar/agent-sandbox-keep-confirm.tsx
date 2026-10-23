import { useState, type ReactNode } from "react";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSandboxKeep } from "@/hooks/sandboxes/use-sandbox-keep-mutation";
import {
  alreadyDestroyedLine,
  KEEP_THIS_SANDBOX,
  KEEP_STOPS_DELETING,
} from "@/lib/sandboxes/sandbox-strings";

export function AgentSandboxKeepConfirm(props: {
  readonly sandbox: SandboxSummary;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): ReactNode {
  const keep = useSandboxKeep(props.sandbox.id);
  const [gone, setGone] = useState(false);
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{KEEP_THIS_SANDBOX}</DialogTitle>
          <DialogDescription>{KEEP_STOPS_DELETING}</DialogDescription>
        </DialogHeader>
        {gone ? (
          <p className="text-ui-sm">
            {alreadyDestroyedLine(props.sandbox.displayName)}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            disabled={keep.isPending || gone}
            onClick={() => {
              keep.mutate(undefined, {
                onSuccess: (outcome) => {
                  if (outcome === "gone") setGone(true);
                  else props.onOpenChange(false);
                },
              });
            }}
          >
            {keep.isPending ? (
              <AgentSpinningDots
                className={undefined}
                testId={undefined}
                variant={undefined}
              />
            ) : null}
            {KEEP_THIS_SANDBOX}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
