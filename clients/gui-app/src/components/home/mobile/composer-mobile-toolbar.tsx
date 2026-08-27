import { memo, useState } from "react";
import { useStore } from "zustand";

import { ComposerSendButton } from "@/components/home/composer/composer-send-button";
import { ComposerOptionsSheet } from "@/components/home/mobile/composer-options-sheet";
import {
  findPermissionOption,
  normalizePermissionMode,
} from "@/components/home/data/landing-options";
import { HarnessModelPicker } from "@/components/home/pickers/harness-model-picker";
import {
  ComposerMicButton,
  ComposerMicPreparing,
  type ComposerDictationControl,
} from "@/components/home/toolbar/composer-mic-button";
import { DictationRecordingBar } from "@/components/home/toolbar/dictation-recording-bar";
import { ComposerAttachImageButton } from "@/components/home/toolbar/composer-attach-image-button";
import { ToolbarPillButton } from "@/components/home/toolbar/toolbar-buttons";
import type { DictationPreparingStatus } from "@/hooks/composer/use-dictation-availability";
import type { ChatActiveTurn } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";

interface ComposerMobileToolbarProps {
  readonly store: ComposerToolbarStore;
  readonly onAttachImages: (files: ReadonlyArray<File>) => void;
  readonly canSubmit: boolean;
  readonly attachmentPending: boolean;
  readonly onSubmit: () => void;
  readonly activeTurnStatus: ChatActiveTurn["status"] | null;
  readonly stopDisabled: boolean;
  readonly onStopTurn: (() => void) | null;
  readonly composerDisabledHint: string | null;
  readonly dictation: ComposerDictationControl | null;
  readonly dictationPreparing: DictationPreparingStatus | null;
  readonly settingsLocked: boolean;
  /** The host "Create new profile" creates on - see `HarnessModelPicker`. */
  readonly createProfileHostId: string | null;
  readonly runTargetHostId: string | null;
}

/**
 * Phone-width toolbar row. It keeps the DESKTOP arrangement - attach on the
 * left, model / mic / send on the right - so the composer does not read as a
 * different control set between the two clients. Only the agent-mode pill
 * moves out, into `ComposerOptionsSheet`, because six pills do not fit a
 * ~21rem row; the permission pill doubles as that sheet's trigger.
 *
 * The desktop `ComposerToolbar` is untouched and still serves every other
 * composer surface.
 */
function ComposerMobileToolbarImpl(props: ComposerMobileToolbarProps) {
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
  } = props;

  const [optionsOpen, setOptionsOpen] = useState(false);

  const permission = useStore(store, (s) => s.permission);
  const supportedPermissionModes = useStore(
    store,
    (s) => s.supportedPermissionModes,
  );
  const harnessLabel = useStore(store, (s) => s.harnessLabel);
  const setPermission = useStore(store, (s) => s.setPermission);
  // Same gate as `ComposerToolbarRight`: an empty slug is the transient
  // "catalog still loading" marker and must never reach the wire as `model: ""`.
  const modelResolved = useStore(
    store,
    (s) => s.selection.modelSlug.length > 0,
  );
  const canSubmitResolved = canSubmit ? modelResolved : false;
  // Mirror the desktop picker: show the mode the harness will actually run,
  // never a stale sticky it does not honor.
  const permissionOption = findPermissionOption(
    normalizePermissionMode(permission, supportedPermissionModes),
  );
  const PermissionIcon = permissionOption.icon;

  // While dictation is active the whole row becomes the recording strip, as on
  // desktop - the controls return on stop.
  const recordingDictation =
    dictation !== null &&
    (dictation.state === "recording" || dictation.state === "transcribing")
      ? dictation
      : null;

  if (recordingDictation !== null) {
    return (
      <div className="min-w-0 px-2.5 pb-2.5 pt-1">
        <DictationRecordingBar
          state={recordingDictation.state}
          getStream={recordingDictation.getStream}
          onStop={recordingDictation.onStop}
          onCancel={recordingDictation.onCancel}
        />
      </div>
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-1 px-2.5 pb-2.5 pt-1">
      <ComposerAttachImageButton onAttachImages={onAttachImages} />
      {/* Icon-only, exactly as `PermissionsPicker` renders itself under
          `@max-lg` on desktop - the label would truncate to "Full acce..." at
          this width and steal room the model name needs. The mode still reads
          from the glyph, and the accessible name spells it out.

          Not `PermissionsPicker` itself: its dropdown would nest a Radix layer
          inside the vaul drawer. Deliberately not disabled by `settingsLocked`
          either - this is also the only route to the agent-mode rows, which
          must stay reachable; the sheet's own rows carry the lock. */}
      <ToolbarPillButton
        aria-label={`Permissions: ${permissionOption.label}`}
        data-testid="composer-mobile-options-trigger"
        className="size-8 shrink-0 justify-center px-0"
        onClick={() => {
          setOptionsOpen(true);
        }}
      >
        <PermissionIcon className="size-4 shrink-0" />
      </ToolbarPillButton>
      <div className="ml-auto flex min-w-0 shrink items-center gap-1">
        <HarnessModelPicker
          store={store}
          withServiceTier
          tuiOnly={false}
          lockedHarnessId={null}
          disabled={settingsLocked}
          registerActivation
          createProfileHostId={createProfileHostId}
          runTargetHostId={runTargetHostId}
          // Per-row profile admission is the TUI fork dialog's concern only.
          profileAdmission={null}
          // Model name only: the row has room for it, but the thinking-effort
          // suffix the desktop pill adds reads as clutter at this width.
          labelDisplay="model-only"
        />
        {dictation !== null ? <ComposerMicButton control={dictation} /> : null}
        {dictation === null && dictationPreparing !== null ? (
          <ComposerMicPreparing status={dictationPreparing} />
        ) : null}
        <ComposerSendButton
          canSubmit={canSubmitResolved}
          attachmentPending={attachmentPending}
          onSubmit={onSubmit}
          activeTurnStatus={activeTurnStatus}
          stopDisabled={stopDisabled}
          onStopTurn={onStopTurn}
          disabledHint={composerDisabledHint}
        />
      </div>
      <ComposerOptionsSheet
        open={optionsOpen}
        onOpenChange={setOptionsOpen}
        permission={permission}
        onPermissionChange={setPermission}
        supportedPermissionModes={supportedPermissionModes}
        harnessLabel={harnessLabel}
        settingsLocked={settingsLocked}
      />
    </div>
  );
}

export const ComposerMobileToolbar = memo(ComposerMobileToolbarImpl);
