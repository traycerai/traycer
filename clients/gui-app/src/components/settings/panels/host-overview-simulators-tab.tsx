/**
 * Docs: see ../SETTINGS.md (Host ▸ Overview ▸ Mobile simulators).
 * Update that file whenever this settings surface changes.
 */
import { useState, type ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  SimulatorInstalledTools,
  SimulatorPackState,
  SimulatorPlatformAvailability,
  SimulatorStatusResponse,
} from "@traycer/protocol/host/simulator/schemas";
import { UpdateProgressBar } from "@/components/host/update-progress-bar";
import { HOST_OVERVIEW } from "@/components/settings/panels/host-overview.definitions";
import { HostOverviewTabSections } from "@/components/settings/panels/host-overview-tabs";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsRow } from "@/components/settings/settings-row";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { Switch } from "@/components/ui/switch";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useHostNegotiatedMethodVersion } from "@/hooks/host/use-host-negotiated-method-version";
import {
  type GatedSimulatorMutation,
  useSimulatorConfigQuery,
  useSimulatorConfigSetMutation,
  useSimulatorRemoveToolsMutation,
  useSimulatorStatusQuery,
} from "@/hooks/simulator/use-simulator-mutations";
import type { HostRpcRegistry } from "@/lib/host";
import { formatHostProgressBytes } from "@/lib/host/host-progress-copy";
import { simulatorVerbsAreV11 } from "@/lib/simulator-view/simulator-host-version";
import {
  SimulatorIdleWindowRow,
  SimulatorRunningNowRow,
} from "./host-overview-simulator-instances";

/**
 * Overview ▸ Mobile simulators: the one switch of `config.simulator`, what
 * this host's machine can run, and the simulator tools' install there. The
 * page's host, like Ports: the client and the id are handed in by the panel.
 *
 * The switch gates the rest. Off: the switch alone, with the platform status
 * folded into its description, plus the tools row only while the tools are
 * still downloaded (so Remove stays reachable). On: Platforms and the tools
 * row. On every host, in every state: a host that does not advertise both
 * config methods gets one sentence in place of the switch, because a switch
 * whose every flip fails is worse than no switch.
 */
export function HostOverviewSimulatorsTab(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
  readonly hostName: string;
}): ReactNode {
  const getSupported = useHostMethodSupport(
    props.hostId,
    "config.simulator.get",
  );
  const setSupported = useHostMethodSupport(
    props.hostId,
    "config.simulator.set",
  );
  const supported =
    getSupported === null || setSupported === null
      ? null
      : getSupported && setSupported;
  return (
    <HostOverviewTabSections>
      <SettingsGroup
        group={HOST_OVERVIEW.definitions.mobileSimulators}
        showTitle={false}
        tone="default"
        dataTestId="host-overview-mobile-simulators"
        fill={false}
      >
        {supported === true ? (
          <SimulatorSettingsRows
            client={props.client}
            hostId={props.hostId}
            hostName={props.hostName}
          />
        ) : (
          <SettingsRow
            row={HOST_OVERVIEW.definitions.mobileSimulatorsEnabled}
            status={
              supported === null
                ? `Asking ${props.hostName} about mobile simulators.`
                : `${props.hostName} needs an update before it can run mobile simulators.`
            }
            control={null}
          />
        )}
      </SettingsGroup>
    </HostOverviewTabSections>
  );
}

/** Rendered only under a positive method check. */
function SimulatorSettingsRows(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
  readonly hostName: string;
}): ReactNode {
  const { client, hostId } = props;
  const config = useSimulatorConfigQuery(client, hostId);
  const status = useSimulatorStatusQuery(client, hostId);
  const statusSupported =
    useHostMethodSupport(hostId, "simulator.status") === true;
  const { mutation } = useSimulatorConfigSetMutation(client, hostId);
  const remove = useSimulatorRemoveToolsMutation(client, hostId);
  const switches = simulatorSwitch(config, mutation, remove.mutation.isPending);
  const installed = status.data?.installed ?? null;

  return (
    <>
      <SimulatorEnabledRow
        switches={switches}
        status={statusSupported ? (status.data ?? null) : null}
      />
      {/* Platforms only while on; the switch's description carries the
          platform status while off. The tools row while on, and while off
          only when there are bytes to remove. */}
      {statusSupported && switches.enabled ? (
        <SettingsRow
          row={HOST_OVERVIEW.definitions.simulatorPlatforms}
          status={status.isError ? "Couldn't ask this host." : undefined}
          control={null}
          details={
            status.data === undefined ? null : (
              <SimulatorPlatformList platforms={status.data.platforms} />
            )
          }
        />
      ) : null}
      {switches.enabled ? (
        <SimulatorInstanceRows
          client={client}
          hostId={hostId}
          idleMinutes={config.data?.idleMinutes ?? null}
          mutation={mutation}
        />
      ) : null}
      {statusSupported &&
      status.data !== undefined &&
      (switches.enabled || installed !== null) ? (
        <SimulatorToolsRow
          remove={remove}
          status={status.data}
          switches={switches}
          hostName={props.hostName}
        />
      ) : null}
    </>
  );
}

