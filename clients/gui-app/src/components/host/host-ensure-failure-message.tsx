import type { ReactNode } from "react";
import {
  ENABLE_BACKGROUND_SERVICE_LABEL,
  SERVICE_REGISTRATION_DISABLED_CODE,
} from "@traycer-clients/shared/platform/host-service-notices";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useReactiveLocalHostEntry } from "@/hooks/host/use-reactive-local-host-entry";
import { useRunnerRegisterService } from "@/hooks/runner/use-runner-register-service-mutation";

/**
 * A failed ensure's message, verbatim, in a settled failure body. Clamped
 * because a CLI message can run long (a path, a nested cause), and selectable
 * with the whole text on hover, so the part the clamp hides can still be
 * copied into a search or a report.
 *
 * `code` is the CLI's code for that failure. A host that is down because its
 * Scheduled Task is disabled in Task Scheduler (`E_SERVICE_REGISTRATION_DISABLED`)
 * - by hand, or by its owner while an update was swapping the host - gets the
 * one repair that brings it back beside the message: Enable background
 * service, Doctor's Register service. Retry cannot: every ensure is refused on
 * the same disabled task.
 */
export function HostEnsureFailureMessage(props: {
  readonly message: string;
  readonly code: string | null;
}): ReactNode {
  return (
    <>
      <TooltipWrapper
        label={props.message}
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <p
          data-testid="host-ensure-failure-message"
          className="line-clamp-4 w-full text-ui-sm break-words text-muted-foreground select-text"
        >
          {props.message}
        </p>
      </TooltipWrapper>
      {props.code === SERVICE_REGISTRATION_DISABLED_CODE ? (
        <EnableBackgroundServiceButton />
      ) : null}
    </>
  );
}

/**
 * Registers THIS machine's host service, fenced to its host like every Doctor
 * repair; nothing while no local host is known to fence it to.
 */
function EnableBackgroundServiceButton(): ReactNode {
  const localHostId = useReactiveLocalHostEntry()?.hostId ?? null;
  const registerService = useRunnerRegisterService();
  if (localHostId === null) return null;
  return (
    <Button
      type="button"
      size="sm"
      variant="default"
      disabled={registerService.isPending}
      onClick={() => {
        registerService.mutate({ expectedHostId: localHostId });
      }}
      data-testid="host-ensure-failure-enable-service"
    >
      {registerService.isPending ? (
        <AgentSpinningDots
          className="mr-2 size-3"
          testId={undefined}
          variant={undefined}
        />
      ) : null}
      {ENABLE_BACKGROUND_SERVICE_LABEL}
    </Button>
  );
}
