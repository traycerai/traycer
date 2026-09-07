/** Docs: see ./README.md */
import type { CreateChatResponse } from "@traycer/protocol/host/epic/unary-schemas";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { WorktreeIntent } from "@traycer/protocol/host/worktree-schemas";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { v4 as uuidv4 } from "uuid";
import { displayTitle } from "@/lib/display-title";
import type { CreateChatMutationInput } from "@/hooks/epic/use-epic-chat-mutations";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
import { reportableWarningToast } from "@/lib/reportable-error-toast";
import { appLogger } from "@/lib/logger";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { deriveWorkspaceMode } from "@/lib/worktree/workspace-mode";
import type { ExplicitTilePlacement } from "@/lib/canvas/tile-open/intent";
import {
  MANUAL_TILE_OPEN,
  openTileWithNavigation,
} from "@/lib/canvas/tile-open/open-tile";
import type { NavigateNestedFocus } from "@/lib/epic-nested-focus-navigation";
import type { AnalyticsSource } from "@/lib/analytics";

const CHAT_PROJECTION_WAIT_MS = 30_000;

export interface CreateChatCommandCallbacks {
  readonly onSuccess: (result: CreateChatResponse) => void;
  readonly onError: (error: HostRpcError) => void;
}

// The request names its own `hostId` (built by `buildCreateChatRequest` from the caller's target host); the mutation hook only verifies that the client it is about to send on still addresses that host.
export type CreateChatCommand = (
  request: CreateChatMutationInput,
  callbacks: CreateChatCommandCallbacks,
) => void;

export interface CreatedChatOpenIntent {
  readonly epicId: string;
  readonly tabId: string;
  readonly chatId: string;
  readonly hostId: string;
  /**
   * Explicit placement for the created tile, or `null` to let the configured conversation placement decide (C3, C8).
   * The opener path (palette open-into-target, side chat beside its source) is the only thing that names a pane.
   */
  readonly placement: ExplicitTilePlacement | null;
  readonly source: AnalyticsSource;
}

/**
 * `openWhenProjected` returns a cancel - the same one `openCreatedChatWhenProjected` returns.
 * Callers that wrap the action in a React effect should plumb the outer action's returned cancel into the cleanup.
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
  /**
   * Stored title for the new chat - `""` for an ordinary empty chat (the "no title yet" convention; AI titling fills it on the first send).
   * The clone flow passes a `Fork - <source> (<target host>)` title (see `cloneChatTitle`) so a clone keeps its name even when the create degrades to the settings-only retry, where no fork seed exists for the host to gap-fill from.
   */
  readonly title: string;
  /**
   * Per-chat run settings to stamp on the new chat - `null` starts the chat with host defaults (today's behavior for every caller but the clone flow, which carries the source chat's own settings forward).
   */
  readonly settings: ChatRunSettings | null;
  /** Optional fork source - `null` for an ordinary empty chat (every caller
   *  but the clone flow, chat-sync-v2 ticket 34B1). */
  readonly forkSource: CreateChatMutationInput["forkSource"] | null;
  readonly source: AnalyticsSource;
  readonly createChat: CreateChatCommand;
  readonly openWhenProjected: OpenWhenProjected;
  /**
   * The create call failed outright (never reached `onSuccess`).
   * `useEpicCreateChatForHostClient`'s own `onError` already toasts regardless of what this callback does, so it exists for a caller that needs to REACT to the failure, not merely report it - the clone flow (ticket 34B1) is the one caller that does: a.
   */
  readonly onCreateError: (error: HostRpcError) => void;
}

const noop: CancelFn = () => undefined;