/**
 * Running now and the idle window, while the switch is on. Both exist on a
 * `@1.1` host only: a `@1.0` one has no instances and refuses the write that
 * leaves the switch alone.
 */
function SimulatorInstanceRows(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
  readonly idleMinutes: number | null;
  readonly mutation: GatedSimulatorMutation<"config.simulator.set">["mutation"];
}): ReactNode {
  const { client, hostId, idleMinutes, mutation } = props;
  const instancesSupported =
    useHostMethodSupport(hostId, "simulator.instances") === true;
  const idleWritable =
    simulatorVerbsAreV11(
      useHostNegotiatedMethodVersion(client, "config.simulator.set"),
    ) === true;
  return (
    <>
      {instancesSupported ? (
        <SimulatorRunningNowRow client={client} hostId={hostId} />
      ) : null}
      {idleWritable && idleMinutes !== null ? (
        <SimulatorIdleWindowRow
          idleMinutes={idleMinutes}
          writing={mutation.isPending}
          write={(minutes) =>
            mutation.mutate({ enabled: null, idleMinutes: minutes })
          }
        />
      ) : null}
    </>
  );
}

interface SimulatorSwitch {
  readonly enabled: boolean;
  readonly locked: boolean;
  readonly unreadable: boolean;
  readonly writing: boolean;
  readonly write: (next: { readonly enabled: boolean }) => void;
}

function simulatorSwitch(
  config: UseQueryResult<
    ResponseOfMethod<HostRpcRegistry, "config.simulator.get">,
    HostRpcError
  >,
  mutation: GatedSimulatorMutation<"config.simulator.set">["mutation"],
  removing: boolean,
): SimulatorSwitch {
  return {
    enabled: config.data?.enabled === true,
    // Unread, unreadable, mid-write or mid-removal: the switch cannot be
    // flipped. Turning it on while the tools are being removed would race the
    // removal for the same bytes.
    locked:
      config.isPending || config.isError || mutation.isPending || removing,
    unreadable: config.isError,
    writing: mutation.isPending,
    write: mutation.mutate,
  };
}

function SimulatorEnabledRow(props: {
  readonly switches: SimulatorSwitch;
  /** The host's status read, or null while it is unavailable or not advertised. */
  readonly status: SimulatorStatusResponse | null;
}): ReactNode {
  const { switches, status } = props;
  const row = HOST_OVERVIEW.definitions.mobileSimulatorsEnabled;
  const noPlatform = status?.packState.kind === "unsupported";
  // The definition always carries a description; the type allows null for
  // rows that have none.
  const rowDescription = row.description ?? "";
  let description: string;
  if (switches.unreadable) {
    description =
      "Couldn't read this host's mobile simulators setting. Repair Traycer's config.json on that computer, or back it up before resetting it, then reopen Settings.";
  } else if (!switches.enabled && status !== null) {
    // Off: the Platforms row is not drawn, so its answer rides here.
    description = `${rowDescription} ${platformSummary(status.platforms)}`;
  } else {
    description = rowDescription;
  }
  return (
    <SettingsRow
      row={row}
      status={description}
      control={
        <Switch
          checked={switches.enabled}
          // A machine that can run neither platform has nothing to turn on;
          // one already on can still be turned off.
          disabled={switches.locked || (noPlatform && !switches.enabled)}
          aria-label="Use mobile simulators"
          data-testid="settings-simulators-enabled"
          onCheckedChange={(next) => {
            switches.write({ enabled: next });
          }}
        />
      }
    />
  );
}

const PLATFORM_LABELS = { ios: "iOS", android: "Android" } as const;

/** "iOS available. Android: <reason>." for the switch's description while off. */
function platformSummary(
  platforms: readonly SimulatorPlatformAvailability[],
): string {
  return platforms
    .map((platform) => {
      const label = PLATFORM_LABELS[platform.platform];
      return platform.available
        ? `${label} available.`
        : `${label}: ${platform.reason ?? "not available on this host."}`;
    })
    .join(" ");
}

