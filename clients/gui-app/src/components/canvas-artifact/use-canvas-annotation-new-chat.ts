import { useCallback, useMemo } from "react";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { CanvasAnnotationRecord } from "@traycer/protocol/persistence/epic/messages";
import { appendCommentTextToNewConversationDraft } from "@/components/chat/quote/append-comment-text-to-draft";
import { useHostNegotiatedMethodVersions } from "@/hooks/host/use-host-negotiated-method-version";
import type { CanvasBox } from "@/lib/sandbox/canvas-bridge";
import { useNewConversationAnnotationStore } from "@/stores/epics/new-conversation-annotation-store";
import { useNewConversationModalOpenStore } from "@/stores/epics/new-conversation-modal-open-store";
import type { CanvasAnnotationScope } from "./canvas-annotation-action";
import { prepareCanvasAnnotationCrop } from "./canvas-annotation-attach";
import { captureCanvasAnnotationCrop } from "./canvas-annotation-send";

/** The create minor whose first message carries the annotation sidecar. */
const NEW_CHAT_ANNOTATION_MINOR = 5;

export interface CanvasAnnotationNewChat {
  /**
   * Whether the tab's host can create a chat whose first message carries the
   * card. Below that, New chat is not offered at all: offering it and
   * delivering a message without the card would be worse than its absence.
   */
  readonly supported: boolean;
  /**
   * Captures the element, puts the card (and the typed text, if any) into
   * the new-conversation modal's draft and opens the modal. Nothing is
   * created until the user sends.
   */
  readonly send: (input: {
    readonly record: CanvasAnnotationRecord;
    readonly captureRect: CanvasBox | null;
    readonly text: JsonContent | null;
  }) => Promise<void>;
}

export function useCanvasAnnotationNewChat(
  scope: CanvasAnnotationScope,
): CanvasAnnotationNewChat {
  // Read by host id, not through a client: this runs inside the artifact's
  // frame overlays and comment popovers, outside any host runtime provider.
  const hostIds = useMemo(() => [scope.hostId], [scope.hostId]);
  const version =
    useHostNegotiatedMethodVersions(hostIds, "epic.createChat").get(
      scope.hostId,
    ) ?? null;
  const supported =
    version !== null &&
    version !== false &&
    version.major === 1 &&
    version.minor >= NEW_CHAT_ANNOTATION_MINOR;
  const openModal = useNewConversationModalOpenStore((state) => state.open);
  const { epicId, viewTabId } = scope;
  const send = useCallback(
    async (input: {
      readonly record: CanvasAnnotationRecord;
      readonly captureRect: CanvasBox | null;
      readonly text: JsonContent | null;
    }): Promise<void> => {
      // Capture first, before the modal opens over the element.
      const crop = await captureCanvasAnnotationCrop(input.captureRect);
      const record = await prepareCanvasAnnotationCrop(input.record, crop);
      useNewConversationAnnotationStore.getState().add(epicId, record);
      if (input.text !== null)
        appendCommentTextToNewConversationDraft(epicId, input.text);
      openModal({
        epicId,
        tabId: viewTabId,
        placement: null,
        parentId: null,
        // An artifact lives on every host serving the epic, so the new chat
        // takes the epic's normal placement rather than a named machine.
        hostId: null,
      });
    },
    [epicId, viewTabId, openModal],
  );
  return { supported, send };
}
