import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import {
  useSandboxRepairGuestConfigurationOnHost,
  useSandboxSettingsOperation,
} from "@/hooks/sandboxes/use-sandbox-repair-guest-configuration-mutation";

/** Remains on the current surface and shares the named host's operation with its row. */
export function SandboxRetryApplyingButton(props: { readonly hostId: string }) {
  const apply = useSandboxRepairGuestConfigurationOnHost(props.hostId);
  const operation = useSandboxSettingsOperation(props.hostId);
  const pending = apply.isPending || operation === "pending";
  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => apply.mutate({})}
      >
        Retry applying
        {pending ? (
          <AgentSpinningDots
            className={undefined}
            testId={undefined}
            variant={undefined}
          />
        ) : null}
      </Button>
      {operation === "failed" ? (
        <p role="alert" className="text-ui-xs text-destructive">
          Settings still didn't apply · SBX-0520
        </p>
      ) : null}
    </div>
  );
}
