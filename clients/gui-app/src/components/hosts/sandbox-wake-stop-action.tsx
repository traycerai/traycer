import { useState, type ReactNode } from "react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { SandboxStopDialog } from "@/components/hosts/sandbox-confirm-dialogs";
import { Button } from "@/components/ui/button";
import { useSandboxOperation } from "@/hooks/sandboxes/use-sandbox-operation";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";

/**
 * Stop on an awake sandbox's wait for its host: the row bills from `awake`,
 * and a host that never reports bills until its idle period ends.
 */
export function SandboxWakeStopAction(props: {
  readonly sandbox: SandboxSummary;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const pending = useSandboxOperation(props.sandbox.id)?.kind === "pending";
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={pending}
        onClick={() => setOpen(true)}
      >
        {pending ? (
          <AgentSpinningDots
            className={undefined}
            testId={undefined}
            variant={undefined}
          />
        ) : null}
        Stop
      </Button>
      <SandboxStopDialog
        sandbox={props.sandbox}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
