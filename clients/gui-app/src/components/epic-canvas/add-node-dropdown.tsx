import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useStore } from "zustand";
import { TUI_HARNESS_ID_TO_PROVIDER_ID } from "@traycer/protocol/host/provider-schemas";
import {
  EPIC_NODE_ICONS,
  DEFAULT_EPIC_NODE_NAMES,
  type EpicNodeKind,
} from "@/lib/artifacts/node-display";
import { ADDABLE_TYPES } from "@/components/epic-canvas/add-node-options";
import { useSettingsStore } from "@/stores/settings/settings-store";
import {
  pendingTerminalAgentStagingKey,
  type WorktreeStagingKey,
  useWorktreeIntentStagingStore,
} from "@/stores/worktree/worktree-intent-staging-store";
import { isTuiHarnessId } from "@/components/home/data/landing-options";
import { AgentModeToggle } from "@/components/home/pickers/agent-mode-toggle";
import { HarnessModelPicker } from "@/components/home/pickers/harness-model-picker";
import { useComposerToolbarStore } from "@/components/home/hooks/use-composer-toolbar-store";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { ActiveHostWorkspaceControls } from "@/components/home/host-workspace-selector/host-workspace-selector";
import {
  ACTIVE_HOST_WORKSPACE_CONTROLS_SCOPE,
  type HostWorkspaceControlsHostScope,
} from "@/components/home/host-workspace-selector/host-workspace-controls-scope";
import { preserveWhenNestedOverlay } from "@/components/home/host-workspace-selector/preserve-when-nested-overlay";
import { useProvidersList } from "@/hooks/providers/use-providers-list-query";
import type { ForkWorkspaceSeed } from "@/lib/worktree/fork-workspace-seed";
import type { TerminalAgentWorktreeCreateInput } from "@/components/epic-canvas/hooks/use-terminal-agent-worktree-gate";
import { readSeededLaunchWorktreeIntent } from "@/lib/worktree/seeded-launch-worktree-intent";
import { deriveWorkspaceMode } from "@/lib/worktree/workspace-mode";

export interface AddArtifactDropdownProps {
  children: ReactNode;
  open: boolean | undefined;
  onOpenChange: ((open: boolean) => void) | undefined;
  menuTestId: string;
  itemTestId: (type: EpicNodeKind) => string;
  onAdd: (type: EpicNodeKind) => void;
  /**
   * Epic the dropdown adds into. Scopes the terminal-agent launcher's pending
   * staging slot (`pendingTerminalAgentStagingKey(epicId)`) so per-epic seeds
   * don't bleed across epics, and the launch handler reads the same key.
   */
  epicId: string;
  /**
   * Optional handler for terminal-agent launches. When supplied, the
   * dropdown shows a "Terminal Agent" submenu with a harness picker, launch
   * arguments, and an inline host/workspace picker. The submenu reads its
   * pending-launcher staged intent at Start time and passes it through here so
   * dropdown cleanup cannot clear the binding before the dispatcher sees it.
   */
  onAddTerminalAgent:
    ((input: TerminalAgentWorktreeCreateInput) => void) | undefined;
  /**
   * Optional seed copied from the latest chat's visible workspace binding.
   * Terminal-agent submenu uses it both for the initial folder rows and for the
   * pending launch intent when the user accepts without editing.
   */
  terminalAgentWorkspaceSeed: ForkWorkspaceSeed | null;
  /**
   * Host scope for the terminal-agent submenu workspace picker. Row child
   * creation passes a fixed row-host scope so the picker resolves folders and
   * staged intents on the same host the child will be created on. Header/root
   * launchers pass `undefined` and keep active-host behavior.
   */
  terminalAgentHostScope: HostWorkspaceControlsHostScope | undefined;
  /**
   * Staging-key override for the terminal-agent submenu's host/workspace
   * picker. When provided (a chat / agent ROW's per-parent slot from
   * `pendingChildTerminalAgentStagingKey(epicId, parentId)`), the submenu stages
   * and reads its workspace picks under that key instead of the shared
   * `pendingTerminalAgentStagingKey(epicId)` launcher slot - so concurrent rows
   * don't collide and the picker can be seeded from the parent's workspace.
   * Header / root-create callers pass `undefined` to keep today's default slot.
   */
  terminalAgentStagingKey: WorktreeStagingKey | undefined;
  /**
   * True while a terminal-agent creation is mid-flight. Disables the
   * provider items so a double click can't kick off two launches.
   */
  tuiAgentPending: boolean | undefined;
  disabled: boolean | undefined;
  /** Tooltip text to show when disabled. `null` when no special message needed. */
  disabledTooltip: string | null;
  disabledTypes: ReadonlyArray<EpicNodeKind> | undefined;
  /**
   * Optional set of kinds to omit from the dropdown.
   */
  excludeTypes: ReadonlyArray<EpicNodeKind> | undefined;
}

