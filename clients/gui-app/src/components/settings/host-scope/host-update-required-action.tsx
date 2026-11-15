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
import {
  HOST_UPDATE_PENDING_LABEL,
  HOST_UPDATE_SKEW_COPY,
} from "@/lib/host/version-skew-copy";
import { HostUpdateCheckInLine } from "@/components/settings/host-scope/host-registry-updates";

/** The same disconnected update action on the cover and in Settings. */
export function HostUpdateRequiredAction(props: {
  readonly hostId: string;
  readonly detail: SelectionIncompatibility;
  readonly testId: string;
  readonly buttonVariant?: "default" | "outline";
}): ReactNode {
  const update = useOlderHostUpdate(props.hostId);
  const localHostId = useReactiveLocalHostId();
  const progress = useHostProvisioningProgress();
  if (!hostUpdateActionApplies(props.detail, getClientAppVersion()))
    return null;
  return (
    <div className="flex w-full flex-col items-start gap-2">
      {update.remotePending ? (
        <div role="status">
          <p className="text-ui-sm text-muted-foreground">
            {HOST_UPDATE_PENDING_LABEL}
          </p>
          <HostUpdateCheckInLine />
        </div>
      ) : (
        <Button
          type="button"
          variant={props.buttonVariant ?? "default"}
          size="sm"
          disabled={update.pending}
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
      )}
      {props.hostId === localHostId && progress !== null ? (
        <p className="text-ui-sm text-muted-foreground" role="status">
          {progress.heading}
        </p>
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
