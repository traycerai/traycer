import type { ChatActiveTurn } from "@traycer/protocol/host/agent/gui/subscribe";
import { memo, useState } from "react";
import { useStore } from "zustand";

import type { ComposerDictationControl } from "@/components/home/toolbar/composer-mic-button";
import { ComposerToolbar } from "@/components/home/toolbar/composer-toolbar";
import type { DictationPreparingStatus } from "@/hooks/composer/use-dictation-availability";
import type {
  ComposerToolbarStore,
  ComposerToolbarStoreState,
} from "@/stores/composer/composer-toolbar-store";
import type { PermissionMode } from "@/components/home/data/landing-options";

interface ChatComposerToolbarSlotProps {
  readonly store: ComposerToolbarStore;
  readonly onAttachImages: (files: ReadonlyArray<File>) => void;
  readonly canSubmit: boolean;
  readonly attachmentPending: boolean;
  readonly onSubmit: () => void;
  readonly activeTurnStatus: ChatActiveTurn["status"] | null;
  readonly hasPendingApprovals: boolean;
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
}

interface ChatComposerToolbarSlotViewProps extends ChatComposerToolbarSlotProps {
  readonly showNextTurnPermissionNote: boolean;
}

function selectPermission(state: ComposerToolbarStoreState): PermissionMode {
  return state.permission;
}

function ChatComposerToolbarSlotImpl(props: ChatComposerToolbarSlotProps) {
  // The toolbar stays fully editable during a turn: a queued message
  // live-mirrors these settings and steering reconciles any turn-start-baked
  // change via the restart dialog. Only this soft permission note signals a
  // pending turn - tracked here (not in ChatComposer) so the host composer
  // never subscribes to permission changes.
  if (props.activeTurnStatus !== null || props.hasPendingApprovals) {
    return <PendingChatComposerToolbarSlot {...props} />;
  }
  return (
    <ChatComposerToolbarSlotView
      {...props}
      showNextTurnPermissionNote={false}
    />
  );
}

function PendingChatComposerToolbarSlot(props: ChatComposerToolbarSlotProps) {
  const permission = useStore(props.store, selectPermission);
  const [permissionAtPendingStart] = useState(permission);
  return (
    <ChatComposerToolbarSlotView
      {...props}
      showNextTurnPermissionNote={permissionAtPendingStart !== permission}
    />
  );
}

function ChatComposerToolbarSlotView(props: ChatComposerToolbarSlotViewProps) {
  return (
    <ComposerToolbar
      store={props.store}
      onAttachImages={props.onAttachImages}
      showNextTurnPermissionNote={props.showNextTurnPermissionNote}
      showAgentModeTooltip={false}
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
    />
  );
}

export const ChatComposerToolbarSlot = memo(ChatComposerToolbarSlotImpl);
