import { useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { OverviewCardDetailsLine } from "@/components/settings/details/overview-card-details-line";
import { useHostSettingsDetailsSubject } from "@/components/settings/details/use-host-settings-details-subject";
import { SettingsDetailsDialog } from "@/components/settings/details/settings-details-button";
import type { OverviewCardLineProps } from "@/components/settings/environment/overview-card-line-props";
import {
  MOVE_DIAGNOSTICS_FILE_NAME,
  moveDiagnosticsExport,
} from "@/components/settings/move/move-diagnostics-export";
import { useMoveRetryMutation } from "@/components/settings/move/use-move-rerun";
import {
  moveProgressText,
  moveStoppedText,
} from "@/components/settings/panels/host-overview-settings-card-model";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { readsHostBindingsFromPool } from "@/hooks/bots/use-host-environment-bindings-query";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { saveBlobToDisk } from "@/lib/files/save-blob-to-disk";
import type { HostRpcRegistry } from "@/lib/host";
import { environmentMutationKeys } from "@/lib/query-keys";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";

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
        <p data-testid="host-settings-card-progress">
          {moveProgressText(progress.applied, progress.total)}
        </p>
        <OverviewCardDetailsLine {...lineProps} currentStatus={null} />
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
  return (
    <div className="flex flex-wrap items-center gap-1">
      <p
        className="text-warning-foreground"
        data-testid="host-settings-card-move-stopped"
      >
        {text}
      </p>
      <MoveRetryButton
        client={props.client}
        hostId={props.hostId}
        variant="ghost"
      />
      <MoveExportDiagnosticsButton {...lineProps} />
    </div>
  );
}

/**
 * `Retry` on a stopped move: starts it again (`environment.setup.retry`),
 * which applies nothing twice; nothing on a host without that method.
 */
export function MoveRetryButton(props: {
  readonly client: HostClient<HostRpcRegistry>;
  readonly hostId: string;
  readonly variant: "default" | "ghost";
}): ReactNode {
  const retryable =
    useHostMethodSupport(props.hostId, "environment.setup.retry") === true;
  const retry = useMoveRetryMutation(props.client);
  if (!retryable) return null;
  return (
    <Button
      type="button"
      size="sm"
      variant={props.variant}
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
  );
}

/**
 * `Export diagnostics` on a stopped move: the host's settings Details at its
 * export tab. On a build that reads no binding from the pool, where none
 * answers for that host, its own move diagnostics, saved as a file.
 */
export function MoveExportDiagnosticsButton(
  props: OverviewCardLineProps,
): ReactNode {
  const subject = useHostSettingsDetailsSubject(props);
  const [exportOpen, setExportOpen] = useState(false);
  if (subject === null) {
    // A pool build reads every computer's binding: no subject there is a read
    // still out or failed, and the Details export stays the only one.
    return readsHostBindingsFromPool() ? null : (
      <MoveDiagnosticsSaveButton {...props} />
    );
  }
  return (
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
        currentStatus={null}
        subject={subject}
        title="Settings"
        controls={null}
        open={exportOpen}
        onOpenChange={setExportOpen}
        initialTab="export"
      />
    </>
  );
}

/** {@link moveDiagnosticsExport}, read at the click and saved as the Details export saves its file. */
function MoveDiagnosticsSaveButton(props: OverviewCardLineProps): ReactNode {
  const runner = useRunnerHostOrNull();
  const attemptsServed =
    useHostMethodSupport(props.hostId, "environment.setup.attempts") === true;
  const save = useMutation({
    mutationKey: environmentMutationKeys.moveDiagnosticsExport(),
    mutationFn: async () => {
      const attempts = attemptsServed
        ? (await props.client.request("environment.setup.attempts", {}))
            .attempts
        : null;
      const exported = moveDiagnosticsExport(
        props.status,
        attempts,
        Date.now(),
      );
      await saveBlobToDisk(
        new Blob([JSON.stringify(exported, null, 2)], {
          type: "application/json",
        }),
        MOVE_DIAGNOSTICS_FILE_NAME,
        runner?.fileSave ?? null,
      );
    },
  });
  // A failed save keeps its own words, as the Details export's does
  // (`details-drawer.tsx`'s alert line).
  const error: string | null = save.error?.message ?? null;
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={save.isPending}
        onClick={() => save.mutate()}
      >
        Export diagnostics
        {save.isPending ? (
          <AgentSpinningDots
            className={undefined}
            testId={undefined}
            variant={undefined}
            tone="muted"
          />
        ) : null}
      </Button>
      {error === null ? null : (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-x-2 gap-y-1"
        >
          <p className="text-warning-foreground">{error}</p>
        </div>
      )}
    </>
  );
}
