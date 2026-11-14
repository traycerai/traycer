import type { ReactNode } from "react";
import type { SelectionIncompatibility } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { HostEnsureFailureMessage } from "@/components/host/host-ensure-failure-message";
import { useOlderHostUpdate } from "@/hooks/host/use-older-host-update";
import { useHostProvisioningProgress } from "@/hooks/host/use-host-provisioning-progress";
import { useReactiveLocalHostId } from "@/hooks/host/use-reactive-local-host-id";
import { getClientAppVersion } from "@/lib/app-version";
import { hostUpdateActionApplies } from "@/lib/host/window-narration";
import { HOST_UPDATE_SKEW_COPY } from "@/lib/host/version-skew-copy";
import { HostUpdateCheckInLine } from "@/components/settings/host-scope/host-registry-updates";

/** The same disconnected update action on the cover and in Settings. */
export function HostUpdateRequiredAction(props: {
  readonly hostId: string;
  readonly detail: SelectionIncompatibility;
  readonly testId: string;
}): ReactNode {
  const update = useOlderHostUpdate(props.hostId);
  const localHostId = useReactiveLocalHostId();
  const progress = useHostProvisioningProgress();
  if (!hostUpdateActionApplies(props.detail, getClientAppVersion()))
    return null;
  return (
    <div className="flex w-full flex-col items-start gap-2">
      <Button
        type="button"
        variant="default"
        size="sm"
        disabled={update.pending || update.remotePending}
        onClick={update.update}
        data-testid={props.testId}
      >
        {update.pending ? (
          <AgentSpinningDots
            className="mr-2 size-3"
            testId={undefined}
            variant={undefined}
          />
        ) : null}
        {HOST_UPDATE_SKEW_COPY.action}
      </Button>
      {props.hostId === localHostId && progress !== null ? (
        <p className="text-ui-sm text-muted-foreground" role="status">
          {progress.heading}
        </p>
      ) : null}
      {update.remotePending ? (
        <div role="status">
          <p className="text-ui-sm text-muted-foreground">Update pending</p>
          <HostUpdateCheckInLine />
        </div>
      ) : null}
      {update.failure === null ? null : (
        <HostEnsureFailureMessage
          message={update.failure.message}
          code={update.failure.code}
        />
      )}
    </div>
  );
}
