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
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { WorktreeIntent } from "@traycer/protocol/host/worktree-schemas";
import { v4 as uuidv4 } from "uuid";
import { displayTitle } from "@/lib/display-title";
import type { CreateChatMutationInput } from "@/hooks/epic/use-epic-chat-mutations";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { deriveWorkspaceMode } from "@/lib/worktree/workspace-mode";
import type { NavigateNestedFocus } from "@/lib/epic-nested-focus-navigation";
import type { NestedFocusTarget } from "@/lib/epic-nested-focus-route";
import {
  Analytics,
  AnalyticsEvent,
  type AnalyticsSource,
} from "@/lib/analytics";

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
      readonly source: AnalyticsSource;
    }
  | {
      readonly kind: "split";
      readonly epicId: string;
      readonly tabId: string;
      readonly chatId: string;
      readonly targetGroupId: string;
      readonly position: NewChatSplitPosition;
      readonly hostId: string;
      readonly source: AnalyticsSource;
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
      readonly source: AnalyticsSource;
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
  /** Per-chat run settings to stamp on the new chat - `null` starts the chat
   *  with host defaults (today's behavior for every caller but the clone
   *  flow, which carries the source chat's own settings forward). */
  readonly settings: ChatRunSettings | null;
  readonly source: AnalyticsSource;
  readonly createChat: CreateChatCommand;
  readonly openWhenProjected: OpenWhenProjected;
}

const noop: CancelFn = () => undefined;

export function openNewChatInActiveTile(
  args: OpenNewChatInActiveTileArgs,
): CancelFn {
  let cancelled = false;
  let projectionCancel: CancelFn | null = null;
  args.createChat(
    buildCreateChatRequest(args.epicId, args.worktreeIntent, args.settings),
    {
      onSuccess: (result) => {
        if (cancelled) return;
        projectionCancel = args.openWhenProjected({
          kind: "active-tile",
          epicId: args.epicId,
          tabId: args.tabId,
          chatId: result.chatId,
          hostId: args.hostId,
          source: args.source,
        });
      },
    },
  );
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
  // Any attempted open (successful or with a vanished target) is terminal;
  // only "chat not yet projected" keeps the wait alive - matching the
  // pre-analytics behavior of attempting the open exactly once.
  if (openProjectedChat(intent, navigateNestedFocus) !== "not_projected") {
    return noop;
  }
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
    if (openProjectedChat(intent, navigateNestedFocus) === "not_projected") {
      return;
    }
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
  settings: ChatRunSettings | null,
): CreateChatMutationInput {
  return {
    epicId,
    parentId: null,
    // Agents are created with an empty stored title ("no title yet"); the
    // "Untitled agent" fallback is applied at render via the display helper,
    // never baked into the stored title. The AI-generated title overwrites the
    // empty store only while it is still empty.
    title: "",
    chatId: uuidv4(),
    workspaceMode: deriveWorkspaceMode(1, worktreeIntent),
    worktreeIntent,
    settings,
  };
}

type ProjectedChatOpenResult =
  "not_projected" | "opened" | "target_unavailable";

function openProjectedChat(
  intent: CreatedChatOpenIntent,
  navigateNestedFocus: NavigateNestedFocus,
): ProjectedChatOpenResult {
  const handle = getOpenEpicRegistry().get(intent.epicId);
  if (handle === null) return "not_projected";
  const state = handle.store.getState();
  if (!Object.hasOwn(state.chats.byId, intent.chatId)) {
    return "not_projected";
  }
  const chat = state.chats.byId[intent.chatId];
  const node = {
    id: chat.id,
    instanceId: uuidv4(),
    type: "chat" as const,
    // Snapshot fallback label for the node: the raw title when present, else
    // the "Untitled agent" render fallback (a durable Agent, addressed as such
    // regardless of its Chat interface). Never the "New chat" placeholder.
    name: displayTitle(chat.title, "agent"),
    hostId: intent.hostId,
  };
  const canvas = useEpicCanvasStore.getState();
  let opened: NestedFocusTarget | null = null;
  if (intent.kind === "active-tile") {
    opened = navigateNestedFocus(intent.epicId, intent.tabId, () =>
      canvas.prepareOpenTileInTabFocusTarget(intent.tabId, node),
    );
  } else if (intent.kind === "target-group") {
    opened = navigateNestedFocus(intent.epicId, intent.tabId, () =>
      canvas.prepareOpenTileInPaneFocusTarget(
        intent.tabId,
        intent.groupId,
        node,
      ),
    );
  } else {
    opened = navigateNestedFocus(intent.epicId, intent.tabId, () =>
      canvas.prepareSplitPaneWithNodeFocusTarget(
        intent.tabId,
        intent.targetGroupId,
        intent.position,
        node,
      ),
    );
  }
  // A pane can disappear while host creation is in flight. The open is then
  // abandoned exactly as it was before analytics existed - no fallback pane,
  // no retry - and the only difference is that no `chat_opened` is emitted.
  if (opened === null) return "target_unavailable";
  Analytics.getInstance().track(AnalyticsEvent.ChatOpened, {
    source: intent.source,
  });
  return "opened";
}
