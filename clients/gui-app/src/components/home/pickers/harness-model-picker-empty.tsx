import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { createReportIssueContext } from "@/lib/report-issue-context";
import type { GuiHarnessCatalogEntry } from "@/hooks/harnesses/use-gui-harness-catalog";
import { useProvidersFocusStore } from "@/stores/settings/providers-focus-store";
import { guiHarnessIdToProviderId } from "@/lib/provider-ordering";
import { ProviderSetupManualCommand } from "@/components/home/pickers/harness-model-picker-auth-line";
import { ProviderSetupTerminalAction } from "@/components/home/pickers/provider-setup-terminal-action";
import { useProviderTerminalLoginScopeSupported } from "@/hooks/providers/use-provider-terminal-login-scope-support";
import {
  providerSetupActionPlacement,
  providerSetupPreparingLabel,
  providerSetupSteps,
  resolveProviderTerminalSetup,
  type ProviderTerminalSetup,
} from "@/lib/providers/provider-setup-guidance";
import { isProviderSignedOutCatalogError } from "@/lib/providers/provider-signed-out-catalog-error";
import type { ProviderTerminalLoginSurface } from "@/lib/providers/provider-terminal-login-surface";
import type {
  ProviderCliState,
  ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import { KeyRound, SquareTerminal } from "lucide-react";
import type { ReactNode } from "react";

interface PickerStateRowProps {
  readonly label: string;
  readonly icon: ReactNode | undefined;
  readonly action: ReactNode | undefined;
}
function PickerStateRow(props: PickerStateRowProps) {
  const { label, icon, action } = props;
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg p-2 text-ui-sm text-muted-foreground">
      {/* The action (when present) must stay OUTSIDE the option element: an
          `option` role's descendants are flattened/treated as disabled by
          assistive tech, which would make a nested Report issue button
          unreachable. Keeping the row's flex layout on the outer div and the
          option semantics on this inner span preserves the visual row while
          leaving the action independently focusable/announced. */}
      <span
        role="option"
        aria-selected="false"
        aria-disabled="true"
        className="flex min-w-0 items-center gap-2"
      >
        {icon}
        {label}
      </span>
      {action}
    </div>
  );
}

interface ModelRowsStateProps {
  readonly catalogLoading: boolean;
  readonly catalogError: boolean;
  readonly hostUnavailableLabel: string | null;
  readonly hasQuery: boolean;
  readonly activeProvider: GuiHarnessCatalogEntry | null;
  /** The same provider's `providers.list` row - its `loginCapability` is what
   *  decides whether a terminal sign-in applies. `null` until resolved. */
  readonly activeProviderState: ProviderCliState | null;
  readonly rowsCount: number;
  readonly onOpenProviderSettings: () => void;
  /** Where a provider's setup terminal lands - see the type's doc. */
  readonly terminalLoginSurface: ProviderTerminalLoginSurface | null;
  /** The picker's run-target host, which that terminal is minted on. */
  readonly runTargetHostId: string | null;
  /** Closes the picker without opening anything else. */
  readonly onClosePicker: () => void;
}

