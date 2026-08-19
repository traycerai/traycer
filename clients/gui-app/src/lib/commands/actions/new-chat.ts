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
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { v4 as uuidv4 } from "uuid";
import { displayTitle } from "@/lib/display-title";
import type { CreateChatMutationInput } from "@/hooks/epic/use-epic-chat-mutations";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
import { reportableWarningToast } from "@/lib/reportable-error-toast";
import { appLogger } from "@/lib/logger";
import { createReportIssueContext } from "@/lib/report-issue-context";
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
  readonly onError: (error: HostRpcError) => void;
}

// The request names its own `hostId` (built by `buildCreateChatRequest` from
// the caller's target host); the mutation hook only verifies that the client
// it is about to send on still addresses that host.
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
  /** Stored title for the new chat - `""` for an ordinary empty chat (the
   *  "no title yet" convention; AI titling fills it on the first send). The
   *  clone flow passes a `Fork - <source> (<target host>)` title (see
   *  `cloneChatTitle`) so a clone keeps its name even when the create
   *  degrades to the settings-only retry, where no fork seed exists for the
   *  host to gap-fill from. */
  readonly title: string;
  /** Per-chat run settings to stamp on the new chat - `null` starts the chat
   *  with host defaults (today's behavior for every caller but the clone
   *  flow, which carries the source chat's own settings forward). */
  readonly settings: ChatRunSettings | null;
  /** Optional fork source - `null` for an ordinary empty chat (every caller
   *  but the clone flow, chat-sync-v2 ticket 34B1). */
  readonly forkSource: CreateChatMutationInput["forkSource"] | null;
  readonly source: AnalyticsSource;
  readonly createChat: CreateChatCommand;
  readonly openWhenProjected: OpenWhenProjected;
  /** The create call failed outright (never reached `onSuccess`).
   *  `useEpicCreateChatForHostClient`'s own `onError` already toasts regardless of what
   *  this callback does, so it exists for a caller that needs to REACT to
   *  the failure, not merely report it - the clone flow (ticket 34B1) is the
   *  one caller that does: a checkpoint-unavailable refusal retries
   *  settings-only instead of giving up. Every other caller passes a no-op. */
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
      // The host this open intent names, which is also the host the new chat
      // is bound to for life - not whichever host happens to be active when
      // the mutation fires.
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
          kind: "active-tile",
          epicId: args.epicId,
          tabId: args.tabId,
          chatId: result.chatId,
          hostId: args.hostId,
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
 * Subscribe to the open-epic projection until `intent.chatId` lands,
 * then open it on the canvas. Caller-owned cancellation: the returned
 * function tears down the subscription and the 30s safety timeout.
 * React callers should plumb it into a `useEffect` cleanup so an
 * unmount mid-wait doesn't leave a dangling subscription.
 *
 * ## The wait is now a fallback, and it is no longer silent
 *
 * A chat created through the shared `epic.createChat` hooks is retained in the
 * open-epic store's pending-creation registry as soon as the create is
 * answered, so it is already in the projection when this runs and the open
 * happens on the first attempt - no subscription, no timer. The wait remains
 * for the cases the registry cannot cover (most concretely: the epic session
 * being rebuilt between the request and its answer, which loses the retained
 * row), and when it now runs out it SAYS SO. Burning 30s and doing nothing is
 * what made "clicked Fork, nothing happened for a minute" unreadable.
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
  timeoutId = window.setTimeout(() => {
    if (cancelled) return;
    cleanup();
    reportChatProjectionWaitExpired(intent);
  }, CHAT_PROJECTION_WAIT_MS);
  return cleanup;
}

/**
 * The agent exists - `epic.createChat` answered - but this window never saw it
 * arrive, so there is nothing to open. Said out loud rather than swallowed:
 * the user's click produced a real chat on a real host, and the only thing that
 * failed is this client's view of it, which is exactly the distinction a silent
 * expiry destroyed.
 *
 * Logged as well as toasted, and the split is deliberate: the report context
 * below carries no ids, because an issue report is a privacy-safe payload and
 * naming the epic, chat and host in it would leak the user's workspace into
 * something they send to us. The renderer's own log is not that payload - it is
 * this device's console dump - so it is where the correlation belongs. Without
 * it a support engineer receives "an agent never arrived" and has no way to tie
 * it to which agent, on which host.
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
    // Ordinary chats are created with an empty stored title ("no title yet");
    // the "Untitled agent" fallback is applied at render via the display
    // helper, never baked into the stored title. The AI-generated title
    // overwrites the empty store only while it is still empty. The clone flow
    // passes a fork-decorated source title instead, which (when non-empty)
    // also correctly blocks AI titling from renaming the continuation.
    title,
    chatId: uuidv4(),
    workspaceMode: deriveWorkspaceMode(1, worktreeIntent),
    worktreeIntent,
    settings,
    forkSource,
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
