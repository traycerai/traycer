import type { AutoJudgeBilling } from "@/lib/auto-mode/auto-judge-billing";
import { memo, useMemo, type ReactNode } from "react";
import { useStore } from "zustand";

import {
  autoModeOfferableHere,
  catalogSupportedPermissionModes,
} from "@/components/home/data/landing-options";
import { useHostMethodSchemaVersion } from "@/hooks/host/use-host-supports-method";
import { useAutoJudgeBilling } from "@/hooks/auto-mode/use-auto-judge-billing";
import { ComposerToolbarLeft } from "@/components/home/toolbar/composer-toolbar-left";
import { ComposerToolbarRight } from "@/components/home/toolbar/composer-toolbar-right";
import { DictationRecordingBar } from "@/components/home/toolbar/dictation-recording-bar";
import type { ComposerDictationControl } from "@/components/home/toolbar/composer-mic-button";
import type { DictationPreparingStatus } from "@/hooks/composer/use-dictation-availability";
import type { ChatActiveTurn } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import type { ProviderTerminalLoginSurface } from "@/lib/providers/provider-terminal-login-surface";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { customizeLayoutAction } from "@/lib/commands/actions/customize-layout";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useCustomizeStore } from "@/stores/customize/customize-store";

interface ComposerToolbarProps {
  /** Passive sample chrome: no host hooks, activation slots or send action. */
  readonly presentation?: boolean;
  /** Per-composer toolbar store; this component subscribes to the slices the
   *  left group renders, leaves stay presentational. */
  store: ComposerToolbarStore;
  onAttachImages: (files: ReadonlyArray<File>) => void;
  canSubmit: boolean;
  attachmentPending: boolean;
  onSubmit: () => void;
  activeTurnStatus: ChatActiveTurn["status"] | null;
  stopDisabled: boolean;
  onStopTurn: (() => void) | null;
  /**
   * When non-null, the composer can't create an epic (e.g. no workspace
   * folder selected): the send button and terminal-agent launchers render
   * disabled with this string as their tooltip. `null` means enabled.
   */
  composerDisabledHint: string | null;
  /** Voice-input control, or `null` when voice input is disabled/unavailable. */
  dictation: ComposerDictationControl | null;
  /**
   * Non-null while the on-device model is still being readied (engine present,
   * model downloading/absent/errored); renders a status indicator in the mic
   * slot. Null when ready or when voice input is off/unsupported.
   */
  dictationPreparing: DictationPreparingStatus | null;
  settingsLocked: boolean;
  /** The host "Create new profile" creates on - see `HarnessModelPicker`'s
   *  prop of the same name. */
  createProfileHostId: string | null;
  readonly runTargetHostId: string | null;
  /** Where the picker's setup terminal lands - see `HarnessModelPicker`'s
   *  prop of the same name. */
  readonly terminalLoginSurface: ProviderTerminalLoginSurface | null;
  /**
   * Whether THIS chat's negotiated `chat.subscribe` line can carry `auto`, or
   * `null` on a composer with no chat session in scope (the landing composer).
   * See {@link autoModeOfferableHere} for why the catalog line alone is not
   * enough, and why this cannot be read per-host.
   */
  readonly chatLineCarriesAutoMode: boolean | null;
}

