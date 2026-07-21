import { memo } from "react";
import { useStore } from "zustand";

import { ComposerToolbarLeft } from "@/components/home/toolbar/composer-toolbar-left";
import { ComposerToolbarRight } from "@/components/home/toolbar/composer-toolbar-right";
import { DictationRecordingBar } from "@/components/home/toolbar/dictation-recording-bar";
import type { ComposerDictationControl } from "@/components/home/toolbar/composer-mic-button";
import type { DictationPreparingStatus } from "@/hooks/composer/use-dictation-availability";
import type { ChatActiveTurn } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";

interface ComposerToolbarProps {
  /** Per-composer toolbar store; this component subscribes to the slices the
   *  left group renders, leaves stay presentational. */
  store: ComposerToolbarStore;
  onAttachImages: (files: ReadonlyArray<File>) => void;
  showNextTurnPermissionNote: boolean;
  showAgentModeTooltip: boolean;
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
}

function ComposerToolbarImpl(props: ComposerToolbarProps) {
  const {
    store,
    onAttachImages,
    showNextTurnPermissionNote,
    showAgentModeTooltip,
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
  } = props;

  // Left-group slices. The store is the single source for harness-level
  // permission capabilities (no parallel `useGuiHarnessesQuery` here).
  const permission = useStore(store, (s) => s.permission);
  const agentMode = useStore(store, (s) => s.agentMode);
  const supportedPermissionModes = useStore(
    store,
    (s) => s.supportedPermissionModes,
  );
  const harnessLabel = useStore(store, (s) => s.harnessLabel);
  const setPermission = useStore(store, (s) => s.setPermission);
  const setAgentMode = useStore(store, (s) => s.setAgentMode);

  // While dictation is active the whole bottom row becomes the recording strip
  // (Codex-style) - the model/permission/send controls return on stop.
  const recordingDictation =
    dictation !== null &&
    (dictation.state === "recording" || dictation.state === "transcribing")
      ? dictation
      : null;

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-2 gap-y-1.5 px-2.5 pb-2.5 pt-1">
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
          <ComposerToolbarLeft
            onAttachImages={onAttachImages}
            permission={permission}
            onPermissionChange={setPermission}
            supportedPermissionModes={supportedPermissionModes}
            harnessLabel={harnessLabel}
            agentMode={agentMode}
            onAgentModeChange={setAgentMode}
            showNextTurnPermissionNote={
              showNextTurnPermissionNote ? !settingsLocked : false
            }
            showAgentModeTooltip={showAgentModeTooltip}
            settingsLocked={settingsLocked}
          />
          <ComposerToolbarRight
            store={store}
            canSubmit={canSubmit}
            attachmentPending={attachmentPending}
            onSubmit={onSubmit}
            activeTurnStatus={activeTurnStatus}
            stopDisabled={stopDisabled}
            onStopTurn={onStopTurn}
            composerDisabledHint={composerDisabledHint}
            settingsLocked={settingsLocked}
            dictation={dictation}
            dictationPreparing={dictationPreparing}
            createProfileHostId={createProfileHostId}
            runTargetHostId={runTargetHostId}
          />
        </>
      )}
    </div>
  );
}

export const ComposerToolbar = memo(ComposerToolbarImpl);
