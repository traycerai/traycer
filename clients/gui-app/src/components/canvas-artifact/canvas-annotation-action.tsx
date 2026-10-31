import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { CanvasAnnotationRecord } from "@traycer/protocol/persistence/epic/messages";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { MessageSquareShare } from "lucide-react";
import { ToolbarActionButton } from "@/editor-core/toolbar/toolbar-action-button";
import { ChatTargetMenu } from "@/components/epic-canvas/renderers/chat-target-menu/chat-target-menu";
import { useChatTargetMenuClosed } from "@/components/epic-canvas/renderers/chat-target-menu/use-chat-target-menu-closed";
import { useRevealChatInTab } from "@/components/epic-canvas/renderers/use-reveal-chat-in-tab";
import { useArtifactObjectTextQuery } from "@/hooks/files/use-artifact-object-text-query";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import { canvasMutationKeys } from "@/lib/query-keys/canvas-mutation-keys";
import type { CanvasBox } from "@/lib/sandbox/canvas-bridge";
import {
  canvasSelectionAnnotationRecord,
  captureAndAttachCanvasAnnotation,
} from "./canvas-annotation-send";
import type { CanvasSelection } from "./canvas-selection-store";
import { useCanvasAnnotationChatTargets } from "./use-canvas-annotation-chat-targets";
import { useCanvasAnnotationNewChat } from "./use-canvas-annotation-new-chat";

export interface CanvasAnnotationScope {
  readonly epicId: string;
  readonly artifactId: string;
  readonly artifactTitle: string;
  /** What the artifact is; comments and quotes are keyed by it. */
  readonly artifactType: "canvas" | "html";
  readonly hostId: string;
  readonly viewTabId: string;
}

export function CanvasSelectionAction(props: {
  readonly scope: CanvasAnnotationScope;
  readonly selection: CanvasSelection;
  readonly captureRect: () => CanvasBox | null;
}) {
  const source = useArtifactObjectTextQuery(props.scope.hostId, {
    epicId: props.scope.epicId,
    sha256: props.selection.servedSha256,
  });
  return (
    <CanvasAnnotationAction
      scope={props.scope}
      record={() =>
        canvasSelectionAnnotationRecord(
          props.scope,
          props.selection,
          source.data,
        )
      }
      captureRect={props.captureRect}
    />
  );
}

export function CanvasAnnotationAction(props: {
  readonly scope: CanvasAnnotationScope;
  readonly record: () => CanvasAnnotationRecord;
  readonly captureRect: () => CanvasBox | null;
}) {
  const targets = useCanvasAnnotationChatTargets(props.scope);
  const newChat = useCanvasAnnotationNewChat(props.scope);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuClosed = useChatTargetMenuClosed(setMenuOpen);
  const [attached, setAttached] = useState<{
    chatId: string;
    record: CanvasAnnotationRecord;
  } | null>(null);
  const revealChat = useRevealChatInTab(props.scope);
  const mutation = useMutation({
    mutationKey: canvasMutationKeys.attach(props.scope.artifactId),
    mutationFn: async (chatId: string | null) => {
      // Capture on the explicit action, before revealing another tile.
      const annotation = props.record();
      if (chatId === null) {
        await newChat.send({
          record: annotation,
          captureRect: props.captureRect,
          awaitPickerClosed: menuClosed.awaitClosed,
          text: null,
        });
        return null;
      }
      const record = await captureAndAttachCanvasAnnotation({
        chatId,
        record: annotation,
        captureRect: props.captureRect,
        awaitPickerClosed: menuClosed.awaitClosed,
      });
      return { chatId, record };
    },
    onSuccess: (result) => {
      setMenuOpen(false);
      if (result === null) return;
      setAttached(result);
      revealChat(result.chatId);
    },
  });
  const selectTarget = (chatId: string): void => {
    if (attached !== null) {
      const store = useComposerDraftStore.getState();
      const exists = store.drafts[attached.chatId]?.browserAnnotations.some(
        (record) => record.annotationId === attached.record.annotationId,
      );
      if (exists) {
        store.addBrowserAnnotation(chatId, attached.record);
        if (chatId !== attached.chatId)
          store.removeBrowserAnnotation(
            attached.chatId,
            attached.record.annotationId,
          );
        setAttached({ chatId, record: attached.record });
        setMenuOpen(false);
        revealChat(chatId);
        return;
      }
    }
    mutation.mutate(chatId);
  };
  return (
    <div className="flex max-w-full flex-col gap-1">
      <div className="flex min-w-0 items-center gap-1">
        <ChatTargetMenu
          targets={targets}
          onSelectChat={selectTarget}
          onSelectNewChat={
            newChat.supported ? () => mutation.mutate(null) : null
          }
          open={menuOpen}
          onOpenChange={menuClosed.onOpenChange}
          onClosed={menuClosed.onClosed}
          trigger={
            <ToolbarActionButton
              label="Send to chat"
              tooltip={null}
              className="tc-editor-toolbar-action"
              disabled={
                mutation.isPending ||
                (targets.length === 0 && !newChat.supported)
              }
              onMouseDown={(event) => event.preventDefault()}
              icon={
                mutation.isPending ? (
                  <AgentSpinningDots
                    className={undefined}
                    testId={undefined}
                    variant={undefined}
                  />
                ) : (
                  <MessageSquareShare className="size-4" aria-hidden="true" />
                )
              }
            />
          }
        />
      </div>
      {targets.length === 0 && !newChat.supported ? (
        <span className="rounded bg-popover p-1 text-ui-xs text-popover-foreground">
          Create a chat to attach this selection.
        </span>
      ) : null}
      {mutation.error === null ? null : (
        <span
          role="alert"
          className="rounded bg-popover p-1 text-ui-xs text-destructive"
        >
          {mutation.error.message}
        </span>
      )}
    </div>
  );
}
