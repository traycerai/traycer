import type { ReactNode } from "react";
import { Smartphone, TriangleAlert } from "lucide-react";
import type {
  SimulatorPlatformAvailability,
  SimulatorSummary,
} from "@traycer/protocol/host/simulator/schemas";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { SimulatorSessionBadge } from "@/components/simulator-tile/simulator-session-badge";
import { UpdateProgressBar } from "@/components/host/update-progress-bar";
import { simulatorVersionLabel } from "@/lib/simulator-view/simulator-labels";
import { orderSimulators } from "@/lib/simulator-view/simulator-sessions-coordinator";
import { cn } from "@/lib/utils";

/**
 * The tile's non-streaming states. Each says what is true on the host the
 * tile is bound to and what the person can do about it; none names the
 * pieces the host installs or the way the video travels.
 */

function SimulatorStateFrame(props: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly children: ReactNode;
  readonly testId: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid={props.testId}
      className="flex h-full min-h-0 w-full flex-col items-center justify-center gap-4 bg-canvas px-6 py-8 text-center text-ui-sm text-muted-foreground"
    >
      {props.icon}
      <div className="flex w-full max-w-md flex-col items-center gap-2">
        <p className="text-ui-base font-medium text-foreground">
          {props.title}
        </p>
        {props.children}
      </div>
    </div>
  );
}

export function SimulatorHostUnreachableView(props: {
  readonly hostLabel: string;
}) {
  return (
    <SimulatorStateFrame
      icon={
        <Smartphone className="size-8 text-muted-foreground/45" aria-hidden />
      }
      title={props.hostLabel}
      testId="simulator-host-unreachable"
    >
      <p>Host is unreachable. This tile will reconnect on its own.</p>
    </SimulatorStateFrame>
  );
}

export function SimulatorLoadingView(props: { readonly hostLabel: string }) {
  return (
    <SimulatorStateFrame
      icon={
        <AgentSpinningDots
          className="shrink-0"
          testId={undefined}
          variant={undefined}
          tone="muted"
        />
      }
      title={`Asking ${props.hostLabel} about its simulators`}
      testId="simulator-loading"
    >
      {null}
    </SimulatorStateFrame>
  );
}

/**
 * The host cannot run simulators at all, or cannot show them to this app.
 * One line per platform with the host's own reason, so the person knows
 * which toolchain the machine is missing.
 */
export function SimulatorUnavailableView(props: {
  readonly hostLabel: string;
  readonly platforms: readonly SimulatorPlatformAvailability[];
  /** The pack's own reason when it, rather than a platform, is what is missing. */
  readonly reason: string | null;
}) {
  const reasons = props.platforms.filter(
    (platform) => !platform.available && platform.reason !== null,
  );
  return (
    <SimulatorStateFrame
      icon={<TriangleAlert className="size-8 text-warning" aria-hidden />}
      title={`${props.hostLabel} can't run simulators`}
      testId="simulator-unavailable"
    >
      {props.reason === null ? null : <p>{props.reason}</p>}
      {reasons.length === 0 ? null : (
        <ul className="w-full space-y-1 text-left" aria-label="Why">
          {reasons.map((platform) => (
            <li
              key={platform.platform}
              className="flex items-start gap-2 rounded-md border border-border/60 px-3 py-2"
              data-testid={`simulator-platform-reason-${platform.platform}`}
            >
              <Badge variant="muted" size="xs" className="mt-0.5 shrink-0">
                {platform.platform === "ios" ? "iOS" : "Android"}
              </Badge>
              <span className="min-w-0 text-foreground/80">
                {platform.reason}
              </span>
            </li>
          ))}
        </ul>
      )}
    </SimulatorStateFrame>
  );
}

/**
 * Mobile simulators are off on this host. The switch is the one the Host
 * panel carries too: turning it on downloads the simulator tools to THIS host
 * and starts them there; nothing is installed on any other machine.
 */
export function SimulatorSetupView(props: {
  readonly hostLabel: string;
  readonly platforms: readonly SimulatorPlatformAvailability[];
  readonly enabled: boolean;
  readonly pending: boolean;
  /** `null` when this host does not offer the switch (an older host). */
  readonly onEnabledChange: ((enabled: boolean) => void) | null;
}) {
  const available = props.platforms
    .filter((platform) => platform.available)
    .map((platform) => (platform.platform === "ios" ? "iOS" : "Android"));
  const canRun =
    available.length === 0
      ? "simulators"
      : `${available.join(" and ")} simulators`;
  return (
    <SimulatorStateFrame
      icon={
        <Smartphone className="size-8 text-muted-foreground/45" aria-hidden />
      }
      title={`Mobile simulators are off on ${props.hostLabel}`}
      testId="simulator-setup"
    >
      <p>
        Turn them on to run {canRun} on that computer and work with them here.
        The first time, {props.hostLabel} downloads the simulator tools (under
        60 MB) and keeps them until you remove them in the Host panel.
      </p>
      <label
        className={cn(
          "mt-2 flex items-center gap-3 rounded-md border border-border px-3 py-2 text-foreground",
          props.onEnabledChange === null && "opacity-60",
        )}
      >
        <Switch
          checked={props.enabled}
          disabled={props.onEnabledChange === null || props.pending}
          aria-label="Mobile simulators"
          data-testid="simulator-enable-switch"
          onCheckedChange={(checked) => props.onEnabledChange?.(checked)}
        />
        <span>Mobile simulators on {props.hostLabel}</span>
        {props.pending ? (
          <AgentSpinningDots
            className="shrink-0"
            testId={undefined}
            variant={undefined}
            tone="muted"
          />
        ) : null}
      </label>
      {props.onEnabledChange === null ? (
        <p className="text-ui-xs">
          This host needs an update before it can turn mobile simulators on.
        </p>
      ) : null}
    </SimulatorStateFrame>
  );
}

