import type { RefObject } from "react";
import { blurTextEntry } from "@/components/layout/shell/shell-gestures";
import type { ComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import { clearHostHeldImageHashes } from "@/lib/composer/host-held-image-hashes";
import { submitComposerDraft } from "@/lib/drafts/draft-mirror-coordinator";
import { isMobileApp } from "@/lib/mobile-app";
import type { ComposerPromptEditorHandle } from "./composer-prompt-editor";

/**
 * Everything an ACCEPTED submit does to the composer, shared by the send and
 * side-chat paths. The draft is retired, not kept: cleared here and deleted
 * from its host, so it never lands in Drafts.
 */
export function clearChatComposerDraft(input: {
  readonly taskId: string;
  readonly pickerStore: ComposerPickerStore;
  readonly editorRef: RefObject<ComposerPromptEditorHandle | null>;
}): void {
  void submitComposerDraft(input.taskId);
  input.pickerStore.getState().reset();
  // The inherited queue-edit document is gone with the send, so its
  // host-custody claim goes with it. Hygiene only - a stale entry would leave
  // a hash bare on a later send, which is what this composer did before any
  // of this existed.
  clearHostHeldImageHashes(input.taskId);
  input.editorRef.current?.clear();
  // A rejected send leaves the text in place, and dropping the keyboard
  // there would take the user away from the message they still have to fix.
  // On a phone the keyboard covers most of the screen, so holding it open
  // after a send hides the reply the send was for.
  if (isMobileApp()) blurTextEntry();
}
