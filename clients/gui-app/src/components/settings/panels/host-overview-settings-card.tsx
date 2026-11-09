import { useEffect, useRef, useState, type ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { EnvironmentHostBinding } from "@traycer/protocol/host/environment/contracts";
import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import { LOCAL_BADGE_TOOLTIP } from "@/components/settings/environment/environment-picker-model";
import { OverviewCardDetailsLine } from "@/components/settings/details/overview-card-details-line";
import { MoveProgressLine } from "@/components/settings/move/move-progress-line";
import { StopSharingSession } from "@/components/settings/move/stop-sharing-session";
import {
  hostSettingsRowModel,
  type HostSettingsRowModel,
  type HostSettingsRowOption,
} from "@/components/settings/panels/host-overview-settings-card-model";
import { HOST_OVERVIEW } from "@/components/settings/panels/host-overview.definitions";
import { SettingsRow } from "@/components/settings/settings-row";
import { Badge } from "@/components/ui/badge";
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
import {
  environmentPickValue,
  PERSONAL_PICK,
  type EnvironmentPick,
} from "@/lib/settings-environment-pages";
import { useMoveSheetStore } from "@/stores/settings/move-sheet-store";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";

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
  const model = hostSettingsRowModel(
    props.status,
    props.binding,
    props.hostName,
  );
  const railPick =
    model.kind === "loading" || props.binding === null
      ? null
      : settingsRailPick(model, props.hostId, props.hostName, props.binding);
  useMatchEnvironmentRail(railPick);
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
        control={<FixedSettingsSource value={model.label} local={false} />}
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
              model.progress.kind === "moving" ? "Personal" : props.hostName
            }
            local={model.progress.kind === "move_stopped"}
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
            <EnvironmentSourceSelect
              value={model.value}
              options={model.options}
              onChoose={(option) => {
                if (option.action === "move") {
                  openMoveSheet({
                    hostId: props.hostId,
                    hostName: props.hostName,
                  });
                } else {
                  setStopOpen(true);
                }
              }}
            />
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
function FixedSettingsSource(props: {
  readonly value: string;
  readonly local: boolean;
}): ReactNode {
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
            aria-label="Environment"
            className="max-w-[40vw] sm:max-w-64"
          >
            <SelectValue />
          </SelectTrigger>
        </span>
      </TooltipWrapper>
      <SelectContent align="end">
        <SelectItem value={props.value}>
          <EnvironmentOptionLabel
            label={props.value}
            detail={null}
            local={props.local}
          />
        </SelectItem>
      </SelectContent>
    </Select>
  );
}

function EnvironmentSourceSelect(props: {
  readonly value: HostSettingsRowOption["value"];
  readonly options: readonly HostSettingsRowOption[];
  readonly onChoose: (option: HostSettingsRowOption) => void;
}): ReactNode {
  const current = props.options.find((option) => option.value === props.value);
  return (
    <Select
      value={props.value}
      onValueChange={(value) => {
        const option = props.options.find((item) => item.value === value);
        if (option === undefined || value === props.value) return;
        props.onChoose(option);
      }}
    >
      <TooltipWrapper
        label={current === undefined ? null : current.label}
        side="top"
        sideOffset={undefined}
        align="end"
      >
        <span className="max-w-full">
          <SelectTrigger
            size="sm"
            aria-label="Environment"
            className="max-w-[40vw] sm:max-w-64"
          >
            <SelectValue />
          </SelectTrigger>
        </span>
      </TooltipWrapper>
      <SelectContent align="end">
        {props.options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            <EnvironmentOptionLabel
              label={option.label}
              detail={option.detail}
              local={option.local}
            />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function EnvironmentOptionLabel(props: {
  readonly label: string;
  readonly detail: string | null;
  readonly local: boolean;
}): ReactNode {
  return (
    <span className="flex min-w-0 flex-col items-start gap-0.5">
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="truncate">{props.label}</span>
        {props.local ? (
          <TooltipWrapper
            label={LOCAL_BADGE_TOOLTIP}
            side="top"
            sideOffset={undefined}
            align={undefined}
          >
            <Badge variant="secondary" size="xs">
              Local
            </Badge>
          </TooltipWrapper>
        ) : null}
      </span>
      {props.detail === null ? null : (
        <span className="text-ui-xs text-muted-foreground in-data-[slot=select-trigger]:hidden">
          {props.detail}
        </span>
      )}
    </span>
  );
}

/**
 * The rail follows a resolved source. A loading row and a failed read pass
 * null and leave the dropdown where the person put it.
 */
function railFollowKey(pick: EnvironmentPick): string {
  if (pick.kind === "local") {
    return `${environmentPickValue(pick)}:${pick.hostName}`;
  }
  return environmentPickValue(pick);
}

/**
 * Writes the host's source into the rail once. A second write of the same
 * key is skipped, so a Local pick the dropdown drops (a host that needs an
 * update) is not put back on the next render.
 */
function useMatchEnvironmentRail(pick: EnvironmentPick | null): void {
  const setPick = useSettingsEnvironmentPickStore((state) => state.setPick);
  const current = useSettingsEnvironmentPickStore(
    (state) => state.pick ?? state.defaultPick,
  );
  const nextKey = pick === null ? null : railFollowKey(pick);
  const currentKey = railFollowKey(current);
  const held = useRef<string | null>(null);
  useEffect(() => {
    if (pick === null || nextKey === null) return;
    if (nextKey === currentKey) {
      held.current = null;
      return;
    }
    if (held.current === nextKey) return;
    held.current = nextKey;
    setPick(pick);
  }, [pick, nextKey, currentKey, setPick]);
}

function settingsRailPick(
  model: Exclude<HostSettingsRowModel, { kind: "loading" }>,
  hostId: string,
  hostName: string,
  binding: EnvironmentHostBinding,
): EnvironmentPick {
  if (model.kind === "team") {
    return {
      kind: "team",
      environmentId: binding.environment.environmentId,
    };
  }
  if (model.kind === "progress") {
    return model.progress.kind === "moving"
      ? PERSONAL_PICK
      : { kind: "local", hostId, hostName };
  }
  return model.value === "local"
    ? { kind: "local", hostId, hostName }
    : PERSONAL_PICK;
}

/** A failed read shows nothing. Pending reads reserve the control. */
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