export function ModelRowsState(props: ModelRowsStateProps): ReactNode | null {
  const {
    catalogLoading,
    catalogError,
    hostUnavailableLabel,
    hasQuery,
    activeProvider,
    activeProviderState,
    rowsCount,
    onOpenProviderSettings,
    terminalLoginSurface,
    runTargetHostId,
    onClosePicker,
  } = props;

  if (hostUnavailableLabel !== null && rowsCount === 0) {
    return (
      <PickerStateRow
        icon={undefined}
        label={hostUnavailableLabel}
        action={undefined}
      />
    );
  }

  if (catalogLoading && rowsCount === 0) {
    return (
      <PickerStateRow
        icon={<MutedAgentSpinner />}
        label="Loading models"
        action={undefined}
      />
    );
  }

  if (catalogError) {
    return (
      <PickerStateRow
        label="Couldn't load providers"
        icon={undefined}
        action={
          <ReportIssueAction
            context={createReportIssueContext({
              title: "Couldn't load providers",
              message: "The harness/provider catalog could not be loaded.",
              code: null,
              source: "Model picker",
            })}
            presentation="icon"
            className={undefined}
          />
        }
      />
    );
  }

  // A provider that can't list models (unavailable / missing API key / load
  // error) surfaces its own state or CTA even while a query is present - the
  // query is moot if the provider has nothing to search.
  if (activeProvider?.available === false) {
    return unavailableProviderState(activeProvider, onOpenProviderSettings);
  }

  if (activeProvider?.modelsLoading === true) {
    return (
      <PickerStateRow
        icon={<MutedAgentSpinner />}
        label="Loading models"
        action={undefined}
      />
    );
  }

  if (activeProvider !== null && activeProvider.modelsError !== null) {
    // A signed-out verdict for a provider whose sign-in runs in a terminal
    // gets the action that fixes it, in the space the model rows would occupy
    // - the host's "signed out, reconnect" sentence is true but names no
    // action, and the report-issue icon beside it invites a bug report for a
    // missing key.
    const setup = providerSetupCta(activeProvider, activeProviderState);
    if (setup !== null) {
      return (
        <ProviderSetupCta
          providerId={setup.providerId}
          label={activeProvider.label}
          setup={setup.setup}
          terminalLoginSurface={terminalLoginSurface}
          runTargetHostId={runTargetHostId}
          onClosePicker={onClosePicker}
        />
      );
    }
    // Surface the host's specific reason for API-key providers and packaged SDK
    // failures instead of a generic catch-all. Fall back when the message is
    // empty.
    const reason = activeProvider.modelsError.message.trim();
    return (
      <PickerStateRow
        label={reason.length > 0 ? reason : "Couldn't load models"}
        icon={undefined}
        action={
          <ReportIssueAction
            context={createReportIssueContext({
              title: "Couldn't load models",
              message: "Models for the selected provider could not be loaded.",
              code: null,
              source: "Model picker",
            })}
            presentation="icon"
            className={undefined}
          />
        }
      />
    );
  }

  if (rowsCount === 0) {
    return (
      <PickerStateRow
        label={noModelsLabel(hasQuery, activeProvider)}
        icon={undefined}
        action={undefined}
      />
    );
  }

  return null;
}

// Scope-aware empty copy. A query that matches nothing names the harness it
// searched ("No Claude models match"); an empty harness with no query keeps the
// generic "No models available".
function noModelsLabel(
  hasQuery: boolean,
  activeProvider: GuiHarnessCatalogEntry | null,
): string {
  if (!hasQuery) return "No models available";
  if (activeProvider === null) return "No models match";
  return `No ${activeProvider.label} models match`;
}

// The state row shown when the active provider is unavailable. API-key
// providers stay visible in the picker so they can surface a CTA that walks the
// user to Settings → Providers instead of a dead-end "unavailable" row.
function unavailableProviderState(
  provider: GuiHarnessCatalogEntry,
  onOpenProviderSettings: () => void,
): ReactNode {
  if (provider.requiresApiKey) {
    return (
      <ProviderApiKeyCta
        harnessId={provider.id}
        label={provider.label}
        onOpenProviderSettings={onOpenProviderSettings}
      />
    );
  }
  return (
    <PickerStateRow
      label={`${provider.label} unavailable`}
      icon={undefined}
      action={undefined}
    />
  );
}

// The setup guidance to show in place of the model list, when the list failed
// with the host's signed-out verdict AND the host says this provider signs in
// from a terminal (Copilot's device code; Reasonix's credential wizard). Any
// other failure keeps the host's own reason below. The `providers.list` row
// may lag the catalog error by a fetch; until it lands this is `null` and the
// generic reason row shows, then re-resolves.
function providerSetupCta(
  provider: GuiHarnessCatalogEntry,
  state: ProviderCliState | null,
): {
  readonly providerId: ProviderId;
  readonly setup: ProviderTerminalSetup;
} | null {
  const providerId = guiHarnessIdToProviderId(provider.id);
  if (providerId === null) return null;
  const setup = resolveProviderTerminalSetup(providerId, state);
  if (setup === null) return null;
  return isProviderSignedOutCatalogError(providerId, provider.modelsError)
    ? { providerId, setup }
    : null;
}

