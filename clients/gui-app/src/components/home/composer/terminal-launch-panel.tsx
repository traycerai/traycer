import { memo, useCallback, useState } from "react";
import { useStore } from "zustand";
import { Terminal } from "lucide-react";

import { HarnessModelPicker } from "@/components/home/pickers/harness-model-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useSurfaceActivity } from "@/components/home/composer/surface-activity-hooks";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import type { TerminalAgentLaunch } from "@/components/home/hooks/use-landing-composer-actions";
import type { ComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import { TUI_HARNESS_ID_TO_PROVIDER_ID } from "@traycer/protocol/host/provider-schemas";
import { isTuiHarnessId } from "@/components/home/data/landing-options";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import {
  providerPackBlocksExecution,
  providerPackPreparingForProvider,
  providerPackPreparingLabel,
} from "@/components/providers/provider-pack-readiness";
import { providerDisplayName } from "@/lib/provider-ordering";
import { usePrimaryActionShortcut } from "@/hooks/use-primary-action-shortcut";
import { PrimaryActionShortcutHint } from "@/components/ui/primary-action-shortcut-hint";

interface TerminalLaunchPanelProps {
  /** Toolbar store shared with the chat composer, so a model/mode picked here
   *  carries back to chat and vice-versa. */
  readonly store: ComposerToolbarStore;
  readonly pending: boolean;
  /**
   * When non-null the launch is blocked (e.g. no workspace folder): the Start
   * button renders disabled with this string as its tooltip. `null` means the
   * workspace is ready.
   */
  readonly disabledHint: string | null;
  /**
   * The host the terminal agent launches on: the picker's harnesses / models
   * / profiles and this panel's own saved-args read (`providers.list`) all
   * resolve against it. `null` follows the app-wide default (the landing
   * composer); the new-conversation modal passes its pinned host.
   */
  readonly hostId: string | null;
  /**
   * Fires on Start with the fully-assembled launch (harness/model/effort/agent
   * mode + CLI args). The panel owns assembly so the caller only gates the
   * workspace and dispatches.
   */
  readonly onStart: (launch: TerminalAgentLaunch) => void;
}

// Body for the landing composer's "terminal" mode. Reuses the same
// harness/model/effort picker and agent-mode toggle the chat toolbar uses (the
// selection is shared via the toolbar store) and adds an optional CLI-args
// field plus a Start button.
//
// Layout mirrors the chat composer (a `min-h-20` body over a toolbar row) so
// the input box keeps a stable height when switching modes. The text editor is
// intentionally absent - terminal agents launch empty.
function TerminalLaunchPanelImpl(props: TerminalLaunchPanelProps) {
  const { store, pending, disabledHint, hostId, onStart } = props;
  const activityEnabled = useSurfaceActivity();
  const selection = useStore(store, (s) => s.selection);
  const reasoning = useStore(store, (s) => s.reasoning);
  // Launch capability is the runtime `modes` the host advertises for the
  // selected harness - the same signal the store uses to reroute off non-TUI
  // harnesses, not the schema id (`isTuiHarnessId`). Gating on `modes` keeps
  // Start in lockstep with the store's reroute and stays disabled until the
  // catalog confirms capability, instead of briefly enabling a pre-reroute
  // selection that can't back a terminal agent.
  const selectionIsTuiCapable = useStore(
    store,
    (s) =>
      s.catalog.harnesses
        ?.find((harness) => harness.id === s.selection.harnessId)
        ?.modes.includes("tui") ?? false,
  );
  // CLI args pre-fill from the selected provider's saved Settings value. Typing
  // marks the field `touched` (a per-launch override); leaving it untouched
  // forwards `null` so the host resolves the current saved default itself -
  // which also avoids sending a stale "" before `providers.list` has loaded.
  // Read from the launch host - the same host the picker below offers
  // harnesses/profiles from - so the pre-filled args are the ones that host's
  // provider settings actually hold.
  const launchHostClient = useHostClientForHostId(hostId);
  const providersQuery = useProvidersListForClient(launchHostClient, {
    enabled: activityEnabled,
    subscribed: activityEnabled,
  });
  const { harnessId } = selection;
  const savedArgs = isTuiHarnessId(harnessId)
    ? (providersQuery.data?.providers.find(
        (provider) =>
          provider.providerId === TUI_HARNESS_ID_TO_PROVIDER_ID[harnessId],
      )?.terminalAgentArgs ?? "")
    : "";
  const [argsState, setArgsState] = useState(() => ({
    harnessId: selection.harnessId,
    draft: savedArgs,
    touched: false,
  }));
  // Re-seed on harness switch, and adopt the saved value if it arrives (async
  // `providers.list`) before the user edits. setState-during-render is the
  // sanctioned same-component "adjust state on prop change" pattern.
  const needsReseed =
    argsState.harnessId !== selection.harnessId ||
    (!argsState.touched && argsState.draft !== savedArgs);
  if (needsReseed) {
    setArgsState({
      harnessId: selection.harnessId,
      draft: savedArgs,
      touched: false,
    });
  }
  const argsDraft = needsReseed ? savedArgs : argsState.draft;
  const argsTouched = needsReseed ? false : argsState.touched;

  // Managed-pack gate. Derived from the `providers.list` response this panel
  // already holds, so gating costs no extra query. A terminal agent bypasses
  // the chat composer entirely, which is exactly why it needs its own gate:
  // the host resolver would refuse the launch, but the user would only find
  // out after pressing Start.
  const packPreparingHint = terminalPackPreparingHint(
    harnessId,
    providersQuery.data?.providers,
  );

  // The harness/model picker lists every GUI harness, including ones that can't
  // back a terminal agent. Block Start (rather than silently no-op) unless the
  // shared selection is runtime-TUI-capable, and likewise while its managed
  // pack is still being readied.
  const launchHint =
    disabledHint ??
    (selectionIsTuiCapable
      ? null
      : "Select a terminal-capable coding agent to start.") ??
    packPreparingHint;
  const startDisabled = pending || launchHint !== null;

  const start = useCallback((): void => {
    if (startDisabled) return;
    // `selectionIsTuiCapable` (folded into `startDisabled`) is the real gate;
    // this schema narrows `harnessId` to `TuiHarnessId` for the launch payload.
    if (!isTuiHarnessId(harnessId)) return;
    onStart({
      harnessId,
      model: selection.modelSlug.length > 0 ? selection.modelSlug : null,
      reasoningEffort: reasoning.length > 0 ? reasoning : null,
      terminalAgentArgs: argsTouched ? argsDraft : null,
      profileId: selection.profileId,
    });
  }, [
    argsDraft,
    argsTouched,
    harnessId,
    onStart,
    reasoning,
    selection.modelSlug,
    selection.profileId,
    startDisabled,
  ]);
  usePrimaryActionShortcut(activityEnabled, start);

  return (
    <div className="flex flex-col">
      <div className="flex min-h-[2.5rem] min-w-0 flex-wrap items-center gap-2">
        <Terminal
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden
        />
        <HarnessModelPicker
          store={store}
          withServiceTier={false}
          tuiOnly
          lockedHarnessId={null}
          disabled={pending}
          registerActivation
          // The launch host - same scope as this panel's own `providers.list`
          // read above (`null` = the app-wide default, for the landing
          // composer, which has no tab to bind to yet).
          createProfileHostId={hostId}
          runTargetHostId={hostId}
          profileAdmission={null}
        />
        <Input
          aria-label="Terminal interface CLI arguments"
          className="h-8 min-w-0 flex-1 font-mono text-ui-xs"
          placeholder="CLI arguments (optional)"
          value={argsDraft}
          onChange={(event) =>
            setArgsState({
              harnessId: selection.harnessId,
              draft: event.target.value,
              touched: true,
            })
          }
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            start();
          }}
        />
      </div>
      <div className="flex items-center justify-between gap-2 px-0.5 pb-2.5 pt-1">
        <StartButton
          hint={launchHint}
          disabled={startDisabled}
          onStart={start}
        />
      </div>
    </div>
  );
}

