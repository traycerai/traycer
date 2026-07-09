/**
 * Docs: see ./README.md
 *
 * Canonical command-palette "new chat" flow. Creates the chat through the
 * host, then waits for the returned ChatV200 id to appear in the live Epic
 * projection before opening the canvas tab.
 *
 *   - `openNewChatInActiveTile` - creates a root chat and opens it in
 *     the active group as a permanent tab once projected.
 *   - `openCreatedChatWhenProjected` - the shared open-when-projected seam
 *     (active-tile / split / target-group intents) reused by the chat
 *     handoff and the host-switch clone flow.
 *
 * Worktree intent - in-Epic new chats may receive an explicit seed copied from
 * the latest visible chat binding. When absent, the chat tab opens as a
 * placeholder and the per-chat worktree binding stays `null` until the user
 * resolves it at send time via the chat tile's create / import picker.
 */
import type { CreateChatResponse } from "@traycer/protocol/host/epic/unary-schemas";
import type { WorktreeIntent } from "@traycer/protocol/host/worktree-schemas";
import { v4 as uuidv4 } from "uuid";
import { displayTitle } from "@/lib/display-title";
import type { CreateChatMutationInput } from "@/hooks/epic/use-epic-chat-mutations";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { deriveWorkspaceMode } from "@/lib/worktree/workspace-mode";
import type { NavigateNestedFocus } from "@/lib/epic-nested-focus-navigation";

const CHAT_PROJECTION_WAIT_MS = 30_000;

export type NewChatSplitPosition = "right" | "bottom";

export interface CreateChatCommandCallbacks {
  readonly onSuccess: (result: CreateChatResponse) => void;
}

// Caller-supplied request never carries `hostId`; the mutation hook
// (`useEpicCreateChat`) projects it from the active host.
export type CreateChatCommand = (
  request: CreateChatMutationInput,
  callbacks: CreateChatCommandCallbacks,
) => void;

export type CreatedChatOpenIntent =
  | {
      readonly kind: "active-tile";
      readonly epicId: string;
      readonly tabId: string;
      readonly chatId: string;
      readonly hostId: string;
    }
  | {
      readonly kind: "split";
      readonly epicId: string;
      readonly tabId: string;
      readonly chatId: string;
      readonly targetGroupId: string;
      readonly position: NewChatSplitPosition;
      readonly hostId: string;
    }
  | {
      // Opener path: drop a fresh instance into an explicit target group
      // (no dedup, no active-group resolution). Used by the palette's
      // open-into-target "New chat".
      readonly kind: "target-group";
      readonly epicId: string;
      readonly tabId: string;
      readonly chatId: string;
      readonly groupId: string;
      readonly hostId: string;
    };

/**
 * `openWhenProjected` returns a cancel - the same one
 * `openCreatedChatWhenProjected` returns. Callers that wrap the
 * action in a React effect should plumb the outer action's returned
 * cancel into the cleanup.
 */
export type OpenWhenProjected = (intent: CreatedChatOpenIntent) => CancelFn;

export type CancelFn = () => void;

export interface OpenCreatedChatWhenProjectedWithNavigationArgs {
  readonly intent: CreatedChatOpenIntent;
  readonly navigateNestedFocus: NavigateNestedFocus;
}

export interface OpenNewChatInActiveTileArgs {
  readonly epicId: string;
  readonly tabId: string;
  readonly hostId: string;
  readonly worktreeIntent: WorktreeIntent | null;
  readonly createChat: CreateChatCommand;
  readonly openWhenProjected: OpenWhenProjected;
}

const noop: CancelFn = () => undefined;

export function openNewChatInActiveTile(
  args: OpenNewChatInActiveTileArgs,
): CancelFn {
  let cancelled = false;
  let projectionCancel: CancelFn | null = null;
  args.createChat(buildCreateChatRequest(args.epicId, args.worktreeIntent), {
    onSuccess: (result) => {
      if (cancelled) return;
      projectionCancel = args.openWhenProjected({
        kind: "active-tile",
        epicId: args.epicId,
        tabId: args.tabId,
        chatId: result.chatId,
        hostId: args.hostId,
      });
    },
  });
  return () => {
    if (cancelled) return;
    cancelled = true;
    if (projectionCancel !== null) {
      projectionCancel();
      projectionCancel = null;
    }
  };
}

