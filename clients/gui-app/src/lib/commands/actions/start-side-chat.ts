import { v4 as uuidv4 } from "uuid";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { CreateChatInitialMessage } from "@traycer/protocol/host/epic/unary-schemas";
import type { WorktreeIntent } from "@traycer/protocol/host/worktree-schemas";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";

import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import type { ExplicitTilePlacement } from "@/lib/canvas/tile-open/intent";
import {
  classifyRecoverableForkFailure,
  type RecoverableForkFailure,
} from "@/lib/chats/recoverable-fork-refusal";
import { sideChatTitle } from "@/lib/chats/side-chat-command";
import { contentIsSubmittable } from "@/lib/composer/composer-content";
import { extractPlainTextFromComposerJSONContent } from "@/lib/composer/tiptap-json-content";
import { isMobileApp } from "@/lib/mobile-app";
import { deriveWorkspaceMode } from "@/lib/worktree/workspace-mode";
import type { CreateChatMutationInput } from "@/hooks/epic/use-epic-chat-mutations";
import { paneTabRefs } from "@/stores/epics/canvas/actions";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import { useInitialChatHandoffStore } from "@/stores/epics/initial-chat-handoff-store";

import {
  openCreatedChatWhenProjected,
  type CancelFn,
  type CreateChatCommand,
  type CreatedChatOpenIntent,
} from "./new-chat";

/**
 * The `/btw` side chat (`lib/chats/side-chat-command.ts`): fork the source chat at its latest checkpoint and ask `content` there, leaving the source untouched - mid-turn included, which is the point.
 */
export interface StartSideChatArgs {
  readonly epicId: string;
  readonly tabId: string;
  /** The source tab's bound host, which the side chat is bound to for life. */
  readonly hostId: string;
  readonly userId: string;
  readonly sourceChatId: string;
  /** The source's RAW stored title (`""` when untitled), for the fallback. */
  readonly sourceChatTitle: string;
  /**
   * The owner this tile renders for the source chat, or `null` when it does not know - the host's anti-squatting hint, never a guess (see the `sourceOwnerUserId` docs on `epic.createChat`'s fork source).
   */
  readonly sourceOwnerUserId: string | null;
  /** The prompt with the command stripped; empty for a bare `/btw`. */
  readonly content: JsonContent;
  readonly settings: ChatRunSettings;
  readonly accountContext: CreateChatInitialMessage["accountContext"];
  /** The source chat's visible workspace, so the fork works in the same place. */
  readonly worktreeIntent: WorktreeIntent | null;
  readonly placement: ExplicitTilePlacement | null;
  readonly createChat: CreateChatCommand;
  /** Fired right before the settings-only retry - the side chat still opens. */
  readonly onHistoryUnavailable: (reason: RecoverableForkFailure) => void;
}

export function startSideChat(args: StartSideChatArgs): CancelFn {
  const chatId = uuidv4();
  const messageId = uuidv4();
  const clientActionId = uuidv4();
  const now = Date.now();
  const hasMessage = contentIsSubmittable(args.content);
  const title = sideChatTitle(
    extractPlainTextFromComposerJSONContent(args.content),
    args.sourceChatTitle,
  );
  const scope = {
    hostId: args.hostId,
    userId: args.userId,
    epicId: args.epicId,
  };
  if (hasMessage) {
    useInitialChatHandoffStore.getState().register({
      ...scope,
      chatId,
      content: args.content,
      settings: args.settings,
      worktreeIntent: args.worktreeIntent,
      placement: args.placement,
      messageId,
      clientActionId,
      createdAt: now,
    });
  }
  const initialMessage: CreateChatInitialMessage | null = hasMessage
    ? {
        messageId,
        clientActionId,
        content: args.content,
        sender: { type: "user", userId: args.userId },
        settings: args.settings,
        accountContext: args.accountContext,
      }
    : null;

  let cancelled = false;
  let projectionCancel: CancelFn | null = null;

  const attempt = (
    forkSource: CreateChatMutationInput["forkSource"] | null,
  ): void => {
    args.createChat(
      {
        epicId: args.epicId,
        hostId: args.hostId,
        parentId: args.sourceChatId,
        title,
        chatId,
        settings: args.settings,
        workspaceMode: deriveWorkspaceMode(
          args.worktreeIntent?.entries.length ?? 0,
          args.worktreeIntent,
        ),
        worktreeIntent: args.worktreeIntent,
        initialMessage,
        forkSource,
      },
      {
        onSuccess: (result) => {
          Analytics.getInstance().track(AnalyticsEvent.ChatForked, {
            source: "direct_ui",
            include_history: forkSource !== null,
          });
          if (hasMessage) {
            // The handoff owns the open and the send from here.
            // Turn-overlap: the host already started the turn from `initialMessage`, so the tile's driver must not send it again.
            if (result.initialTurnStarted === true) {
              useInitialChatHandoffStore
                .getState()
                .markInitialTurnStarted(scope, chatId);
            }
            return;
          }
          if (cancelled) return;
          projectionCancel = openCreatedChatWhenProjected(
            openIntentForPlacement(args, result.chatId),
          );
        },
        onError: (error: HostRpcError) => {
          if (forkSource !== null) {
            const recoverable = classifyRecoverableForkFailure(error);
            if (recoverable !== null) {
              if (!cancelled) args.onHistoryUnavailable(recoverable);
              attempt(null);
              return;
            }
          }
          // `markFailedByAction`, not `markFailed`: the handoff key is {user, epic} only, so a later create in this epic may already have replaced the entry; fail only the handoff still carrying these ids.
          if (hasMessage) {
            useInitialChatHandoffStore
              .getState()
              .markFailedByAction(
                scope,
                chatId,
                clientActionId,
                "Couldn't start the side chat.",
              );
          }
        },
      },
    );
  };

  attempt({
    boundary: "latest",
    sourceChatId: args.sourceChatId,
    sourceOwnerUserId: args.sourceOwnerUserId,
  });

  return () => {
    if (cancelled) return;
    cancelled = true;
    if (projectionCancel !== null) {
      projectionCancel();
      projectionCancel = null;
    }
    // The handoff is registered BEFORE the create and lives in a global store, so cancelling only the projection would leave it behind: a create answer arriving after the source tile unmounted would still eager-open the tab and send the question.
    if (hasMessage) {
      useInitialChatHandoffStore
        .getState()
        .markFailedByAction(
          scope,
          chatId,
          clientActionId,
          "The side chat was cancelled.",
        );
    }
  };
}

function openIntentForPlacement(
  args: StartSideChatArgs,
  chatId: string,
): CreatedChatOpenIntent {
  return {
    epicId: args.epicId,
    tabId: args.tabId,
    chatId,
    hostId: args.hostId,
    placement: args.placement,
    source: "direct_ui",
  };
}

/**
 * Where a side chat asked from `sourceChatId`'s tile lands: split to the RIGHT of the pane showing that tile, so the source keeps streaming in view - a side chat is read beside its conversation, not instead of it.
 */
export function sideChatPlacementForTile(
  tabId: string,
  sourceChatId: string,
): ExplicitTilePlacement | null {
  if (isMobileApp()) return null;
  const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
  if (canvas === undefined) return null;
  const pane = collectPanes(canvas.root).find((candidate) =>
    paneTabRefs(canvas, candidate).some(
      (ref) => ref.type === "chat" && ref.id === sourceChatId,
    ),
  );
  if (pane === undefined) return null;
  return { kind: "split", paneId: pane.id, edge: "right" };
}