/**
 * Shared dropdown that lists all addable artifact types. Used by the
 * sidebar header "+", per-row inline "+", and other add-node entry points.
 */
export function AddNodeDropdown(props: AddArtifactDropdownProps) {
  const {
    children,
    open,
    onOpenChange,
    menuTestId,
    itemTestId,
    onAdd,
    epicId,
    onAddTerminalAgent,
    terminalAgentWorkspaceSeed,
    terminalAgentHostScope,
    terminalAgentStagingKey,
    tuiAgentPending,
    disabled,
    disabledTooltip,
    disabledTypes,
    excludeTypes,
  } = props;
  // The Terminal Agent submenu's own content node, so an outside-click can tell
  // a nested overlay (host Select / folder picker, stacked above) from an
  // ancestor surface - see preserveWhenNestedOverlay.
  const terminalAgentSubRef = useRef<HTMLDivElement>(null);
  const visibleTypes =
    excludeTypes === undefined || excludeTypes.length === 0
      ? ADDABLE_TYPES
      : ADDABLE_TYPES.filter((type) => !excludeTypes.includes(type));
  const artifactIconColors = useSettingsStore(
    (state) => state.artifactIconColors,
  );
  const artifactIconColorMode = useSettingsStore(
    (state) => state.artifactIconColorMode,
  );

  // When disabled there is no dropdown, so the tooltip (e.g. "Reconnect to
  // make changes.") can wrap the trigger directly. In the interactive path the
  // trigger must be the *direct* child of `DropdownMenuTrigger asChild`: that
  // slot clones the child to inject the open-menu handlers and ref, and
  // `TooltipWrapper` does not forward them, so interposing it would swallow the
  // click and the menu would never open.
  if (disabled) {
    return (
      <TooltipWrapper
        label={disabledTooltip}
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        {children}
      </TooltipWrapper>
    );
  }

  const TerminalAgentIcon = EPIC_NODE_ICONS["terminal-agent"];
  const terminalAgentIconColor = artifactIconColors["terminal-agent"];
  const terminalAgentIconStyle =
    artifactIconColorMode === "byType"
      ? { color: terminalAgentIconColor }
      : undefined;

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-[min(90vw,11rem)]"
        data-testid={menuTestId}
      >
        {visibleTypes.map((type) => {
          const itemDisabled = disabledTypes?.includes(type) ?? false;
          const OptionIcon = EPIC_NODE_ICONS[type];
          const iconColor = artifactIconColors[type];
          const iconStyle =
            artifactIconColorMode === "byType"
              ? { color: iconColor }
              : undefined;
          return (
            <DropdownMenuItem
              key={type}
              data-testid={itemTestId(type)}
              onSelect={() => {
                onAdd(type);
              }}
              disabled={itemDisabled}
            >
              <OptionIcon
                className={cn(
                  "size-3.5",
                  artifactIconColorMode === "none" && "text-muted-foreground",
                )}
                style={iconStyle}
              />
              {DEFAULT_EPIC_NODE_NAMES[type]}
            </DropdownMenuItem>
          );
        })}
        {onAddTerminalAgent === undefined ? null : (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger
              disabled={tuiAgentPending}
              data-testid={`${menuTestId}-terminal-agent`}
            >
              <TerminalAgentIcon
                className={cn(
                  "size-3.5",
                  artifactIconColorMode === "none" && "text-muted-foreground",
                )}
                style={terminalAgentIconStyle}
              />
              Terminal Agent
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent
              ref={terminalAgentSubRef}
              className="flex w-[min(92vw,32rem)] flex-col gap-3 p-2"
              data-testid={`${menuTestId}-terminal-agent-sub`}
              // The host Select + folder picker open portaled overlays; treat
              // clicks inside them (stacked above this submenu) as inside it so
              // picking a host / branch doesn't dismiss the launcher.
              onInteractOutside={(event) =>
                preserveWhenNestedOverlay(event, terminalAgentSubRef.current)
              }
            >
              <TerminalAgentSubMenuContent
                epicId={epicId}
                menuTestId={menuTestId}
                workspaceSeed={terminalAgentWorkspaceSeed}
                hostScope={
                  terminalAgentHostScope ?? ACTIVE_HOST_WORKSPACE_CONTROLS_SCOPE
                }
                tuiAgentPending={tuiAgentPending === true}
                onAddTerminalAgent={onAddTerminalAgent}
                terminalAgentStagingKey={terminalAgentStagingKey}
              />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface TerminalAgentSubMenuContentProps {
  readonly epicId: string;
  readonly menuTestId: string;
  readonly workspaceSeed: ForkWorkspaceSeed | null;
  readonly hostScope: HostWorkspaceControlsHostScope;
  readonly tuiAgentPending: boolean;
  readonly onAddTerminalAgent: (
    input: TerminalAgentWorktreeCreateInput,
  ) => void;
  /**
   * Per-parent staging-key override (see `AddArtifactDropdownProps`). When
   * `undefined`, fall back to the epic-scoped `pendingTerminalAgentStagingKey`
   * launcher slot.
   */
  readonly terminalAgentStagingKey: WorktreeStagingKey | undefined;
}

function TerminalAgentSubMenuContent(props: TerminalAgentSubMenuContentProps) {
  const {
    epicId,
    hostScope,
    onAddTerminalAgent,
    tuiAgentPending,
    workspaceSeed,
  } = props;
  const toolbarStore = useComposerToolbarStore(null, null, null, true);
  const selection = useStore(toolbarStore, (state) => state.selection);
  const selectedHarnessId = selection.harnessId;
  const reasoning = useStore(toolbarStore, (state) => state.reasoning);
  const agentMode = useStore(toolbarStore, (state) => state.agentMode);
  const setAgentMode = useStore(toolbarStore, (state) => state.setAgentMode);
  const selectionIsTuiCapable = useStore(
    toolbarStore,
    (state) =>
      state.catalog.harnesses
        ?.find((harness) => harness.id === state.selection.harnessId)
        ?.modes.includes("tui") ?? false,
  );
  const providersQuery = useProvidersList({
    enabled: true,
    subscribed: true,
  });
  const savedArgs = isTuiHarnessId(selectedHarnessId)
    ? (providersQuery.data?.providers.find(
        (provider) =>
          provider.providerId ===
          TUI_HARNESS_ID_TO_PROVIDER_ID[selectedHarnessId],
      )?.terminalAgentArgs ?? "")
    : "";
  const { argsDraft, argsTouched, setArgsDraft } = useTerminalAgentArgsDraft({
    selectedHarnessId,
    savedArgs,
  });
  // A row's submenu passes its per-parent slot; the header / root create passes
  // `undefined`, falling back to the shared epic-scoped launcher slot.
  const overrideStagingKey = props.terminalAgentStagingKey;
  const stagingKey = useMemo(
    () => overrideStagingKey ?? pendingTerminalAgentStagingKey(epicId),
    [overrideStagingKey, epicId],
  );
  const launchDisabled = terminalAgentLaunchDisabled({
    modelSlug: selection.modelSlug,
    selectedHarnessId,
    selectionIsTuiCapable,
    tuiAgentPending,
  });
  const start = useCallback((): void => {
    if (launchDisabled) return;
    if (!isTuiHarnessId(selectedHarnessId)) return;
    const worktreeIntent = readSeededLaunchWorktreeIntent({
      stagingKey,
      fallbackIntent: workspaceSeed?.intent ?? null,
    });
    onAddTerminalAgent({
      harnessId: selectedHarnessId,
      model: selection.modelSlug.length > 0 ? selection.modelSlug : null,
      reasoningEffort: reasoning.length > 0 ? reasoning : null,
      agentMode,
      terminalAgentArgs: argsTouched ? argsDraft : null,
      worktreeIntent,
      workspaceMode: deriveWorkspaceMode(
        workspaceSeed?.workspace.folders.length ?? 1,
        worktreeIntent,
      ),
    });
  }, [
    agentMode,
    argsDraft,
    argsTouched,
    launchDisabled,
    onAddTerminalAgent,
    reasoning,
    selection.modelSlug,
    selectedHarnessId,
    stagingKey,
    workspaceSeed,
  ]);
  const clearStagedIntent = useWorktreeIntentStagingStore(
    (state) => state.clear,
  );

  // The seed flows through the picker's own seeding (the `seedIntent` prop on
  // ActiveHostWorkspaceControls below) as the top-precedence tier - the SAME
  // single seeding authority GUI chat creation uses - so there is no separate
  // seed-application effect racing the folder rows' generic auto-default. We
  // only clear the pending slot on unmount / epic change so a reopened launcher
  // re-seeds fresh from the latest conversation.
  useEffect(() => {
    return () => {
      clearStagedIntent(stagingKey);
    };
  }, [clearStagedIntent, stagingKey]);

  return (
    <>
      <section
        aria-label="Harness"
        data-testid="terminal-agent-harness-section"
        className="flex min-w-0 flex-col gap-2"
      >
        <DropdownMenuLabel className="px-1 pb-0.5 pt-0 text-overline uppercase text-muted-foreground/70">
          Harness
        </DropdownMenuLabel>
        <div className="flex min-w-0 items-center gap-2 px-1">
          <HarnessModelPicker
            store={toolbarStore}
            withServiceTier={false}
            tuiOnly
            lockedHarnessId={null}
            disabled={tuiAgentPending}
            registerActivation={false}
          />
          <div className="shrink-0">
            <AgentModeToggle
              value={agentMode}
              disabled={tuiAgentPending}
              showTooltip={false}
              onChange={setAgentMode}
            />
          </div>
        </div>
      </section>
      <section
        aria-label="Additional arguments"
        data-testid="terminal-agent-args-section"
        className="flex min-w-0 flex-col gap-2"
      >
        <DropdownMenuLabel className="px-1 pb-0.5 pt-0 text-overline uppercase text-muted-foreground/70">
          Additional arguments
        </DropdownMenuLabel>
        <Input
          aria-label="Terminal agent additional arguments"
          className="h-8 min-w-0 font-mono text-ui-xs"
          placeholder="Additional arguments (optional)"
          value={argsDraft}
          disabled={tuiAgentPending}
          onChange={(event) =>
            setArgsDraft(selectedHarnessId, event.target.value)
          }
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key !== "Enter") return;
            event.preventDefault();
            start();
          }}
        />
      </section>
      {/* Host list + Folders section (file-tree-style), staged here and read
          back at launch from the same pending staging key. */}
      <ActiveHostWorkspaceControls
        stagingKey={stagingKey}
        layout="stacked"
        workspaceSeed={workspaceSeed?.workspace ?? null}
        seedIntent={workspaceSeed?.intent ?? null}
        hostScope={hostScope}
      />
      <div className="flex justify-end border-t border-border/60 px-1 pt-3">
        <Button
          type="button"
          size="sm"
          className="h-8"
          disabled={launchDisabled}
          onClick={start}
        >
          {tuiAgentPending ? (
            <AgentSpinningDots
              className="text-current"
              testId={undefined}
              variant={undefined}
            />
          ) : null}
          Start
        </Button>
      </div>
    </>
  );
}

