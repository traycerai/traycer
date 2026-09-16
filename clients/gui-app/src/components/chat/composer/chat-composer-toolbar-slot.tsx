import type { ChatActiveTurn } from "@traycer/protocol/host/agent/gui/subscribe";
import { memo } from "react";

import type { ComposerDictationControl } from "@/components/home/toolbar/composer-mic-button";
import { ComposerToolbar } from "@/components/home/toolbar/composer-toolbar";
import type { DictationPreparingStatus } from "@/hooks/composer/use-dictation-availability";
import type { ComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import type { ProviderTerminalLoginSurface } from "@/lib/providers/provider-terminal-login-surface";

interface ChatComposerToolbarSlotProps {
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
  /** The host "Create new profile" creates on - see `HarnessModelPicker`'s
   *  prop of the same name. */
  readonly createProfileHostId: string | null;
  readonly runTargetHostId: string | null;
  /** Where the picker's setup terminal lands - see `HarnessModelPicker`'s
   *  prop of the same name. */
  readonly terminalLoginSurface: ProviderTerminalLoginSurface | null;
}

/**
 * The toolbar stays fully editable during a turn: a queued message live-mirrors
 * these settings, and steering reconciles any turn-start-baked change through
 * the restart dialog.
 *
 * **There used to be a second component here** - a `PendingChatComposerToolbarSlot`
 * that froze the permission at the moment a turn became pending and rendered
 * "New mode applies to the next turn" once it differed. The sentence was false:
 * `handleComposerSettingsChange` forwards `activePermissionModeUpdate` the
 * moment the mode moves while a run is in progress, the host mutates the
 * running execution's mode on arrival, and `FileEditCoordinator` authorizes
 * against that live value - so a `supervised` turn that was putting every file
 * edit to the user starts auto-approving them, and `full_access` resolves the
 * approvals already on screen. It was also the opposite of what the picker's
 * own mid-turn notice now says, which is the contradiction that retired it.
 *
 * It is not replaced by a corrected sentence, because this surface cannot make
 * one true: the note rendered whenever `activeTurnStatus !== null ||
 * hasPendingApprovals`, while the forward is gated on `runStatus` being
 * `running`/`stopping` - so the same words would be right in one window and
 * wrong in the other. The honest carrier is the PICKER, which speaks at the
 * moment of the choice and knows the mode being chosen (`AUTO_MID_TURN_NOTICE`).
 */
function ChatComposerToolbarSlotImpl(props: ChatComposerToolbarSlotProps) {
  return (
    <ComposerToolbar
      store={props.store}
      onAttachImages={props.onAttachImages}
      canSubmit={props.canSubmit}
      attachmentPending={props.attachmentPending}
      onSubmit={props.onSubmit}
      activeTurnStatus={props.activeTurnStatus}
      stopDisabled={props.stopDisabled}
      onStopTurn={props.onStopTurn}
      composerDisabledHint={props.composerDisabledHint}
      dictation={props.dictation}
      dictationPreparing={props.dictationPreparing}
      settingsLocked={props.settingsLocked}
      createProfileHostId={props.createProfileHostId}
      runTargetHostId={props.runTargetHostId}
      terminalLoginSurface={props.terminalLoginSurface}
    />
  );
}

export const ChatComposerToolbarSlot = memo(ChatComposerToolbarSlotImpl);