/**
 * Subscribe to the open-epic projection until `intent.chatId` lands,
 * then open it on the canvas. Caller-owned cancellation: the returned
 * function tears down the subscription and the 30s safety timeout.
 * React callers should plumb it into a `useEffect` cleanup so an
 * unmount mid-wait doesn't leave a dangling subscription.
 */
export function openCreatedChatWhenProjected(
  intent: CreatedChatOpenIntent,
): CancelFn {
  return openCreatedChatWhenProjectedInternal(intent, rawNestedFocus);
}

export function openCreatedChatWhenProjectedWithNavigation(
  args: OpenCreatedChatWhenProjectedWithNavigationArgs,
): CancelFn {
  return openCreatedChatWhenProjectedInternal(
    args.intent,
    args.navigateNestedFocus,
  );
}

function openCreatedChatWhenProjectedInternal(
  intent: CreatedChatOpenIntent,
  navigateNestedFocus: NavigateNestedFocus,
): CancelFn {
  if (openProjectedChat(intent, navigateNestedFocus)) return noop;
  const handle = getOpenEpicRegistry().get(intent.epicId);
  if (handle === null) return noop;

  let cancelled = false;
  let timeoutId: number | null = null;
  const cleanup: CancelFn = () => {
    if (cancelled) return;
    cancelled = true;
    unsubscribe();
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
      timeoutId = null;
    }
  };
  const unsubscribe = handle.store.subscribe(() => {
    if (cancelled) return;
    if (!openProjectedChat(intent, navigateNestedFocus)) return;
    cleanup();
  });
  timeoutId = window.setTimeout(cleanup, CHAT_PROJECTION_WAIT_MS);
  return cleanup;
}

const rawNestedFocus: NavigateNestedFocus = (_epicId, _tabId, prepare) =>
  prepare();

function buildCreateChatRequest(
  epicId: string,
  worktreeIntent: WorktreeIntent | null,
): CreateChatMutationInput {
  return {
    epicId,
    parentId: null,
    // Chats are created with an empty stored title ("no title yet"); the
    // "Untitled chat" fallback is applied at render via the chat display
    // helper, never baked into the stored title. The AI chat title overwrites
    // the empty store only while it is still empty.
    title: "",
    chatId: uuidv4(),
    workspaceMode: deriveWorkspaceMode(1, worktreeIntent),
    worktreeIntent,
  };
}

function openProjectedChat(
  intent: CreatedChatOpenIntent,
  navigateNestedFocus: NavigateNestedFocus,
): boolean {
  const handle = getOpenEpicRegistry().get(intent.epicId);
  if (handle === null) return false;
  const state = handle.store.getState();
  if (!Object.hasOwn(state.chats.byId, intent.chatId)) return false;
  const chat = state.chats.byId[intent.chatId];
  const node = {
    id: chat.id,
    instanceId: uuidv4(),
    type: "chat" as const,
    // Snapshot fallback label for the node: the raw title when present, else
    // the "Untitled chat" render fallback. Never the "New chat" placeholder.
    name: displayTitle(chat.title, "chat"),
    hostId: intent.hostId,
  };
  const canvas = useEpicCanvasStore.getState();
  if (intent.kind === "active-tile") {
    navigateNestedFocus(intent.epicId, intent.tabId, () =>
      canvas.prepareOpenTileInTabFocusTarget(intent.tabId, node),
    );
    return true;
  }
  if (intent.kind === "target-group") {
    navigateNestedFocus(intent.epicId, intent.tabId, () =>
      canvas.prepareOpenTileInPaneFocusTarget(
        intent.tabId,
        intent.groupId,
        node,
      ),
    );
    return true;
  }
  navigateNestedFocus(intent.epicId, intent.tabId, () =>
    canvas.prepareSplitPaneWithNodeFocusTarget(
      intent.tabId,
      intent.targetGroupId,
      intent.position,
      node,
    ),
  );
  return true;
}