interface TerminalAgentArgsDraftOptions {
  readonly selectedHarnessId: string;
  readonly savedArgs: string;
}

function useTerminalAgentArgsDraft(options: TerminalAgentArgsDraftOptions) {
  const { savedArgs, selectedHarnessId } = options;
  const [argsState, setArgsState] = useState(() => ({
    harnessId: selectedHarnessId,
    draft: savedArgs,
    touched: false,
  }));
  const needsArgsReseed =
    argsState.harnessId !== selectedHarnessId ||
    (!argsState.touched && argsState.draft !== savedArgs);
  if (needsArgsReseed) {
    setArgsState({
      harnessId: selectedHarnessId,
      draft: savedArgs,
      touched: false,
    });
  }
  const setArgsDraft = useCallback((harnessId: string, draft: string): void => {
    setArgsState({
      harnessId,
      draft,
      touched: true,
    });
  }, []);
  return {
    argsDraft: needsArgsReseed ? savedArgs : argsState.draft,
    argsTouched: needsArgsReseed ? false : argsState.touched,
    setArgsDraft,
  };
}

interface TerminalAgentLaunchDisabledOptions {
  readonly modelSlug: string;
  readonly selectedHarnessId: string;
  readonly selectionIsTuiCapable: boolean;
  readonly tuiAgentPending: boolean;
}

function terminalAgentLaunchDisabled(
  options: TerminalAgentLaunchDisabledOptions,
): boolean {
  return (
    options.tuiAgentPending ||
    !options.selectionIsTuiCapable ||
    !isTuiHarnessId(options.selectedHarnessId) ||
    options.modelSlug.length === 0
  );
}
