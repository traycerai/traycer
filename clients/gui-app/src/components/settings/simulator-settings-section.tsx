import type { ReactNode } from "react";
import type {
  SimulatorPackState,
  SimulatorPlatformAvailability,
  SimulatorStatusResponse,
} from "@traycer/protocol/host/simulator/schemas";
import { UpdateProgressBar } from "@/components/host/update-progress-bar";
import { BROWSER } from "@/components/settings/panels/browser-settings.definitions";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsRow } from "@/components/settings/settings-row";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import {
  useSimulatorConfigQuery,
  useSimulatorConfigSetMutation,
  useSimulatorStatusQuery,
} from "@/hooks/simulator/use-simulator-mutations";
import { useHostClient } from "@/lib/host";

/**
 * Settings > Browser > Simulators: the two switches of `config.simulator`,
 * what this host's machine can run, and the simulator tools' install there.
 *
 * The ACTIVE host, like the agent-access rows beside it: Browser carries no
 * host scope of its own, so the switches are about the machine the app is
 * using, and the copy names it.
 *
 * The group renders only once the host advertises both config methods, the
 * same rule as agent browser access: a switch whose every flip fails is
 * worse than no switch.
 */
export function SimulatorSettingsGroup(props: {
  readonly hostId: string | null;
}): ReactNode {
  const getSupported = useHostMethodSupport(
    props.hostId,
    "config.simulator.get",
  );
  const setSupported = useHostMethodSupport(
    props.hostId,
    "config.simulator.set",
  );
  if (getSupported !== true || setSupported !== true) return null;
  return <SimulatorSettingsRows hostId={props.hostId} />;
}

/**
 * Rendered only under a positive method check, which is what makes
 * `useHostClient()` safe here: a host that advertised the methods has a
 * binding.
 */
function SimulatorSettingsRows(props: {
  readonly hostId: string | null;
}): ReactNode {
  const { hostId } = props;
  const client = useHostClient();
  const entryLabel = useHostDirectoryEntry(hostId)?.label.trim() ?? "";
  const hostName = entryLabel.length > 0 ? entryLabel : (hostId ?? "this host");
  const config = useSimulatorConfigQuery(client, hostId);
  const status = useSimulatorStatusQuery(client, hostId);
  const statusSupported =
    useHostMethodSupport(hostId, "simulator.status") === true;
  const { mutation } = useSimulatorConfigSetMutation(client, hostId);
  const switches: SimulatorSwitches = {
    enabled: config.data?.enabled === true,
    agentAccess: config.data?.agentAccess === true,
    // Unread, unreadable or mid-write: neither switch can be flipped.
    locked: config.isPending || config.isError || mutation.isPending,
    unreadable: config.isError,
    writing: mutation.isPending,
    write: mutation.mutate,
  };
  return (
    <SettingsGroup
      group={BROWSER.definitions.simulators}
      showTitle
      tone="default"
      dataTestId="settings-browser-simulators"
      fill={false}
    >
      <SimulatorEnabledRow
        switches={switches}
        hostName={hostName}
        noPlatform={status.data?.packState.kind === "unsupported"}
      />
      <SimulatorAgentAccessRow switches={switches} />
      {statusSupported ? (
        <SimulatorStatusRows
          status={status.data ?? null}
          statusUnreadable={status.isError}
          switches={switches}
          hostName={hostName}
        />
      ) : null}
    </SettingsGroup>
  );
}

interface SimulatorSwitches {
  readonly enabled: boolean;
  readonly agentAccess: boolean;
  readonly locked: boolean;
  readonly unreadable: boolean;
  readonly writing: boolean;
  /** Both switches travel on every write; the host keeps no implicit default. */
  readonly write: (next: {
    readonly enabled: boolean;
    readonly agentAccess: boolean;
  }) => void;
}

function SimulatorEnabledRow(props: {
  readonly switches: SimulatorSwitches;
  readonly hostName: string;
  readonly noPlatform: boolean;
}): ReactNode {
  const { switches } = props;
  return (
    <SettingsRow
      row={BROWSER.definitions.simulatorsEnabled}
      status={
        switches.unreadable
          ? "Couldn't read this host's simulator setting. Repair Traycer's config.json on that machine, or back it up before resetting it, then reopen Settings."
          : `On ${props.hostName}. ${BROWSER.definitions.simulatorsEnabled.description}`
      }
      control={
        <Switch
          checked={switches.enabled}
          // A machine that can run neither platform has nothing to turn on;
          // one already on can still be turned off.
          disabled={switches.locked || (props.noPlatform && !switches.enabled)}
          aria-label="Use simulators"
          data-testid="settings-simulators-enabled"
          onCheckedChange={(next) => {
            // Turning simulators off withdraws agent access too, which the
            // host refuses to keep without them.
            switches.write({
              enabled: next,
              agentAccess: next ? switches.agentAccess : false,
            });
          }}
        />
      }
    />
  );
}

function SimulatorAgentAccessRow(props: {
  readonly switches: SimulatorSwitches;
}): ReactNode {
  const { switches } = props;
  return (
    <SettingsRow
      row={BROWSER.definitions.simulatorAgentAccess}
      status={
        switches.enabled ? undefined : "Turn on Use simulators to allow this."
      }
      control={
        <Switch
          checked={switches.agentAccess}
          disabled={!switches.enabled || switches.locked}
          aria-label="Let agents drive simulators"
          data-testid="settings-simulators-agent-access"
          onCheckedChange={(next) => {
            switches.write({ enabled: true, agentAccess: next });
          }}
        />
      }
    />
  );
}

function SimulatorStatusRows(props: {
  readonly status: SimulatorStatusResponse | null;
  readonly statusUnreadable: boolean;
  readonly switches: SimulatorSwitches;
  readonly hostName: string;
}): ReactNode {
  const { status, switches } = props;
  const packState = status?.packState ?? null;
  return (
    <>
      <SettingsRow
        row={BROWSER.definitions.simulatorPlatforms}
        status={props.statusUnreadable ? "Couldn't ask this host." : undefined}
        control={null}
        details={
          status === null ? null : (
            <SimulatorPlatformList platforms={status.platforms} />
          )
        }
      />
      <SettingsRow
        row={BROWSER.definitions.simulatorTools}
        status={
          status === null || packState === null ? undefined : (
            <SimulatorToolsStatus
              packState={packState}
              packVersion={status.packVersion}
              hostName={props.hostName}
            />
          )
        }
        control={
          packState?.kind === "failed" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={switches.locked}
              data-testid="settings-simulators-retry"
              // Re-asserting the switch is the install's retry: the host
              // converges the tools again on every `enabled: true`.
              onClick={() =>
                switches.write({
                  enabled: true,
                  agentAccess: switches.agentAccess,
                })
              }
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
          ) : null
        }
      />
    </>
  );
}

const PLATFORM_LABELS = { ios: "iOS", android: "Android" } as const;

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
  readonly hostName: string;
}): ReactNode {
  const { packState } = props;
  switch (packState.kind) {
    case "off":
      return (
        <span data-testid="settings-simulator-tools-off">
          Not downloaded. Turning simulators on downloads them to{" "}
          {props.hostName}.
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