// Shown in place of the model list when a provider that signs in from a
// terminal is signed out. Same shape as the API-key CTA below, but the action
// is the provider's terminal flow: Traycer cannot complete it itself. The
// button asks the host to open that flow in a terminal on the surface this
// picker is drawn on (an epic's canvas, or the landing terminal panel); on a
// surface with neither (a fork dialog) the steps say where the button lives.
// No Settings button, deliberately - Settings has no terminal sign-in for
// such a provider, so it would be a dead end.
function ProviderSetupCta(props: {
  readonly providerId: ProviderId;
  readonly label: string;
  readonly setup: ProviderTerminalSetup;
  readonly terminalLoginSurface: ProviderTerminalLoginSurface | null;
  readonly runTargetHostId: string | null;
  readonly onClosePicker: () => void;
}): ReactNode {
  const { setup, terminalLoginSurface } = props;
  const { guidance } = setup;
  const scopeSupported = useProviderTerminalLoginScopeSupported(
    terminalLoginSurface,
    props.runTargetHostId,
  );
  // Same single decision as the auth line: the surface is handed over only
  // where the placement draws a button, so button and steps cannot disagree.
  const placement = providerSetupActionPlacement(
    setup,
    terminalLoginSurface !== null,
    scopeSupported,
  );
  const preparingLabel = providerSetupPreparingLabel(setup, props.providerId);
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-6 text-center">
      <span className="flex size-9 items-center justify-center rounded-full bg-primary/10 text-primary">
        <SquareTerminal className="size-4" />
      </span>
      <span className="text-ui-sm font-medium text-foreground">
        Set up {props.label}
      </span>
      <p className="max-w-[min(90vw,18rem)] text-balance text-ui-xs text-muted-foreground">
        {guidance.summary}
      </p>
      {placement === "preparing" && preparingLabel !== null ? (
        <p
          role="status"
          className="max-w-[min(90vw,18rem)] text-ui-xs text-muted-foreground"
        >
          {preparingLabel}
        </p>
      ) : null}
      <div className="max-w-[min(90vw,18rem)]">
        <ProviderSetupTerminalAction
          providerId={props.providerId}
          guidance={guidance}
          surface={placement === "here" ? terminalLoginSurface : null}
          runTargetHostId={props.runTargetHostId}
          onBeforeStart={props.onClosePicker}
        />
      </div>
      <ol className="max-w-[min(90vw,18rem)] list-decimal space-y-0.5 pl-4 text-left text-ui-xs text-muted-foreground">
        {providerSetupSteps(guidance, placement).map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      {guidance.manualCommand === null ? null : (
        <p className="max-w-[min(90vw,18rem)] text-left text-ui-xs text-muted-foreground">
          <ProviderSetupManualCommand command={guidance.manualCommand} />
        </p>
      )}
    </div>
  );
}

// Shown in place of the model list when an API-key provider has no key
// configured. A friendly prompt + a one-click path to Settings → Providers where
// the key is entered.
function ProviderApiKeyCta(props: {
  readonly harnessId: GuiHarnessCatalogEntry["id"];
  readonly label: string;
  readonly onOpenProviderSettings: () => void;
}): ReactNode {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-6 text-center">
      <span className="flex size-9 items-center justify-center rounded-full bg-primary/10 text-primary">
        <KeyRound className="size-4" />
      </span>
      <span className="text-ui-sm font-medium text-foreground">
        Connect {props.label}
      </span>
      <p className="max-w-[min(90vw,16rem)] text-balance text-ui-xs text-muted-foreground">
        {props.label} needs an API key to list models and start chats. Add yours
        in Provider settings to get started.
      </p>
      <Button
        size="sm"
        variant="secondary"
        className="mt-1"
        onClick={() => {
          // Pre-select this provider in the settings panel so the user lands on
          // its API-key field, not the first provider in the rail.
          useProvidersFocusStore.getState().setFocusHarnessId(props.harnessId);
          props.onOpenProviderSettings();
        }}
      >
        Add API key
      </Button>
    </div>
  );
}