function SimulatorToolsRow(props: {
  readonly remove: GatedSimulatorMutation<"simulator.removeTools">;
  readonly status: SimulatorStatusResponse;
  readonly switches: SimulatorSwitch;
  readonly hostName: string;
}): ReactNode {
  const { status, switches } = props;
  const packState = status.packState;
  const installed = status.installed;
  const { remove } = props;
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  // Remove is offered only for bytes the switch no longer needs: off, with
  // the tools still in the host's store. On, and they are in use or about
  // to be; the host refuses either way, so the button is not drawn.
  const removable =
    remove.supported && packState.kind === "off" && installed !== null;
  return (
    <>
      <SettingsRow
        row={HOST_OVERVIEW.definitions.simulatorTools}
        status={
          <SimulatorToolsStatus
            packState={packState}
            packVersion={status.packVersion}
            installed={installed}
            hostName={props.hostName}
          />
        }
        control={
          <SimulatorToolsControl
            packState={packState}
            removable={removable}
            removing={remove.mutation.isPending}
            switches={switches}
            onRemove={() => {
              setConfirmingRemove(true);
            }}
          />
        }
      />
      <ConfirmDestructiveDialog
        open={confirmingRemove}
        onOpenChange={setConfirmingRemove}
        title="Remove simulator tools?"
        description={`Remove the simulator tools from ${props.hostName}? Turning mobile simulators on downloads them again.`}
        // Nothing is nested under the tools; the cascade slot is for rows
        // with descendants.
        cascadeSummary={null}
        actionLabel="Remove"
        isPending={remove.mutation.isPending}
        blockedReason={null}
        onConfirm={() => {
          // The row's button carries the pending state; a refusal toasts
          // from the hook, and the status read is asked again either way.
          setConfirmingRemove(false);
          remove.mutation.mutate({});
        }}
      />
    </>
  );
}

/**
 * The Simulator tools row's one action: Try again after a failed install,
 * Remove for downloaded tools the switch no longer needs, nothing otherwise.
 */
function SimulatorToolsControl(props: {
  readonly packState: SimulatorPackState;
  readonly removable: boolean;
  readonly removing: boolean;
  readonly switches: SimulatorSwitch;
  readonly onRemove: () => void;
}): ReactNode {
  const { switches } = props;
  if (props.packState.kind === "failed") {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={switches.locked}
        data-testid="settings-simulators-retry"
        // Re-asserting the switch is the install's retry: the host
        // converges the tools again on every `enabled: true`.
        onClick={() => switches.write({ enabled: true })}
      >
        {switches.writing ? (
          <AgentSpinningDots
            className={undefined}
            testId={undefined}
            variant={undefined}
          />
        ) : null}
        Try again
      </Button>
    );
  }
  if (!props.removable) return null;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={switches.locked || props.removing}
      data-testid="settings-simulators-remove-tools"
      onClick={props.onRemove}
    >
      {props.removing ? (
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
        />
      ) : null}
      Remove
    </Button>
  );
}

function SimulatorPlatformList(props: {
  readonly platforms: readonly SimulatorPlatformAvailability[];
}): ReactNode {
  return (
    <ul className="flex w-full flex-col gap-1.5" aria-label="Platforms">
      {props.platforms.map((platform) => (
        <li
          key={platform.platform}
          className="flex min-w-0 items-start gap-2 text-ui-sm"
          data-testid={`settings-simulator-platform-${platform.platform}`}
        >
          <Badge variant="muted" size="xs" className="mt-0.5 shrink-0">
            {PLATFORM_LABELS[platform.platform]}
          </Badge>
          {platform.available ? (
            <span className="text-foreground">Available</span>
          ) : (
            <span className="min-w-0 text-muted-foreground">
              {platform.reason ?? "Not available on this host."}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** One sentence (and, while downloading, a bar) per pack state. */
function SimulatorToolsStatus(props: {
  readonly packState: SimulatorPackState;
  readonly packVersion: string | null;
  /** What the host's store still holds, whatever the switch says. */
  readonly installed: SimulatorInstalledTools | null;
  readonly hostName: string;
}): ReactNode {
  const { packState } = props;
  switch (packState.kind) {
    case "off":
      return props.installed === null ? (
        <span data-testid="settings-simulator-tools-off">
          Not downloaded. Turning mobile simulators on downloads them to{" "}
          {props.hostName}.
        </span>
      ) : (
        <span data-testid="settings-simulator-tools-downloaded">
          Downloaded, {formatHostProgressBytes(props.installed.sizeBytes)}.
          Mobile simulators are off.
        </span>
      );
    case "installing": {
      const percent =
        packState.progress === null
          ? null
          : Math.round(packState.progress * 100);
      return (
        <span
          className="flex w-full flex-col gap-1.5"
          data-testid="settings-simulator-tools-installing"
        >
          <span>
            {percent === null
              ? "Downloading."
              : `Downloading, ${String(percent)}% done.`}
          </span>
          <UpdateProgressBar
            percent={percent}
            label={`Simulator tools download on ${props.hostName}`}
            className={undefined}
          />
        </span>
      );
    }
    case "ready":
      return (
        <span
          className="flex flex-wrap items-center gap-2"
          data-testid="settings-simulator-tools-ready"
        >
          <span>Installed.</span>
          {props.packVersion === null ? null : (
            <Badge variant="muted" size="xs">
              {props.packVersion}
            </Badge>
          )}
        </span>
      );
    case "failed":
      return (
        <span
          className="text-destructive"
          data-testid="settings-simulator-tools-failed"
        >
          {packState.reason ?? "The download failed."}
        </span>
      );
    case "unsupported":
      return (
        <span data-testid="settings-simulator-tools-unsupported">
          Not needed: this host can't run either platform.
        </span>
      );
  }
}