export function SimulatorInstallingView(props: {
  readonly hostLabel: string;
  /** Download progress in [0, 1], or null while the host has not measured it. */
  readonly progress: number | null;
}) {
  const percent =
    props.progress === null ? null : Math.round(props.progress * 100);
  return (
    <SimulatorStateFrame
      icon={
        <AgentSpinningDots
          className="shrink-0"
          testId={undefined}
          variant={undefined}
          tone="muted"
        />
      }
      title={`Setting up mobile simulators on ${props.hostLabel}`}
      testId="simulator-installing"
    >
      <p>
        {percent === null
          ? "Downloading the simulator tools."
          : `Downloading the simulator tools, ${String(percent)}% done.`}
      </p>
      <UpdateProgressBar
        percent={percent}
        label={`Simulator tools download on ${props.hostLabel}`}
        className="mt-1"
      />
    </SimulatorStateFrame>
  );
}

export function SimulatorFailedView(props: {
  readonly title: string;
  readonly reason: string | null;
  readonly onRetry: (() => void) | null;
}) {
  return (
    <SimulatorStateFrame
      icon={
        <TriangleAlert className="size-8 text-destructive/70" aria-hidden />
      }
      title={props.title}
      testId="simulator-failed"
    >
      {props.reason === null ? null : (
        <p className="break-words text-foreground/80">{props.reason}</p>
      )}
      {props.onRetry === null ? null : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={props.onRetry}
        >
          Try again
        </Button>
      )}
    </SimulatorStateFrame>
  );
}

/**
 * The host's simulators when this tile's own is not open in the task yet:
 * the row for this tile's simulator connects (booting it when it is cold),
 * every other row opens a tile of its own.
 */
export function SimulatorInventoryView(props: {
  readonly hostLabel: string;
  readonly simulators: readonly SimulatorSummary[];
  readonly booting: readonly string[];
  /**
   * This tile's row as its caller resolved it, which is not always one of
   * `simulators`: a `@1.1` clone is listed only under its source's
   * `instances`, so looking the id up here again would answer null for a
   * clone that is running. Null only when the host lists nothing for it.
   */
  readonly target: SimulatorSummary | null;
  readonly targetName: string;
  /** Connects this tile's simulator; `null` when the host does not offer `simulator.open`. */
  readonly onConnect: ((simulator: SimulatorSummary) => void) | null;
  /** Whether this tile's own `simulator.open` is in flight. */
  readonly connecting: boolean;
  /** Places another simulator's tile; `null` when the host cannot open one. */
  readonly onOpen: ((simulator: SimulatorSummary) => void) | null;
}) {
  const { target } = props;
  const others = orderSimulators(props.simulators).filter(
    (simulator) => simulator.simulatorId !== target?.simulatorId,
  );
  const targetBusy =
    target !== null &&
    (props.booting.includes(target.simulatorId) || props.connecting);
  return (
    <div
      className="flex h-full min-h-0 w-full flex-col items-center gap-4 overflow-y-auto bg-canvas px-6 py-8 text-ui-sm text-muted-foreground"
      data-testid="simulator-inventory"
    >
      <div className="flex w-full max-w-md flex-col items-center gap-3 text-center">
        <Smartphone className="size-8 text-muted-foreground/45" aria-hidden />
        <p className="text-ui-base font-medium text-foreground">
          {props.targetName}
        </p>
        {target === null ? (
          <p>
            {props.hostLabel} no longer lists this simulator. Pick another
            below.
          </p>
        ) : (
          <>
            <p>
              {target.booted
                ? "Running, not yet open in this task."
                : "Powered off. Connecting boots it, which can take a minute."}
            </p>
            <Button
              type="button"
              variant="default"
              size="sm"
              disabled={props.onConnect === null || targetBusy}
              data-testid="simulator-connect"
              onClick={() => props.onConnect?.(target)}
            >
              {targetBusy ? (
                <AgentSpinningDots
                  className={undefined}
                  testId={undefined}
                  variant={undefined}
                />
              ) : null}
              {target.booted ? "Connect" : "Boot and connect"}
            </Button>
          </>
        )}
      </div>
      {others.length === 0 ? null : (
        <ul
          className="w-full max-w-md space-y-1"
          aria-label={`Other simulators on ${props.hostLabel}`}
        >
          {others.map((simulator) => {
            const busy = props.booting.includes(simulator.simulatorId);
            return (
              <li key={simulator.simulatorId}>
                <button
                  type="button"
                  disabled={props.onOpen === null || busy}
                  className="flex h-9 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-foreground/80 hover:bg-foreground/5 hover:text-foreground disabled:cursor-default disabled:opacity-60"
                  data-testid={`simulator-inventory-row-${simulator.simulatorId}`}
                  onClick={() => props.onOpen?.(simulator)}
                >
                  <Smartphone className="size-4 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">
                    {simulator.name}
                  </span>
                  <Badge variant="muted" size="xs" className="shrink-0">
                    {simulatorVersionLabel(simulator)}
                  </Badge>
                  <SimulatorSessionBadge
                    busy={busy}
                    booted={simulator.booted}
                    open={false}
                  />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
