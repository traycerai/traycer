import type { ReactNode } from "react";
import { toast } from "sonner";
import type { HostNotificationSandboxNoticePayload } from "@traycer/protocol/host/notifications/contracts";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useSandboxPatch } from "@/hooks/sandboxes/use-sandbox-patch-mutation";
import { sandboxPeriodLabel } from "@/lib/sandboxes/sandbox-row-lines";
import { DETAILS, alreadyDestroyedLine } from "@/lib/sandboxes/sandbox-strings";

export const DISMISS = "Dismiss";

/**
 * The actions under a `sandbox.notice` row: on a resting warning,
 * `Give it another <period>` (the row's own resting period, a `PATCH` of it
 * that restarts the countdown, as the Sandboxes row's does); on every notice,
 * Details (Settings › Sandboxes with the row revealed despite any filter) and
 * Dismiss (clears the row).
 */
export function SandboxNoticeActions(props: {
  readonly notice: HostNotificationSandboxNoticePayload;
  readonly active: boolean;
  readonly onDetails: () => void;
  readonly onDismiss: () => void;
  readonly onExtended: () => void;
}): ReactNode {
  const warning =
    props.active && props.notice.notice.kind === "resting_warning" ? props.notice.notice : null;
  return (
    <div
      className="flex flex-wrap items-center gap-2"
      data-testid="sandbox-notice-actions"
    >
      {warning === null ? null : (
        <GiveItAnotherButton
          sandboxId={props.notice.sandboxId}
          sandboxName={props.notice.sandboxName}
          periodMinutes={warning.periodMinutes}
          onExtended={props.onExtended}
        />
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="sandbox-notice-details"
        onClick={props.onDetails}
      >
        {DETAILS}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-testid="sandbox-notice-dismiss"
        onClick={props.onDismiss}
      >
        {DISMISS}
      </Button>
    </div>
  );
}

function GiveItAnotherButton(props: {
  readonly sandboxId: string;
  readonly sandboxName: string;
  readonly periodMinutes: number;
  readonly onExtended: () => void;
}): ReactNode {
  const patch = useSandboxPatch(props.sandboxId);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={patch.isPending}
      data-testid="sandbox-notice-give-another"
      onClick={() =>
        patch.mutate(
          {
            displayName: null,
            idleMinutes: null,
            destroyAfterRestingMinutes: props.periodMinutes,
          },
          {
            onSuccess: (outcome) => {
              if (outcome === "gone") {
                toast.info(alreadyDestroyedLine(props.sandboxName));
              }
              props.onExtended();
            },
          },
        )
      }
    >
      {patch.isPending ? (
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
        />
      ) : null}
      {`Give it another ${sandboxPeriodLabel(props.periodMinutes)}`}
    </Button>
  );
}