export const TerminalLaunchPanel = memo(TerminalLaunchPanelImpl);

interface StartButtonProps {
  readonly hint: string | null;
  readonly disabled: boolean;
  readonly onStart: () => void;
}

function StartButton(props: StartButtonProps) {
  const { hint, disabled, onStart } = props;
  // With a hint the button stays focusable (aria-disabled, not the native
  // `disabled` attr) so the tooltip is reachable - mirroring ComposerSendButton.
  const hasHint = hint !== null;
  const button = (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      // Match the chat composer's `size-8` (h-8) send button so the terminal
      // toolbar row is the same height as the chat toolbar (no switch flicker).
      // Traycer Green gives popovers and secondary buttons the same color, so
      // add dialog-local contrast without changing the landing-page treatment.
      className="h-8 in-data-[slot=dialog-content]:bg-input/60 in-data-[slot=dialog-content]:hover:bg-input/80"
      aria-label="Start agent"
      aria-keyshortcuts="Meta+Enter Control+Enter"
      aria-disabled={hasHint || undefined}
      disabled={hasHint ? false : disabled}
      onClick={() => {
        if (hasHint) return;
        onStart();
      }}
    >
      Start
      <PrimaryActionShortcutHint />
    </Button>
  );
  if (!hasHint) return button;
  return (
    <TooltipWrapper
      label={hint}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <span className="inline-flex">{button}</span>
    </TooltipWrapper>
  );
}

/**
 * Managed-pack hint for the selected terminal harness, or null when it can run
 * (or is not a terminal harness at all - `selectionIsTuiCapable` owns that case
 * and reports it more precisely).
 *
 * A terminal agent launch bypasses the chat composer entirely, so it needs its
 * own gate rather than inheriting one: the host resolver would refuse the
 * launch either way, but without this the user only finds out after pressing
 * Start.
 *
 * Returns null for a NON-BLOCKING install for the same reason the composer
 * gate does: this string is the panel's disabled-hint, and the host would
 * resolve the bundled/PATH/custom binary and launch. A hint here would turn a
 * background download into a refused launch.
 */
function terminalPackPreparingHint(
  harnessId: GuiHarnessId,
  providers: ReadonlyArray<ProviderCliState> | undefined,
): string | null {
  if (!isTuiHarnessId(harnessId) || providers === undefined) return null;
  const providerId = TUI_HARNESS_ID_TO_PROVIDER_ID[harnessId];
  const provider = providers.find(
    (candidate) => candidate.providerId === providerId,
  );
  if (provider === undefined) return null;
  const preparing = providerPackPreparingForProvider(provider);
  if (preparing === null || !providerPackBlocksExecution(preparing)) {
    return null;
  }
  return providerPackPreparingLabel(preparing, providerDisplayName(providerId));
}
