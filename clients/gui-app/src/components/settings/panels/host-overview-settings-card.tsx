import { useState, type ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { EnvironmentHostBinding } from "@traycer/protocol/host/environment/contracts";
import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import { OverviewCardDetailsLine } from "@/components/settings/details/overview-card-details-line";
import { MoveProgressLine } from "@/components/settings/move/move-progress-line";
import { StopSharingSession } from "@/components/settings/move/stop-sharing-session";
import { hostSettingsRowModel } from "@/components/settings/panels/host-overview-settings-card-model";
import { HOST_OVERVIEW } from "@/components/settings/panels/host-overview.definitions";
import { SettingsRow } from "@/components/settings/settings-row";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useEnvironmentHostReadQuery } from "@/hooks/bots/use-environment-host-read-query";
import { readsHostBindingsFromPool } from "@/hooks/bots/use-host-environment-bindings-query";
import { useEnvironmentStatusRead } from "@/hooks/environment/use-environment-reads";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import type { HostRpcRegistry } from "@/lib/host";
import { useMoveSheetStore } from "@/stores/settings/move-sheet-store";

/** The named host's settings place, above the Overview's tabs. */
export function HostOverviewSettingsCard(props: {
  readonly client: HostClient<HostRpcRegistry>;
  readonly hostId: string;
  readonly hostName: string;
  readonly status: EnvironmentStatusResponseV11 | null;
  readonly binding: EnvironmentHostBinding | null;
}): ReactNode {
  const openMoveSheet = useMoveSheetStore((state) => state.openSheet);
  const [stopOpen, setStopOpen] = useState(false);
  const model = hostSettingsRowModel(props.status, props.binding);
  if (model.kind === "loading" || props.status === null) {
    return (
      <SettingsRow
        row={HOST_OVERVIEW.definitions.settingsRow}
        control={
          <Skeleton
            className="h-7 w-[18ch]"
            role="status"
            aria-label="Reading"
          />
        }
      />
    );
  }
  const lineProps = {
    client: props.client,
    hostId: props.hostId,
    hostName: props.hostName,
    status: props.status,
  };
  if (model.kind === "team") {
    return (
      <SettingsRow
        row={HOST_OVERVIEW.definitions.settingsRow}
        status={
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>{model.description}</span>
            <OverviewCardDetailsLine {...lineProps} />
          </div>
        }
        control={<FixedSettingsSource value={model.label} />}
      />
    );
  }
  if (model.kind === "progress") {
    return (
      <SettingsRow
        row={HOST_OVERVIEW.definitions.settingsRow}
        status={
          <div className="flex flex-wrap items-center gap-1">
            <MoveProgressLine {...lineProps} progress={model.progress} />
            {model.progress.kind === "move_stopped" ? (
              <OverviewCardDetailsLine {...lineProps} />
            ) : null}
          </div>
        }
        control={
          <FixedSettingsSource
            value={
              model.progress.kind === "moving"
                ? "Personal"
                : "This computer only"
            }
          />
        }
      />
    );
  }
  return (
    <>
      <div className="shrink-0" data-testid="host-settings-source">
        <SettingsRow
          row={HOST_OVERVIEW.definitions.settingsRow}
          status={
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span>{model.description}</span>
              <OverviewCardDetailsLine {...lineProps} />
            </div>
          }
          control={
            <Select
              value={model.value}
              onValueChange={(value) => {
                const option = model.options.find(
                  (item) => item.value === value,
                );
                if (option === undefined || value === model.value) return;
                if (option.action === "move") {
                  openMoveSheet({
                    hostId: props.hostId,
                    hostName: props.hostName,
                  });
                } else {
                  setStopOpen(true);
                }
              }}
            >
              <SelectTrigger
                size="sm"
                aria-label="Settings source"
                className="max-w-[40vw] sm:max-w-64"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {model.options.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
      </div>
      <StopSharingSession
        client={props.client}
        hostId={props.hostId}
        hostName={props.hostName}
        open={stopOpen}
        onOpenChange={setStopOpen}
      />
    </>
  );
}

/** Keep the settings value in the same control while it cannot be changed. */
function FixedSettingsSource(props: { readonly value: string }): ReactNode {
  return (
    <Select value={props.value} disabled>
      <TooltipWrapper
        label={props.value}
        side="top"
        sideOffset={undefined}
        align="end"
      >
        <span className="max-w-full">
          <SelectTrigger
            size="sm"
            aria-label="Settings source"
            className="max-w-[40vw] sm:max-w-64"
          >
            <SelectValue />
          </SelectTrigger>
        </span>
      </TooltipWrapper>
      <SelectContent align="end">
        <SelectItem value={props.value}>{props.value}</SelectItem>
      </SelectContent>
    </Select>
  );
}

/**
 * An unreachable sandbox's known source is the word Personal, or the team's
 * name. The name stays in the control; the sentence does not repeat it.
 */
function offlineSourceStatus(source: string): string {
  if (source === "Personal") return "Runs Personal settings.";
  return "Runs the team's settings.";
}

/** Unavailable reads retain a known source; pending reads reserve its control. */
export function HostOverviewSettingsCardSlot(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
  readonly hostName: string;
  readonly usable: boolean;
  readonly fallbackSource?: string | null;
}): ReactNode {
  const status = useEnvironmentStatusRead(
    props.client,
    props.hostId,
    props.usable,
  );
  const bindingSupport = useHostMethodSupport(
    props.hostId,
    readsHostBindingsFromPool()
      ? "environment.binding.read"
      : "environment.host.read",
  );
  const binding = useEnvironmentHostReadQuery(
    props.client,
    props.hostId,
    props.usable && bindingSupport === true,
  );
  if (
    !props.usable ||
    props.client === null ||
    props.hostId === null ||
    status.supported === false ||
    status.isError ||
    bindingSupport === false ||
    binding.isError
  ) {
    return props.fallbackSource === null ||
      props.fallbackSource === undefined ? null : (
      <SettingsRow
        row={HOST_OVERVIEW.definitions.settingsRow}
        status={offlineSourceStatus(props.fallbackSource)}
        control={<FixedSettingsSource value={props.fallbackSource} />}
      />
    );
  }
  return (
    <HostOverviewSettingsCard
      key={props.hostId}
      client={props.client}
      hostId={props.hostId}
      hostName={props.hostName}
      status={status.data}
      binding={binding.data ?? null}
    />
  );
}
