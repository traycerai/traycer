import { memo } from "react";
import { useStore } from "zustand";

import { ComposerSendButton } from "@/components/home/composer/composer-send-button";
import {
  ComposerMicButton,
  ComposerMicPreparing,
  type ComposerDictationControl,
} from "@/components/home/toolbar/composer-mic-button";
import { HarnessModelPicker } from "@/components/home/pickers/harness-model-picker";
import type { DictationPreparingStatus } from "@/hooks/composer/use-dictation-availability";
import type { ChatActiveTurn } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";

interface ComposerToolbarRightProps {
  store: ComposerToolbarStore;
  canSubmit: boolean;
  onSubmit: () => void;
  activeTurnStatus: ChatActiveTurn["status"] | null;
  stopDisabled: boolean;
  onStopTurn: (() => void) | null;
  composerDisabledHint: string | null;
  settingsLocked: boolean;
  /** Voice-input control, or `null` when voice input is disabled/unavailable. */
  dictation: ComposerDictationControl | null;
  /** Non-null while the on-device model is downloading; renders a status chip. */
  dictationPreparing: DictationPreparingStatus | null;
}

function ComposerToolbarRightImpl(props: ComposerToolbarRightProps) {
  const {
    store,
    canSubmit,
    onSubmit,
    activeTurnStatus,
    stopDisabled,
    onStopTurn,
    composerDisabledHint,
    settingsLocked,
    dictation,
    dictationPreparing,
  } = props;
  // Block sending until the model slug resolves to a concrete value - an
  // empty slug is the transient "catalog still loading" marker and must never
  // reach the wire as `model: ""`. Gating HERE (instead of in the host
  // composer's `canSubmit`) keeps the composer from re-rendering when the
  // catalog resolves; the submit handlers re-check via `store.getState()`.
  const modelResolved = useStore(
    store,
    (s) => s.selection.modelSlug.length > 0,
  );
  const canSubmitResolved = canSubmit ? modelResolved : false;

  return (
    <div className="flex min-w-0 items-center justify-end gap-1">
      <HarnessModelPicker
        store={store}
        withServiceTier
        tuiOnly={false}
        lockedHarnessId={null}
        disabled={settingsLocked}
        registerActivation
      />
      {dictation !== null ? <ComposerMicButton control={dictation} /> : null}
      {dictation === null && dictationPreparing !== null ? (
        <ComposerMicPreparing status={dictationPreparing} />
      ) : null}
      <ComposerSendButton
        canSubmit={canSubmitResolved}
        onSubmit={onSubmit}
        activeTurnStatus={activeTurnStatus}
        stopDisabled={stopDisabled}
        onStopTurn={onStopTurn}
        disabledHint={composerDisabledHint}
      />
    </div>
  );
}

export const ComposerToolbarRight = memo(ComposerToolbarRightImpl);