function ComposerToolbarLive(props: ComposerToolbarProps) {
  const listHarnessesLine = useHostMethodSchemaVersion(
    props.runTargetHostId,
    "agent.gui.listHarnesses",
  );
  const hostKnowsAutoMode =
    props.runTargetHostId === null
      ? null
      : autoModeOfferableHere(listHarnessesLine, props.chatLineCarriesAutoMode);
  const runHarnessId = useStore(
    props.store,
    (state) => state.selection.harnessId,
  );
  const judgeBilling = useAutoJudgeBilling(props.runTargetHostId, runHarnessId);
  return (
    <ComposerToolbarView
      {...props}
      hostKnowsAutoMode={hostKnowsAutoMode}
      judgeBilling={judgeBilling}
    />
  );
}
function ComposerToolbarImpl(props: ComposerToolbarProps) {
  return props.presentation ? (
    <ComposerToolbarView
      {...props}
      hostKnowsAutoMode={null}
      judgeBilling={null}
    />
  ) : (
    <ComposerToolbarLive {...props} />
  );
}
function ComposerToolbarView(
  props: ComposerToolbarProps & {
    readonly hostKnowsAutoMode: boolean | null;
    readonly judgeBilling: AutoJudgeBilling | null;
  },
) {
  const {
    store,
    onAttachImages,
    canSubmit,
    attachmentPending,
    onSubmit,
    activeTurnStatus,
    stopDisabled,
    onStopTurn,
    composerDisabledHint,
    dictation,
    dictationPreparing,
    settingsLocked,
    createProfileHostId,
    runTargetHostId,
    terminalLoginSurface,
    hostKnowsAutoMode,
    judgeBilling,
  } = props;

  // Left-group slices. The store is the single source for harness-level
  // permission capabilities (no parallel `useGuiHarnessesQuery` here).
  const permission = useStore(store, (s) => s.permission);
  const supportedPermissionModes = useStore(
    store,
    (s) => s.supportedPermissionModes,
  );
  const storedHarnessLabel = useStore(store, (s) => s.harnessLabel);
  const harnessLabel = props.presentation
    ? "Sample provider"
    : storedHarnessLabel;
  const setPermission = useStore(store, (s) => s.setPermission);
  // The union across the WHOLE catalog, so the picker can tell "this host
  // predates `auto`" from "this provider declines it". Memoized on the
  // catalog's own array identity - the store keeps that reference stable
  // across unrelated state changes, so this recomputes only when the host's
  // harness list actually moves.
  const harnesses = useStore(store, (s) => s.catalog.harnesses);
  const catalogSupportedModes = useMemo(
    () => catalogSupportedPermissionModes(harnesses),
    [harnesses],
  );
  // While dictation is active the whole bottom row becomes the recording strip
  // (Codex-style) - the model/permission/send controls return on stop.
  const recordingDictation =
    !props.presentation &&
    dictation !== null &&
    (dictation.state === "recording" || dictation.state === "transcribing")
      ? dictation
      : null;

  const editing = useCustomizeStore((state) => state.session !== null);
  const narrowViewport = useIsMobileViewport();
  const featureEnabled = useSettingsStore(
    (state) => state.visualLayoutEditorEnabled,
  );
  const showCustomizeEntry =
    featureEnabled && !editing && !narrowViewport && !props.presentation;

  // Both clusters render through the same `renderToolbarItem` map now that an
  // item may move between them, so both need the full prop set - what used to
  // be split into "left's props" and "right's props" is one shared object.
  const itemProps = {
    presentation: props.presentation === true,
    onAttachImages,
    permission,
    onPermissionChange: setPermission,
    supportedPermissionModes,
    harnessLabel,
    catalogSupportedModes,
    hostKnowsAutoMode,
    // A turn the user can still switch a mode underneath - which the host
    // honours IMMEDIATELY for the running turn, not from the next message;
    // the picker's own mid-turn notice is what says so. `settingsLocked`
    // surfaces cannot flip at all.
    turnActive: activeTurnStatus !== null && !settingsLocked,
    judgeBilling,
    settingsLocked,
    store,
    createProfileHostId,
    runTargetHostId,
    terminalLoginSurface,
    dictation,
    dictationPreparing,
  };

  return (
    <ComposerToolbarContextMenu enabled={showCustomizeEntry}>
      <div
        inert={props.presentation}
        className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-2 gap-y-1.5 px-2.5 pb-2.5 pt-1"
      >
        {recordingDictation !== null ? (
          <div className="col-span-2 min-w-0">
            <DictationRecordingBar
              state={recordingDictation.state}
              getStream={recordingDictation.getStream}
              onStop={recordingDictation.onStop}
              onCancel={recordingDictation.onCancel}
            />
          </div>
        ) : (
          <>
            <ComposerToolbarLeft {...itemProps} />
            <ComposerToolbarRight
              {...itemProps}
              canSubmit={props.presentation ? false : canSubmit}
              attachmentPending={attachmentPending}
              onSubmit={onSubmit}
              activeTurnStatus={props.presentation ? null : activeTurnStatus}
              stopDisabled={stopDisabled}
              onStopTurn={props.presentation ? null : onStopTurn}
              composerDisabledHint={composerDisabledHint}
            />
          </>
        )}
      </div>
    </ComposerToolbarContextMenu>
  );
}

export const ComposerToolbar = memo(ComposerToolbarImpl);

/**
 * The composer toolbar's own right-click entry into Customize - the toolbar
 * has no context menu of its own to append to, so this adds a minimal one,
 * outside a session and only when the switch is on.
 */
function ComposerToolbarContextMenu(props: {
  readonly enabled: boolean;
  readonly children: ReactNode;
}): ReactNode {
  // Gate interaction, not ancestors: switching Customize must retain live leaves.
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={!props.enabled}>
        {props.children}
      </ContextMenuTrigger>
      {props.enabled ? (
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => customizeLayoutAction("direct_ui")}>
            Customize layout…
          </ContextMenuItem>
        </ContextMenuContent>
      ) : null}
    </ContextMenu>
  );
}
