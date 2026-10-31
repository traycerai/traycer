import { useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useStore } from "zustand";
import type { CanvasAnnotationRecord } from "@traycer/protocol/persistence/epic/messages";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { MessageSquareShare } from "lucide-react";
import { ToolbarActionButton } from "@/editor-core/toolbar/toolbar-action-button";
import { ChatTargetMenu } from "@/components/epic-canvas/renderers/chat-target-menu/chat-target-menu";
import { resolveQuoteChatTargets } from "@/components/epic-canvas/renderers/chat-target-menu/quote-chat-targets";
import { useRevealChatInTab } from "@/components/epic-canvas/renderers/use-reveal-chat-in-tab";
import { useSidebarChatOrder } from "@/components/epic-canvas/sidebar/epic-sidebar-selection";
import { useArtifactObjectTextQuery } from "@/hooks/files/use-artifact-object-text-query";
import { useOpenEpicHandle } from "@/providers/use-open-epic-handle";
import { useLastFocusedChatStore } from "@/stores/chat/last-focused-chat-store";
import { useOpenTileContentIds } from "@/stores/epics/canvas/store";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import { canvasMutationKeys } from "@/lib/query-keys/canvas-mutation-keys";
import type { CanvasBox } from "@/lib/sandbox/canvas-bridge";
import {
  attachCanvasAnnotation,
  canvasAnnotationElement,
  canvasWindowCaptureBridge,
  captureCanvasRegionWithoutChrome,
} from "./canvas-annotation-attach";
import type { CanvasSelection } from "./canvas-selection-store";

/**
 * How long a capture waits for the picker to leave the screen before taking
 * the picture anyway. The menu's exit animation is a tenth of that; the bound
 * only exists for a menu whose content was never presented (a pane that lost
 * focus mid-pick), which has no exit to report.
 */
const MENU_CLOSE_WAIT_MS = 500;

export interface CanvasAnnotationScope {
  readonly epicId: string;
  readonly artifactId: string;
  readonly artifactTitle: string;
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
  const record = (): CanvasAnnotationRecord => {
    if (!props.selection.element.generated && source.data?.kind !== "text")
      throw new Error("The artboard source is still loading. Try again.");
    return {
      kind: "browser-annotation",
      annotationId: crypto.randomUUID(),
      source: {
        kind: "canvas",
        artifactId: props.scope.artifactId,
        artifactTitle: props.scope.artifactTitle,
        boardPath: props.selection.boardPath,
        canvasPage: props.selection.page,
      },
      capturedAt: Date.now(),
      comment: "",
      counts: { elements: 1, regions: 0, strokes: 0 },
      elements: [
        canvasAnnotationElement(
          props.selection,
          source.data?.kind === "text" ? source.data.text : null,
        ),
      ],
      imageFileName: null,
      imageHash: null,
      droppedElementCount: 0,
    };
  };
  return (
    <CanvasAnnotationAction
      scope={props.scope}
      record={record}
      captureRect={props.captureRect}
    />
  );
}

export function CanvasAnnotationAction(props: {
  readonly scope: CanvasAnnotationScope;
  readonly record: () => CanvasAnnotationRecord;
  readonly captureRect: () => CanvasBox | null;
}) {
  const handle = useOpenEpicHandle();
  const chats = useStore(handle.store, (state) => state.chats);
  const orderedChatIds = useSidebarChatOrder(props.scope.epicId);
  const openChatIds = useOpenTileContentIds(props.scope.viewTabId);
  const lastFocusedChatId = useLastFocusedChatStore(
    (state) => state.chatIdByEpicId[props.scope.epicId] ?? null,
  );
  const targets = useMemo(
    () =>
      resolveQuoteChatTargets({
        orderedChatIds,
        chats,
        openChatIds,
        lastFocusedChatId,
        sourceHostId: props.scope.hostId,
      }).filter((target) => !target.isOnOtherHost),
    [orderedChatIds, chats, openChatIds, lastFocusedChatId, props.scope.hostId],
  );
  const [menuOpen, setMenuOpen] = useState(false);
  // Whether the picker is still on screen, and who is waiting for it to go.
  // `menuOpen` flips false the moment a chat is picked, but the menu keeps
  // painting through its exit animation; the capture below must not run until
  // that has ended, or the fading menu is cut into the crop with the element.
  const menuPresent = useRef(false);
  const menuGone = useRef<(() => void) | null>(null);
  const openMenu = (open: boolean): void => {
    if (open) menuPresent.current = true;
    setMenuOpen(open);
  };
  const menuClosed = (): void => {
    menuPresent.current = false;
    menuGone.current?.();
    menuGone.current = null;
  };
  const awaitMenuGone = (): Promise<void> => {
    if (!menuPresent.current) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = window.setTimeout(resolve, MENU_CLOSE_WAIT_MS);
      menuGone.current = () => {
        window.clearTimeout(timer);
        resolve();
      };
    });
  };
  const [attached, setAttached] = useState<{
    chatId: string;
    record: CanvasAnnotationRecord;
  } | null>(null);
  const revealChat = useRevealChatInTab(props.scope);
  const mutation = useMutation({
    mutationKey: canvasMutationKeys.attach(props.scope.artifactId),
    mutationFn: async (chatId: string) => {
      // Capture on the explicit action, before revealing another tile, but
      // only once the picker has left the screen and with the selection chrome
      // hidden: the crop is cut from the app window as composited.
      const annotation = props.record();
      const bridge = canvasWindowCaptureBridge();
      // Whether there is anything on screen to photograph is decided now; the
      // rectangle itself is measured again right before the capture.
      const capturable = bridge !== null && props.captureRect() !== null;
      let crop: ArrayBuffer | null = null;
      if (capturable) {
        await awaitMenuGone();
        crop = await captureCanvasRegionWithoutChrome(
          bridge,
          props.captureRect,
        );
      }
      if (capturable && crop === null)
        throw new Error(
          "The selected region could not be captured. Try again.",
        );
      const record = await attachCanvasAnnotation({
        chatId,
        record: annotation,
        crop: crop === null ? null : new Uint8Array(crop),
      });
      return { chatId, record };
    },
    onSuccess: (result) => {
      setAttached(result);
      setMenuOpen(false);
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
          onSelectNewChat={null}
          open={menuOpen}
          onOpenChange={openMenu}
          onClosed={menuClosed}
          trigger={
            <ToolbarActionButton
              label="Send to chat"
              tooltip={null}
              className="tc-editor-toolbar-action"
              disabled={mutation.isPending || targets.length === 0}
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
      {targets.length === 0 ? (
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
