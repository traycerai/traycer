import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import type { CliFloorRemedyAction } from "@/components/settings/panels/host-overview-cli-floor-remedy";
import { copyTerminalCommand } from "@/components/settings/panels/host-doctor-actions";
import { useUpdateCheckOnBlockingMount } from "@/components/host/use-update-check-on-blocking-mount";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { requestAppUpdateInstall } from "@/lib/app-update/request-app-update-install";
import type { DesktopAppUpdatesBridge } from "@/lib/windows/types";
import { appLogger } from "@/lib/logger";

export function CliFloorRemedyActions(props: {
  readonly actions: readonly CliFloorRemedyAction[];
  readonly desktopBridge: DesktopAppUpdatesBridge | null;
  readonly onHelp: () => void;
}): ReactNode {
  return props.actions.map((action) => (
    <CliFloorRemedyControl
      key={action.kind}
      action={action}
      desktopBridge={props.desktopBridge}
      onHelp={props.onHelp}
    />
  ));
}

function CliFloorRemedyControl(props: {
  readonly action: CliFloorRemedyAction;
  readonly desktopBridge: DesktopAppUpdatesBridge | null;
  readonly onHelp: () => void;
}): ReactNode {
  const openInstallGuidance = useDesktopDialogStore(
    (state) => state.openInstallGuidance,
  );
  const { action, desktopBridge } = props;
  switch (action.kind) {
    case "desktop-check":
      return (
        <DesktopRemedyCheck
          bridge={desktopBridge}
          label={action.label}
          checkOnMount={action.checkOnMount}
        />
      );
    case "restart-desktop-hint":
      return null;
    case "desktop-progress":
      return (
        <Button type="button" size="sm" disabled>
          <AgentSpinningDots
            className="mr-2 size-3"
            testId={undefined}
            variant={undefined}
          />
          {action.label}
        </Button>
      );
    case "copy-command":
      return (
        <Button
          type="button"
          size="sm"
          onClick={() => copyTerminalCommand(action.command)}
        >
          {action.label}
        </Button>
      );
    case "help":
      return (
        <Button type="button" size="sm" onClick={props.onHelp}>
          {action.label}
        </Button>
      );
    case "desktop-download":
    case "desktop-install":
      return (
        <TooltipWrapper
          label={action.tooltip ?? action.label}
          side="top"
          sideOffset={6}
          align={undefined}
        >
          {/* Disabled buttons do not receive pointer events; the wrapper keeps
              the Desktop updater's block reason reachable, as in the header. */}
          <span className="inline-flex">
            <Button
              type="button"
              size="sm"
              disabled={action.disabled || desktopBridge === null}
              onClick={() => {
                if (desktopBridge === null || action.disabled) return;
                if (action.kind === "desktop-download") {
                  void desktopBridge.downloadUpdate();
                } else if (action.showGuidance) {
                  openInstallGuidance();
                } else {
                  void requestAppUpdateInstall(desktopBridge);
                }
              }}
            >
              {action.kind === "desktop-install" && action.installInFlight ? (
                <AgentSpinningDots
                  className="mr-2 size-3"
                  testId={undefined}
                  variant={undefined}
                />
              ) : null}
              {action.label}
            </Button>
          </span>
        </TooltipWrapper>
      );
  }
}

function DesktopRemedyCheck(props: {
  readonly bridge: DesktopAppUpdatesBridge | null;
  readonly label: string | null;
  readonly checkOnMount: boolean;
}): ReactNode {
  const { bridge, label, checkOnMount } = props;
  // The mount check is the SAME guarded one the client-update dialog runs,
  // for the same reason (see `useUpdateCheckOnBlockingMount`): the rendered
  // snapshot this remedy was derived from is the store's placeholder on the
  // first commit - `idle`, never checked - whatever main actually holds, so
  // deciding from it fired a check on every mount; and a MANUAL check
  // publishes "Checking…" then "up to date" into the app-wide snapshot every
  // other surface reads, popping toasts from a settings pane. The guarded
  // hook reads the bridge's authoritative snapshot, asks only an updater
  // that has never been asked, once per mount, with automatic intent. The
  // button below is the user's own manual check.
  useUpdateCheckOnBlockingMount(checkOnMount ? bridge : null);
  if (label === null) return null;
  return (
    <Button
      type="button"
      size="sm"
      disabled={bridge === null}
      onClick={() => checkDesktopRemedy(bridge)}
    >
      {label}
    </Button>
  );
}

function checkDesktopRemedy(bridge: DesktopAppUpdatesBridge | null): void {
  if (bridge === null) return;
  void bridge.checkForUpdates("manual").catch((error: unknown) => {
    appLogger.error("[app-update] floor remedy check failed", {}, error);
  });
}
