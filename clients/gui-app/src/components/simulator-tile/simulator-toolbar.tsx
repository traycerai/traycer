import { useState } from "react";
import {
  Camera,
  ChevronLeft,
  Circle,
  LayoutGrid,
  Power,
  RotateCw,
  SlidersHorizontal,
  Square,
  X,
  type LucideIcon,
} from "lucide-react";
import type { SimulatorPlatform } from "@traycer/protocol/host/simulator/schemas";
import type { SimulatorHardwareButton } from "@traycer/protocol/host/simulator/stream-contracts";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { simulatorVersionLabel } from "@/lib/simulator-view/simulator-labels";
import { SimulatorAgentBadge } from "./simulator-agent-badge";
import {
  hardwareButtonLabel,
  hardwareButtonsForPlatform,
} from "@/lib/simulator-view/simulator-input-encoding";

const BUTTON_ICONS: Record<SimulatorHardwareButton, LucideIcon> = {
  home: Circle,
  back: ChevronLeft,
  recents: Square,
  appSwitcher: LayoutGrid,
  power: Power,
};

export interface SimulatorToolbarProps {
  readonly platform: SimulatorPlatform;
  readonly simulatorName: string;
  readonly version: string;
  /** `null` while the stream carries no input, so the hardware buttons stay inert. */
  readonly onPressButton: ((button: SimulatorHardwareButton) => void) | null;
  readonly onRotate: (() => void) | null;
  readonly rotatePending: boolean;
  /** `null` when the host offers no screenshot. */
  readonly onScreenshot: (() => void) | null;
  readonly screenshotPending: boolean;
  /** `null` when the host offers no typed settings for this simulator. */
  readonly onToggleSettings: (() => void) | null;
  readonly settingsOpen: boolean;
  readonly onPowerOff: (() => void) | null;
  /**
   * Whether Power off asks here first. A `@1.1` host asks through its own
   * `confirm-required` answer, only while an agent is mid-turn on it.
   */
  /**
   * Whether powering off reaches past this task: on a `@1.1` host it ends
   * every task's session on the instance and deletes a copy, where a `@1.0`
   * host's shutdown is this task's own. The confirm says which.
   */
  readonly powerOffEndsEveryTask: boolean;
  readonly powerOffPending: boolean;
  /** The Agent badge, while an agent's session drives this instance. */
  readonly drivenByAgent: boolean;
  readonly onClose: () => void;
}

/**
 * The tile's chrome: the device's name, its hardware buttons for the
 * platform it is, rotate, a screenshot, the settings drawer, power off
 * (always confirmed, because it shuts the simulator down for every viewer,
 * on whichever host) and close (this tile only).
 */
export function SimulatorToolbar(props: SimulatorToolbarProps) {
  const [confirmPowerOff, setConfirmPowerOff] = useState(false);
  const buttons = hardwareButtonsForPlatform(props.platform);
  return (
    <div
      className="flex min-h-0 min-w-0 shrink-0 items-center gap-1 border-b border-border px-2 py-1.5 text-ui-sm"
      data-testid="simulator-toolbar"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="min-w-0 truncate font-medium">
          {props.simulatorName}
        </span>
        {props.drivenByAgent ? <SimulatorAgentBadge /> : null}
        <Badge variant="muted" size="xs" className="shrink-0">
          {simulatorVersionLabel({
            platform: props.platform,
            version: props.version,
          })}
        </Badge>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {buttons.map((button) => {
          const Icon = BUTTON_ICONS[button];
          const label = hardwareButtonLabel(button);
          return (
            <TooltipWrapper
              key={button}
              label={label}
              side="bottom"
              sideOffset={undefined}
              align={undefined}
            >
              <Button
                type="button"
                variant="muted"
                size="icon-xs"
                aria-label={label}
                disabled={props.onPressButton === null}
                data-testid={`simulator-button-${button}`}
                onClick={() => props.onPressButton?.(button)}
              >
                <Icon className="size-3.5" aria-hidden />
              </Button>
            </TooltipWrapper>
          );
        })}
        <TooltipWrapper
          label="Rotate"
          side="bottom"
          sideOffset={undefined}
          align={undefined}
        >
          <Button
            type="button"
            variant="muted"
            size="icon-xs"
            aria-label="Rotate"
            disabled={props.onRotate === null || props.rotatePending}
            data-testid="simulator-rotate"
            onClick={() => props.onRotate?.()}
          >
            {props.rotatePending ? (
              <AgentSpinningDots
                className={undefined}
                testId={undefined}
                variant={undefined}
                tone="muted"
              />
            ) : (
              <RotateCw className="size-3.5" aria-hidden />
            )}
          </Button>
        </TooltipWrapper>
        <TooltipWrapper
          label="Save a screenshot"
          side="bottom"
          sideOffset={undefined}
          align={undefined}
        >
          <Button
            type="button"
            variant="muted"
            size="icon-xs"
            aria-label="Save a screenshot"
            disabled={props.onScreenshot === null || props.screenshotPending}
            data-testid="simulator-screenshot"
            onClick={() => props.onScreenshot?.()}
          >
            {props.screenshotPending ? (
              <AgentSpinningDots
                className={undefined}
                testId={undefined}
                variant={undefined}
                tone="muted"
              />
            ) : (
              <Camera className="size-3.5" aria-hidden />
            )}
          </Button>
        </TooltipWrapper>
        <TooltipWrapper
          label="Simulator settings"
          side="bottom"
          sideOffset={undefined}
          align={undefined}
        >
          <Button
            type="button"
            variant="muted"
            size="icon-xs"
            aria-label="Simulator settings"
            aria-pressed={props.settingsOpen}
            disabled={props.onToggleSettings === null}
            data-testid="simulator-settings-toggle"
            onClick={() => props.onToggleSettings?.()}
          >
            <SlidersHorizontal className="size-3.5" aria-hidden />
          </Button>
        </TooltipWrapper>
        <TooltipWrapper
          label="Power off"
          side="bottom"
          sideOffset={undefined}
          align={undefined}
        >
          <Button
            type="button"
            variant="muted-destructive"
            size="icon-xs"
            aria-label="Power off"
            disabled={props.onPowerOff === null || props.powerOffPending}
            data-testid="simulator-power-off"
            onClick={() => setConfirmPowerOff(true)}
          >
            {props.powerOffPending ? (
              <AgentSpinningDots
                className={undefined}
                testId={undefined}
                variant={undefined}
                tone="muted"
              />
            ) : (
              <Power className="size-3.5" aria-hidden />
            )}
          </Button>
        </TooltipWrapper>
        <TooltipWrapper
          label="Close"
          side="bottom"
          sideOffset={undefined}
          align={undefined}
        >
          <Button
            type="button"
            variant="muted"
            size="icon-xs"
            aria-label="Close"
            data-testid="simulator-close"
            onClick={props.onClose}
          >
            <X className="size-3.5" aria-hidden />
          </Button>
        </TooltipWrapper>
      </div>
      <ConfirmDestructiveDialog
        open={confirmPowerOff}
        onOpenChange={setConfirmPowerOff}
        title={`Power off ${props.simulatorName}?`}
        description={
          props.powerOffEndsEveryTask
            ? "Power off ends every task's session on it. A copy is deleted when it powers off."
            : "The simulator shuts down for everyone viewing it in this task. Apps installed on it stay installed."
        }
        cascadeSummary={null}
        actionLabel="Power off"
        isPending={false}
        blockedReason={null}
        onConfirm={() => {
          setConfirmPowerOff(false);
          props.onPowerOff?.();
        }}
      />
    </div>
  );
}
