import { memo, useCallback, useState } from "react";
import { useStore } from "zustand";
import { Terminal } from "lucide-react";

import { HarnessModelPicker } from "@/components/home/pickers/harness-model-picker";
import { AgentModeToggle } from "@/components/home/pickers/agent-mode-toggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useSurfaceActivity } from "@/components/home/composer/surface-activity-hooks";
import { useProvidersList } from "@/hooks/providers/use-providers-list-query";
import type { TerminalAgentLaunch } from "@/components/home/hooks/use-landing-composer-actions";
import type { ComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import { TUI_HARNESS_ID_TO_PROVIDER_ID } from "@traycer/protocol/host/provider-schemas";
import { isTuiHarnessId } from "@/components/home/data/landing-options";

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
  const { store, pending, disabledHint, onStart } = props;
  const activityEnabled = useSurfaceActivity();
  const selection = useStore(store, (s) => s.selection);
  const reasoning = useStore(store, (s) => s.reasoning);
  const agentMode = useStore(store, (s) => s.agentMode);
  const setAgentMode = useStore(store, (s) => s.setAgentMode);
  // Launch capability is the runtime `modes` the host advertises for the
  // selected harness - the same signal the store uses to reroute off non-TUI
  // harnesses - NOT the schema id (`isTuiHarnessId`). They diverge for a
  // schema-TUI harness whose adapter currently exposes only `gui` (e.g.
  // `cursor`): gating on `modes` keeps Start in lockstep with the store's
  // reroute and stays disabled until the catalog confirms capability, instead
  // of briefly enabling a pre-reroute selection that can't back a terminal agent.
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
  const providersQuery = useProvidersList({
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

  // The harness/model picker lists every GUI harness, including ones that can't
  // back a terminal agent (the GUI-only `traycer`, or a schema-TUI harness whose
  // adapter advertises only `gui`). Block Start (rather than silently no-op)
  // unless the shared selection is runtime-TUI-capable.
  const launchHint =
    disabledHint ??
    (selectionIsTuiCapable
      ? null
      : "Select a terminal-capable agent to start.");
  const startDisabled = pending || launchHint !== null;

  const start = useCallback((): void => {
    if (startDisabled) return;
    // `selectionIsTuiCapable` (folded into `startDisabled`) is the real gate;
    // this schema narrows `harnessId` to `TuiHarnessId` for the launch payload.
    if (!isTuiHarnessId(harnessId)) return;
    onStart({
      harnessId,
      agentMode,
      model: selection.modelSlug.length > 0 ? selection.modelSlug : null,
      reasoningEffort: reasoning.length > 0 ? reasoning : null,
      terminalAgentArgs: argsTouched ? argsDraft : null,
    });
  }, [
    agentMode,
    argsDraft,
    argsTouched,
    harnessId,
    onStart,
    reasoning,
    selection.modelSlug,
    startDisabled,
  ]);

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
        />
        <Input
          aria-label="Terminal agent CLI arguments"
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
        <AgentModeToggle
          value={agentMode}
          disabled={pending}
          showTooltip
          onChange={setAgentMode}
        />
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
      className="h-8"
      aria-label="Start terminal agent"
      aria-disabled={hasHint || undefined}
      disabled={hasHint ? false : disabled}
      onClick={() => {
        if (hasHint) return;
        onStart();
      }}
    >
      Start
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
