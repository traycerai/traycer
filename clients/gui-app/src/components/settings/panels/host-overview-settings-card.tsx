import { useState, type ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { EnvironmentHostBinding } from "@traycer/protocol/host/environment/contracts";
import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import { OverviewCardDetailsLine } from "@/components/settings/details/overview-card-details-line";
import { MoveProgressLine } from "@/components/settings/move/move-progress-line";
import { StopSharingSession } from "@/components/settings/move/stop-sharing-session";
import { hostSettingsRowModel } from "@/components/settings/panels/host-overview-settings-card-model";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
      <div className="shrink-0 px-5 pb-3 text-ui-xs text-muted-foreground">
        Settings:{" "}
        <Skeleton
          className="inline-block h-4 w-[12ch]"
          role="status"
          aria-label="Reading"
        />
      </div>
    );
  }
  if (model.kind === "team") {
    return (
      <p className="shrink-0 px-5 pb-3 text-ui-xs text-muted-foreground">
        Settings: <span className="wrap-anywhere">{model.label}</span>
      </p>
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
      <div className="flex shrink-0 flex-wrap items-center gap-1 px-5 pb-3 text-ui-xs text-muted-foreground">
        <span>Settings:</span>
        <MoveProgressLine {...lineProps} progress={model.progress} />
        {model.progress.kind === "move_stopped" ? (
          <OverviewCardDetailsLine {...lineProps} />
        ) : null}
      </div>
    );
  }
  return (
    <>
      <div
        className="flex shrink-0 flex-wrap items-center gap-1 px-5 pb-3 text-ui-xs text-muted-foreground"
        data-testid="host-settings-source"
      >
        <span>
          Settings:{" "}
          {model.options.find((option) => option.value === model.value)?.label}
        </span>
        <span aria-hidden>·</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="link"
              size="inline"
              aria-label="Change settings source"
            >
              Change
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuRadioGroup
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
              {model.options.map((option) => (
                <DropdownMenuRadioItem key={option.value} value={option.value}>
                  <div className="flex flex-col">
                    <span>{option.label}</span>
                    <span className="text-ui-xs text-muted-foreground">
                      {option.description}
                    </span>
                  </div>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <OverviewCardDetailsLine {...lineProps} />
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

/** Unavailable reads hide the row; pending reads reserve its control. */
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
      <p className="shrink-0 px-5 pb-3 text-ui-xs text-muted-foreground">
        Settings: <span className="wrap-anywhere">{props.fallbackSource}</span>
      </p>
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