export function openNewChatInActiveTile(
  args: OpenNewChatInActiveTileArgs,
): CancelFn {
  let cancelled = false;
  let projectionCancel: CancelFn | null = null;
  args.createChat(
    buildCreateChatRequest({
      epicId: args.epicId,
      // The host this open intent names, which is also the host the new chat is bound to for life - not whichever host happens to be active when the mutation fires.
      hostId: args.hostId,
      worktreeIntent: args.worktreeIntent,
      title: args.title,
      settings: args.settings,
      forkSource: args.forkSource,
    }),
    {
      onSuccess: (result) => {
        if (cancelled) return;
        projectionCancel = args.openWhenProjected({
          epicId: args.epicId,
          tabId: args.tabId,
          chatId: result.chatId,
          hostId: args.hostId,
          placement: null,
          source: args.source,
        });
      },
      onError: args.onCreateError,
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
 * Subscribe to the open-epic projection until `intent.chatId` lands, then open it on the canvas.
 * Caller-owned cancellation: the returned function tears down the subscription and the 30s safety timeout.
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
  // Any attempted open (successful or with a vanished target) is terminal; only "chat not yet projected" keeps the wait alive - matching the pre-analytics behavior of attempting the open exactly once.
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
  timeoutId = window.setTimeout(() => {
    if (cancelled) return;
    cleanup();
    reportChatProjectionWaitExpired(intent);
  }, CHAT_PROJECTION_WAIT_MS);
  return cleanup;
}

/**
 * The agent exists - `epic.createChat` answered - but this window never saw it arrive, so there is nothing to open.
 * Said out loud rather than swallowed: the user's click produced a real chat on a real host, and the only thing that failed is this client's view of it, which is exactly the distinction a silent expiry destroyed.
 */
function reportChatProjectionWaitExpired(intent: CreatedChatOpenIntent): void {
  appLogger.warn("[new-chat] created chat never reached this device", {
    epicId: intent.epicId,
    chatId: intent.chatId,
    hostId: intent.hostId,
  });
  reportableWarningToast(
    "Your new agent hasn't shown up here yet.",
    {
      description:
        "It was created - this device just hasn't received it yet. It should appear shortly; reopening the Epic re-reads the list.",
      id: "chat-projection-wait-expired",
    },
    createReportIssueContext({
      title: "New agent never reached this device",
      message: null,
      code: null,
      source: "Chat",
    }),
  );
}

const rawNestedFocus: NavigateNestedFocus = (_epicId, _tabId, prepare) =>
  prepare();

function buildCreateChatRequest(args: {
  readonly epicId: string;
  readonly hostId: string;
  readonly worktreeIntent: WorktreeIntent | null;
  readonly title: string;
  readonly settings: ChatRunSettings | null;
  readonly forkSource: CreateChatMutationInput["forkSource"] | null;
}): CreateChatMutationInput {
  const { epicId, hostId, worktreeIntent, title, settings, forkSource } = args;
  return {
    epicId,
    hostId,
    parentId: null,
    // Ordinary chats are created with an empty stored title ("no title yet"); the "Untitled agent" fallback is applied at render via the display helper, never baked into the stored title.
    title,
    chatId: uuidv4(),
    workspaceMode: deriveWorkspaceMode(1, worktreeIntent),
    worktreeIntent,
    settings,
    forkSource,
  };
}

type ProjectedChatOpenResult =
  | "not_projected"
  | "opened"
  | "target_unavailable";

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
    // Snapshot fallback label for the node: the raw title when present, else the "Untitled agent" render fallback (a durable Agent, addressed as such regardless of its Chat interface).
    // Never the "New chat" placeholder.
    name: displayTitle(chat.title, "agent"),
    hostId: intent.hostId,
  };
  // `openTile` owns placement, focus, the route write AND the `chat_opened`
  // analytics (`trackOpenedCanvasTile`), so this path no longer tracks by hand.
  const opened = openTileWithNavigation(
    {
      node,
      target: { tabId: intent.tabId },
      gesture: "explicit",
      modifiers: null,
      placement: intent.placement,
      dedupe: true,
      source: intent.source,
    },
    navigateNestedFocus,
    MANUAL_TILE_OPEN,
  );
  // A pane can disappear while host creation is in flight.
  // The open is then abandoned exactly as it was before analytics existed - no fallback pane, no retry - and the only difference is that no `chat_opened` is emitted.
  if (opened === null) return "target_unavailable";
  return "opened";
}
