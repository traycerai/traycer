import { createContext, use, useState } from "react";
import {
  createComposerPickerStore,
  type ComposerPickerStore,
} from "@/components/chat/composer/picker/composer-picker-store";

export interface NewConversationTransientState {
  readonly pickerStore: ComposerPickerStore;
}

/**
 * The composer picker store, which must outlive the modal body's unmount.
 * `DialogContent` un-presents by unmounting when the Epic pane loses focus (a
 * mounted modal would aria-hide + scroll-lock the focused partner), which would
 * otherwise reset the picker. This lives on the always-mounted
 * `NewConversationModalDialog`, so a focus round-trip restores it. (The editor
 * caret is persisted separately in the draft store alongside the prompt bytes.)
 * `null` outside the dialog (isolated body tests), where the hook falls back to
 * a component-local store.
 */
export const NewConversationTransientContext =
  createContext<NewConversationTransientState | null>(null);

export function useNewConversationTransient(): NewConversationTransientState {
  const provided = use(NewConversationTransientContext);
  const [local] = useState<NewConversationTransientState>(() => ({
    pickerStore: createComposerPickerStore(),
  }));
  return provided ?? local;
}
