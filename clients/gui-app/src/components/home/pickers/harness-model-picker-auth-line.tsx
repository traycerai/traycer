import type { ReactNode } from "react";
import type {
  ProviderCliState,
  ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import { Badge } from "@/components/ui/badge";
import type { GuiHarnessCatalogEntry } from "@/hooks/harnesses/use-gui-harness-catalog";
import { guiHarnessIdToProviderId } from "@/lib/provider-ordering";
import {
  isHarnessRowSignedOut,
  isProviderAmbientSignedOut,
} from "@/lib/providers/provider-ambient-auth";
import {
  providerSetupActionPlacement,
  providerSetupPreparingLabel,
  providerSetupSteps,
  resolveProviderTerminalSetup,
  type ProviderTerminalSetup,
} from "@/lib/providers/provider-setup-guidance";
import { isProviderSignedOutCatalogError } from "@/lib/providers/provider-signed-out-catalog-error";
import type { ProviderTerminalLoginSurface } from "@/lib/providers/provider-terminal-login-surface";
import { ProviderSetupTerminalAction } from "@/components/home/pickers/provider-setup-terminal-action";
import { useProviderTerminalLoginScopeSupported } from "@/hooks/providers/use-provider-terminal-login-scope-support";

/** This exists because a single-profile provider can authenticate through a credential the user never handed to
 * it (Copilot silently rides the GitHub CLI's login after its own token is cleared). */
export function PickerProviderAuthLine(props: {
  readonly state: ProviderCliState | null;
  readonly harness: GuiHarnessCatalogEntry | null;
  readonly terminalLoginSurface: ProviderTerminalLoginSurface | null;
  readonly runTargetHostId: string | null;
  /** Closes the picker without opening anything else. */
  readonly onClosePicker: () => void;
}): ReactNode {
  const verdict = pickerAuthLineVerdict(props.state, props.harness);
  switch (verdict.kind) {
    case "hidden":
      return null;
    case "signed-out":
      return <AuthLineRow badgeText={null} label="Not authenticated" />;
    case "setup":
      return (
        <SetupGuidanceRow
          providerId={verdict.providerId}
          setup={verdict.setup}
          terminalLoginSurface={props.terminalLoginSurface}
          runTargetHostId={props.runTargetHostId}
          onClosePicker={props.onClosePicker}
        />
      );
    case "account":
      return (
        <AuthLineRow badgeText={verdict.badgeText} label={verdict.label} />
      );
  }
}

type PickerAuthLineVerdict =
  | { readonly kind: "hidden" }
  | { readonly kind: "signed-out" }
  | {
      readonly kind: "setup";
      readonly providerId: ProviderId;
      readonly setup: ProviderTerminalSetup;
    }
  | {
      readonly kind: "account";
      readonly badgeText: string | null;
      readonly label: string | null;
    };

/** Pure so the rules in the component doc above are one function rather than a chain of early returns. */
function pickerAuthLineVerdict(
  state: ProviderCliState | null,
  harness: GuiHarnessCatalogEntry | null,
): PickerAuthLineVerdict {
  const providerId = resolveProviderId(state, harness);
  if (providerId === null || !isEnabled(state, harness)) {
    return { kind: "hidden" };
  }
  const catalogSignedOut =
    harness !== null &&
    isProviderSignedOutCatalogError(providerId, harness.modelsError);
  if (catalogSignedOut || isSignedOut(state, harness)) {
    // Whether a terminal sign-in applies is the host's call, read from the
    // `providers.list` row; a row that has not resolved reads as "not yet".
    const setup = resolveProviderTerminalSetup(providerId, state);
    // Compact when the model list is showing the setup CTA for the same
    // verdict, so the popover never says it twice.
    if (setup === null || catalogSignedOut) return { kind: "signed-out" };
    return { kind: "setup", providerId, setup };
  }
  if (state === null) return { kind: "hidden" };
  const auth = state.auth;
  if (auth.status !== "authenticated" && auth.status !== "configured") {
    return { kind: "hidden" };
  }
  if (auth.badgeText === null && auth.label === null) return { kind: "hidden" };
  return { kind: "account", badgeText: auth.badgeText, label: auth.label };
}

// The `providers.list` row names the provider directly; a catalog row names
// it through its harness id. Either is enough to say what this line is about.
function resolveProviderId(
  state: ProviderCliState | null,
  harness: GuiHarnessCatalogEntry | null,
): ProviderId | null {
  if (state !== null) return state.providerId;
  if (harness !== null) return guiHarnessIdToProviderId(harness.id);
  return null;
}

function isEnabled(
  state: ProviderCliState | null,
  harness: GuiHarnessCatalogEntry | null,
): boolean {
  if (state !== null) return state.enabled;
  return harness !== null && harness.enabled;
}

// The two separately-timed verdicts the rail's degraded treatment reads.
function isSignedOut(
  state: ProviderCliState | null,
  harness: GuiHarnessCatalogEntry | null,
): boolean {
  return (
    (state !== null && isProviderAmbientSignedOut(state)) ||
    (harness !== null && isHarnessRowSignedOut(harness))
  );
}

function AuthLineRow(props: {
  readonly badgeText: string | null;
  readonly label: string | null;
}): ReactNode {
  return (
    <div className="flex min-w-0 shrink-0 items-center gap-1.5 border-b px-3 py-1.5 text-ui-xs text-muted-foreground">
      {props.badgeText === null ? null : (
        <Badge
          variant="outline"
          className="h-4 max-w-full rounded-sm border-border/60 bg-muted/20 px-1.5 text-[10px] font-normal leading-none text-muted-foreground"
        >
          <span className="truncate">{props.badgeText}</span>
        </Badge>
      )}
      {props.label === null ? null : (
        <span className="min-w-0 truncate">{props.label}</span>
      )}
    </div>
  );
}

function SetupGuidanceRow(props: {
  readonly providerId: ProviderId;
  readonly setup: ProviderTerminalSetup;
  readonly terminalLoginSurface: ProviderTerminalLoginSurface | null;
  readonly runTargetHostId: string | null;
  readonly onClosePicker: () => void;
}): ReactNode {
  const { setup, terminalLoginSurface } = props;
  const { guidance } = setup;
  const scopeSupport = useProviderTerminalLoginScopeSupported(
    terminalLoginSurface,
    props.runTargetHostId,
  );
  // One placement decides both the button and the steps, so they cannot disagree about whether there is a button
  // - the defect this seam exists to prevent. The surface is handed over only where the placement draws it.
  const placement = providerSetupActionPlacement(
    setup,
    terminalLoginSurface !== null,
    scopeSupport,
  );
  const surface = placement === "here" ? terminalLoginSurface : null;
  const preparingLabel = providerSetupPreparingLabel(setup, props.providerId);
  return (
    <div
      role="note"
      aria-label="Setup required"
      className="flex min-w-0 shrink-0 flex-col gap-1.5 border-b px-3 py-2 text-ui-xs text-muted-foreground"
    >
      <span className="text-foreground/90">Not authenticated</span>
      <span>{guidance.summary}</span>
      <ProviderSetupTerminalAction
        providerId={props.providerId}
        guidance={guidance}
        surface={surface}
        runTargetHostId={props.runTargetHostId}
        onBeforeStart={props.onClosePicker}
      />
      {placement === "preparing" && preparingLabel !== null ? (
        <span role="status">{preparingLabel}</span>
      ) : null}
      <ol className="list-decimal space-y-0.5 pl-4">
        {providerSetupSteps(guidance, placement).map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      {guidance.manualCommand === null ? null : (
        <ProviderSetupManualCommand command={guidance.manualCommand} />
      )}
    </div>
  );
}

/** The self-installed alternative, phrased so nobody reads it as the primary path: the bundled pack is not on
 * PATH, and on a remote host this shell is the wrong machine. */
export function ProviderSetupManualCommand(props: {
  readonly command: string;
}): ReactNode {
  return (
    <span>
      Installed the CLI yourself? Running{" "}
      <code className="rounded-sm bg-foreground/8 px-1 py-px font-mono text-[11px] text-foreground/90">
        {props.command}
      </code>{" "}
      in your own terminal on that machine does the same.
    </span>
  );
}
