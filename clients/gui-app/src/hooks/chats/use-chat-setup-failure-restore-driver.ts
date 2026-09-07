import { useEffect, useMemo, useState } from "react";
import { useStore } from "zustand";
import { selectRestorableSetupInterruption } from "@/stores/chats/chat-session-selectors";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import { reportableErrorToast } from "@/lib/reportable-error-toast";

/** Dedupe by eventId so reconnect echoes do not overwrite an edited draft. */
interface ChatSetupFailureRestoreDriverOptions {
  readonly handle: ChatSessionStoreHandle;
  readonly nodeId: string;
}

export function useChatSetupFailureRestoreDriver(
  options: ChatSetupFailureRestoreDriverOptions,
): void {
  const { handle, nodeId } = options;
  const events = useStore(handle.store, (state) => state.events);
  // Subscribe inputs separately; a combined selector would allocate a new object every call.
  const transcriptDerived = useStore(
    handle.store,
    (state) => state.transcriptDerived,
  );
  // Subscribe the window identity, not nested liveEvents.
  const transcriptWindow = useStore(
    handle.store,
    (state) => state.transcriptWindow,
  );
  const interruption = useMemo(
    () =>
      selectRestorableSetupInterruption({
        events,
        transcriptDerived,
        transcriptWindow,
      }),
    [events, transcriptDerived, transcriptWindow],
  );
  const replaceDraft = useComposerDraftStore((state) => state.replaceDraft);
  // Storing the bound handle in `useState` and resetting on render-time prop change is the React 19 idiomatic way to reset derived state without an effect (the runtime restarts the render after the in-render `setState`, so the rest of the hook reads the fresh `Set`).
  const [dedupe, setDedupe] = useState<{
    readonly handle: ChatSessionStoreHandle;
    readonly ids: Set<string>;
  }>(() => ({ handle, ids: new Set() }));
  if (dedupe.handle !== handle) {
    setDedupe({ handle, ids: new Set() });
  }

  useEffect(() => {
    if (interruption === null) return;
    const eventId = interruption.eventId;
    if (dedupe.ids.has(eventId)) return;
    dedupe.ids.add(eventId);
    const restored = handle.store
      .getState()
      .takeSetupFailedRestoration(interruption.messageId);
    if (restored === null) return;
    replaceDraft(nodeId, restored, null);
    // A path-less setup failure (the generic `SETUP_AWAIT_FAILED` catch-all, which carries no `workspacePath`) produces NO setup card - the deriver can't anchor a card without a workspace - so this toast is the only failure feedback, restoring the parity the old failure banner provided.
    if (
      interruption.eventType === "setup.failed" &&
      (interruption.workspacePath === null ||
        interruption.workspacePath.length === 0)
    ) {
      reportableErrorToast(
        "Setup failed before the first message could run.",
        undefined,
        {
          title: "Workspace setup failed",
          message: "Setup failed before the first message could run.",
          code: null,
          source: "Chat setup",
        },
      );
    }
  }, [dedupe, interruption, handle.store, nodeId, replaceDraft]);
}
