import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ChevronDown, MessageSquareShare } from "lucide-react";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { ChatTargetMenu } from "@/components/epic-canvas/renderers/chat-target-menu/chat-target-menu";
import { useRevealChatInTab } from "@/components/epic-canvas/renderers/use-reveal-chat-in-tab";
import { appendCommentTextToDraft } from "@/components/chat/quote/append-comment-text-to-draft";
import type { CanvasAnnotationScope } from "@/components/canvas-artifact/canvas-annotation-action";
import {
  canvasSelectionAnnotationRecord,
  captureAndAttachCanvasAnnotation,
} from "@/components/canvas-artifact/canvas-annotation-send";
import { canvasSelectionCaptureRect } from "@/components/canvas-artifact/canvas-selection-geometry";
import type { CanvasSelection } from "@/components/canvas-artifact/canvas-selection-store";
import { useCanvasAnnotationChatTargets } from "@/components/canvas-artifact/use-canvas-annotation-chat-targets";
import { useArtifactObjectTextQuery } from "@/hooks/files/use-artifact-object-text-query";
import { canvasMutationKeys } from "@/lib/query-keys/canvas-mutation-keys";

/** What the draft box needs from the surface to send its element to a chat. */
export interface AnchoredDraftSendToChatSurface {
  readonly scope: CanvasAnnotationScope;
  /** The mounted frame the selection's board is showing in, if any. */
  readonly frameFor: (boardPath: string) => HTMLIFrameElement | null;
}

interface AnchoredDraftSendToChatProps {
  readonly surface: AnchoredDraftSendToChatSurface;
  readonly selection: CanvasSelection;
  readonly readDraft: () => JsonContent;
  readonly disabled: boolean;
  readonly onSent: () => void;
  readonly onFailure: (text: string) => void;
}

/**
 * The footer slot: present only where there is an element to send. A draft
 * pinned on blank canvas or on the whole page has no capture to carry.
 */
export function AnchoredDraftSendToChatSlot(
  props: Omit<AnchoredDraftSendToChatProps, "surface" | "selection"> & {
    readonly surface: AnchoredDraftSendToChatSurface | null;
    readonly selection: CanvasSelection | null;
  },
) {
  const { surface, selection, ...rest } = props;
  if (surface === null || selection === null) return null;
  return (
    <AnchoredDraftSendToChat
      {...rest}
      surface={surface}
      selection={selection}
    />
  );
}

/**
 * The draft box's other destination. Picking a chat moves everything the box
 * holds: the element goes as the same annotation card the selection bar
 * attaches, and the typed text becomes the chat composer's text. The box then
 * closes for good - a draft that was sent somewhere has nothing left to keep.
 */
function AnchoredDraftSendToChat(props: AnchoredDraftSendToChatProps) {
  const { scope, frameFor } = props.surface;
  const targets = useCanvasAnnotationChatTargets(scope);
  const revealChat = useRevealChatInTab(scope);
  const source = useArtifactObjectTextQuery(scope.hostId, {
    epicId: scope.epicId,
    sha256: props.selection.servedSha256,
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const send = useMutation({
    mutationKey: canvasMutationKeys.attach(scope.artifactId),
    mutationFn: async (chatId: string) => {
      // Read the text before anything moves: the capture and the attach are
      // async, and the box is gone once they land.
      const text = props.readDraft();
      const record = canvasSelectionAnnotationRecord(
        scope,
        props.selection,
        source.data,
      );
      const frame = frameFor(props.selection.boardPath);
      await captureAndAttachCanvasAnnotation({
        chatId,
        record,
        captureRect:
          frame === null
            ? null
            : canvasSelectionCaptureRect(frame, props.selection.element.box),
      });
      appendCommentTextToDraft(chatId, text);
      return chatId;
    },
    onSuccess: (chatId) => {
      setMenuOpen(false);
      props.onSent();
      revealChat(chatId);
    },
    onError: (error: Error) => {
      setMenuOpen(false);
      props.onFailure(error.message);
    },
  });
  return (
    <ChatTargetMenu
      targets={targets}
      onSelectChat={(chatId) => send.mutate(chatId)}
      onSelectNewChat={null}
      open={menuOpen}
      onOpenChange={setMenuOpen}
      trigger={
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={props.disabled || send.isPending || targets.length === 0}
          aria-label="Send to chat"
        >
          {send.isPending ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
          ) : (
            <MessageSquareShare aria-hidden="true" />
          )}
          Send to chat
          <ChevronDown className="text-muted-foreground" aria-hidden="true" />
        </Button>
      }
    />
  );
}
