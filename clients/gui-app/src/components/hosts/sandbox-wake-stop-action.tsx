import { useState, type ReactNode } from "react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { SandboxStopDialog } from "@/components/hosts/sandbox-confirm-dialogs";
import { Button } from "@/components/ui/button";
import { useSandboxOperation } from "@/hooks/sandboxes/use-sandbox-operation";
import { useSandboxWakeReportStore } from "@/stores/sandboxes/sandbox-wake-report-store";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";

/**
 * Stop on an awake sandbox's wait for its host: the row bills from `awake`,
 * and a host that never reports bills until its idle period ends. A setup
 * line showing its own Stop for this sandbox keeps the one on screen.
 */
export function SandboxWakeStopAction(props: {
  readonly sandbox: SandboxSummary;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const pending = useSandboxOperation(props.sandbox.id)?.kind === "pending";
  const setupLineStops = useSandboxWakeReportStore(
    (state) => (state.setupStops[props.sandbox.id] ?? 0) > 0,
  );
  return (
    <>
      {setupLineStops ? null : (
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
      )}
      <SandboxStopDialog
        sandbox={props.sandbox}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
