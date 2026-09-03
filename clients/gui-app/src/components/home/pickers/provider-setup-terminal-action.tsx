import type { ReactNode } from "react";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { Button } from "@/components/ui/button";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { useProviderTerminalLogin } from "@/hooks/providers/use-provider-terminal-login";
import { useLandingProviderTerminalLogin } from "@/hooks/providers/use-landing-provider-terminal-login";
import type { ProviderSetupGuidance } from "@/lib/providers/provider-setup-guidance";
import type { ProviderTerminalLoginSurface } from "@/lib/providers/provider-terminal-login-surface";

interface ProviderSetupTerminalActionProps {
  readonly providerId: ProviderId;
  readonly guidance: ProviderSetupGuidance;
  /** Where the terminal lands; `null` renders nothing (no surface to open into). */
  readonly surface: ProviderTerminalLoginSurface | null;
  /** The picker's run-target host - the host the terminal is minted on. */
  readonly runTargetHostId: string | null;
  /**
   * Runs before the request is sent. The picker passes its close: the
   * terminal opens BEHIND the popover otherwise, and the open itself hangs
   * off the mutation, so closing first loses nothing.
   */
  readonly onBeforeStart: () => void;
}

/**
 * The picker's "Set up in terminal" button for a provider with setup
 * guidance, on the surface the picker is drawn on. One component per surface
 * kind, because each kind is a different hook with different context needs
 * (the epic one is tab-bound); the switch lives here so every setup CTA in
 * the picker renders the button the same way.
 */
export function ProviderSetupTerminalAction(
  props: ProviderSetupTerminalActionProps,
): ReactNode {
  const { surface } = props;
  if (surface === null) return null;
  return surface.kind === "epic" ? (
    <EpicSetupTerminalButton
      providerId={props.providerId}
      guidance={props.guidance}
      epicId={surface.epicId}
      viewTabId={surface.viewTabId}
      onBeforeStart={props.onBeforeStart}
    />
  ) : (
    <LandingSetupTerminalButton
      providerId={props.providerId}
      guidance={props.guidance}
      landingPageId={surface.landingPageId}
      runTargetHostId={props.runTargetHostId}
      onBeforeStart={props.onBeforeStart}
    />
  );
}

function EpicSetupTerminalButton(props: {
  readonly providerId: ProviderId;
  readonly guidance: ProviderSetupGuidance;
  readonly epicId: string;
  readonly viewTabId: string;
  readonly onBeforeStart: () => void;
}): ReactNode {
  const login = useProviderTerminalLogin({
    providerId: props.providerId,
    epicId: props.epicId,
    viewTabId: props.viewTabId,
    launchedFromTile: null,
  });
  return (
    <SetupTerminalButton
      guidance={props.guidance}
      isPending={login.isPending}
      onStart={() => {
        props.onBeforeStart();
        login.start();
      }}
    />
  );
}

function LandingSetupTerminalButton(props: {
  readonly providerId: ProviderId;
  readonly guidance: ProviderSetupGuidance;
  readonly landingPageId: string;
  readonly runTargetHostId: string | null;
  readonly onBeforeStart: () => void;
}): ReactNode {
  const login = useLandingProviderTerminalLogin({
    providerId: props.providerId,
    hostId: props.runTargetHostId,
    landingPageId: props.landingPageId,
    launchedFromSessionId: null,
  });
  return (
    <SetupTerminalButton
      guidance={props.guidance}
      isPending={login.isPending}
      onStart={() => {
        props.onBeforeStart();
        login.start();
      }}
    />
  );
}

// Same pending treatment as the composer banner's terminal action: unchanged
// label, disabled, inline spinner. Starting a sign-in kills and respawns a PTY
// host-side, so a press with no feedback reads as a dead button and invites a
// second one.
function SetupTerminalButton(props: {
  readonly guidance: ProviderSetupGuidance;
  readonly isPending: boolean;
  readonly onStart: () => void;
}): ReactNode {
  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={props.isPending}
        onClick={props.onStart}
      >
        {props.guidance.terminalActionLabel}
        {props.isPending ? <MutedAgentSpinner /> : null}
      </Button>
      <span className="text-left text-ui-xs text-muted-foreground">
        {props.guidance.terminalHint}
      </span>
    </div>
  );
}
