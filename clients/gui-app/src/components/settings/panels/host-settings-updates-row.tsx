import { SettingsRow } from "@/components/settings/settings-row";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  formatCheckedAtTooltip,
  updatesDescription,
} from "@/components/settings/panels/host-settings-panel-model";
import type { HostRegistryUpdateState } from "@traycer-clients/shared/platform/runner-host";

interface UpdatesRowProps {
  readonly registryState: HostRegistryUpdateState | undefined;
  readonly registryFetching: boolean;
  readonly anyPending: boolean;
  readonly updatePending: boolean;
  readonly latestReleasedAt: string | null;
  readonly nowMs: number;
  readonly onUpdate: () => void;
  readonly onRefresh: () => void;
}

export function UpdatesRow(props: UpdatesRowProps) {
  const {
    registryState,
    registryFetching,
    anyPending,
    updatePending,
    latestReleasedAt,
    nowMs,
    onUpdate,
    onRefresh,
  } = props;
  return (
    <SettingsRow
      label="Updates"
      description={updatesDescription({
        registryState,
        registryFetching,
        latestReleasedAt,
        nowMs,
      })}
      control={
        <UpdatesControl
          registryState={registryState}
          registryFetching={registryFetching}
          anyPending={anyPending}
          updatePending={updatePending}
          onUpdate={onUpdate}
          onRefresh={onRefresh}
        />
      }
    />
  );
}

function UpdatesControl(props: {
  readonly registryState: HostRegistryUpdateState | undefined;
  readonly registryFetching: boolean;
  readonly anyPending: boolean;
  readonly updatePending: boolean;
  readonly onUpdate: () => void;
  readonly onRefresh: () => void;
}) {
  const {
    registryState,
    registryFetching,
    anyPending,
    updatePending,
    onUpdate,
    onRefresh,
  } = props;

  if (registryState !== undefined && registryState.updateAvailable) {
    return (
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="font-mono text-code-xs text-muted-foreground">
          v{registryState.latestVersion ?? "latest"}
        </span>
        <Button
          variant="default"
          size="sm"
          disabled={anyPending}
          onClick={onUpdate}
        >
          {updatePending ? (
            <AgentSpinningDots
              className="mr-2 size-3"
              testId={undefined}
              variant={undefined}
            />
          ) : null}
          Update
        </Button>
      </div>
    );
  }

  if (registryState !== undefined && !registryState.reachable) {
    return (
      <Button
        variant="secondary"
        size="sm"
        disabled={registryFetching}
        onClick={onRefresh}
      >
        {registryFetching ? (
          <AgentSpinningDots
            className="mr-2 size-3"
            testId={undefined}
            variant={undefined}
          />
        ) : null}
        Retry
      </Button>
    );
  }

  const tooltipLabel = formatCheckedAtTooltip(registryState?.checkedAt ?? null);
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <span className="text-ui-sm text-emerald-500">Up to date</span>
      <Button
        variant="ghost"
        size="sm"
        disabled={registryFetching}
        onClick={onRefresh}
        title={tooltipLabel}
      >
        {registryFetching ? (
          <AgentSpinningDots
            className="mr-2 size-3"
            testId={undefined}
            variant={undefined}
          />
        ) : null}
        Check now
      </Button>
    </div>
  );
}
