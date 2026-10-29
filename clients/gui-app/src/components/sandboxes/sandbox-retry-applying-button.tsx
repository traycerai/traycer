import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import {
  useSandboxRepairGuestConfigurationOnHost,
  useSandboxSettingsOperation,
  useSandboxRetryApplyingSupported,
  useSandboxGuestSetupRepairSupported,
  useSandboxRepairGuestSetupOnHost,
} from "@/hooks/sandboxes/use-sandbox-repair-guest-configuration-mutation";

/** Remains on the current surface and shares the named host's operation with its row. */
export function SandboxRetryApplyingButton(props: {
  readonly hostId: string;
  readonly guestSetupFailed: boolean | null;
}) {
  const apply = useSandboxRepairGuestConfigurationOnHost(props.hostId);
  const operation = useSandboxSettingsOperation(props.hostId);
  const supported = useSandboxRetryApplyingSupported(props.hostId);
  const guestRepairSupported = useSandboxGuestSetupRepairSupported(
    props.hostId,
  );
  const repair = useSandboxRepairGuestSetupOnHost(props.hostId);
  const legacy = guestRepairSupported && props.guestSetupFailed === true;
  const pending = supported
    ? apply.isPending || operation === "pending"
    : repair.isPending;
  if (!supported && !legacy) return null;
  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => {
          if (supported) apply.mutate({});
          else repair.mutate({});
        }}
      >
        {supported ? "Retry applying" : "Repair setup"}
        {pending ? (
          <AgentSpinningDots
            className={undefined}
            testId={undefined}
            variant={undefined}
          />
        ) : null}
      </Button>
      {supported && operation === "failed" ? (
        <p role="alert" className="text-ui-xs text-destructive">
          Settings still didn't apply · SBX-0520
        </p>
      ) : null}
    </div>
  );
}
