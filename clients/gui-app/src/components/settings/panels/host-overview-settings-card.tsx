import { useState, type ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { EnvironmentHostBinding } from "@traycer/protocol/host/environment/contracts";
import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import { OverviewCardDetailsLine } from "@/components/settings/details/overview-card-details-line";
import { MoveProgressLine } from "@/components/settings/move/move-progress-line";
import { StopSharingSession } from "@/components/settings/move/stop-sharing-session";
import { HOST_OVERVIEW } from "@/components/settings/panels/host-overview.definitions";
import { hostSettingsRowModel } from "@/components/settings/panels/host-overview-settings-card-model";
import { SettingsRow } from "@/components/settings/settings-row";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
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
        status={null}
        control={
          <Skeleton
            className="h-7 w-[40vw] max-w-full"
            role="status"
            aria-label="Reading"
          />
        }
      />
    );
  }
  if (model.kind === "team") {
    return (
      <SettingsRow
        row={HOST_OVERVIEW.definitions.settingsRow}
        status={model.description}
        control={<span className="text-ui-sm font-medium">{model.label}</span>}
      />
    );
  }
  const lineProps = {
    client: props.client,
    hostId: props.hostId,
    hostName: props.hostName,
    status: props.status,
  };
  if (model.kind === "progress") {
    return (
      <SettingsRow
        row={HOST_OVERVIEW.definitions.settingsRow}
        status={null}
        control={
          <div className="flex flex-wrap items-center gap-1 text-ui-sm">
            <MoveProgressLine {...lineProps} progress={model.progress} />
            {model.progress.kind === "move_stopped" ? (
              <OverviewCardDetailsLine {...lineProps} />
            ) : null}
          </div>
        }
      />
    );
  }
  return (
    <>
      <SettingsRow
        row={HOST_OVERVIEW.definitions.settingsRow}
        status={model.description}
        control={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <OverviewCardDetailsLine {...lineProps} />
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
                aria-label="Settings"
                className="max-w-full"
              >
                <SelectValue>
                  {
                    model.options.find((option) => option.value === model.value)
                      ?.label
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {model.options.map((option) => (
                  <SelectItem
                    key={option.value}
                    value={option.value}
                    textValue={option.label}
                  >
                    <div className="flex flex-col">
                      <span>{option.label}</span>
                      <span className="text-ui-xs text-muted-foreground">
                        {option.description}
                      </span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        }
      />
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

/** Unavailable reads hide the row; pending reads reserve its control. */
export function HostOverviewSettingsCardSlot(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
  readonly hostName: string;
  readonly usable: boolean;
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
    return null;
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
