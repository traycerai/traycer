import { useState, type ReactNode } from "react";
import { OverviewCardDetailsLine } from "@/components/settings/details/overview-card-details-line";
import { useHostSettingsDetailsSubject } from "@/components/settings/details/use-host-settings-details-subject";
import { SettingsDetailsDialog } from "@/components/settings/details/settings-details-button";
import type { OverviewCardLineProps } from "@/components/settings/environment/overview-card-line-props";
import { moveStoppedText } from "@/components/settings/panels/host-overview-settings-card-model";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { environmentMutationKeys } from "@/lib/query-keys";

/** The move as the settings card's state says it: running, or stopped. */
export type MoveProgress =
  | {
      readonly kind: "moving";
      readonly applied: number;
      readonly total: number;
    }
  | {
      readonly kind: "move_stopped";
      readonly reason: string;
      readonly left: number;
    };

/**
 * The move while it runs, where a person is looking: the Overview's settings
 * card and the Local row's note. `Moving this computer's settings to
 * Personal · <n> of <m> items applied · Details` (no count while it has
 * registered no item); once it stalls or fails,
 * `Moving stopped: <reason>. <n> items left. · Retry · Export diagnostics`.
 * Retry starts the move again (`environment.setup.retry`), which applies
 * nothing twice.
 */
export function MoveProgressLine(
  props: OverviewCardLineProps & { readonly progress: MoveProgress },
): ReactNode {
  const { progress, ...lineProps } = props;
  if (progress.kind === "moving") {
    return (
      <div className="flex flex-wrap items-center gap-1">
        {/* No count until the move has registered an item: never `0 of 0`. */}
        <p data-testid="host-settings-card-progress">
          {progress.total === 0
            ? "Moving this computer's settings to Personal"
            : `Moving this computer's settings to Personal · ${String(progress.applied)} of ${String(progress.total)} items applied`}
        </p>
        <OverviewCardDetailsLine {...lineProps} />
      </div>
    );
  }
  return (
    <MoveStoppedLine
      {...lineProps}
      text={moveStoppedText(progress.reason, progress.left)}
    />
  );
}

function MoveStoppedLine(
  props: OverviewCardLineProps & { readonly text: string },
): ReactNode {
  const { text, ...lineProps } = props;
  const retryable =
    useHostMethodSupport(props.hostId, "environment.setup.retry") === true;
  const retry = useHostScopedMutationForClient(props.client, {
    method: "environment.setup.retry",
    mutationKey: environmentMutationKeys.setupRetry(),
    errorMessage: "Couldn't retry the move.",
    invalidateMethods: ["environment.status", "environment.setup.attempts"],
  });
  const subject = useHostSettingsDetailsSubject(lineProps);
  const [exportOpen, setExportOpen] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-1">
      <p
        className="text-warning-foreground"
        data-testid="host-settings-card-move-stopped"
      >
        {text}
      </p>
      {retryable ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={retry.isPending}
          onClick={() => retry.mutate({})}
        >
          Retry
          {retry.isPending ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
              tone="muted"
            />
          ) : null}
        </Button>
      ) : null}
      {subject === null ? null : (
        <>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setExportOpen(true)}
          >
            Export diagnostics
          </Button>
          <SettingsDetailsDialog
            subject={subject}
            title="Settings"
            controls={null}
            open={exportOpen}
            onOpenChange={setExportOpen}
            initialTab="export"
          />
        </>
      )}
    </div>
  );
}
