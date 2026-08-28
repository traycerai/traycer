// Notification payload contract consumed by `NotificationFocusBridge`.
//
// Payloads travel from the runner (desktop / mobile) as `unknown`. The GUI
// decides how to interpret them. Parsing is total - unrecognized shapes
// produce `null` instead of throwing, so a bad payload cannot break the
// mounted runtime.

import type { UseNavigateResult } from "@tanstack/react-router";
import {
  NOTIFICATION_EVENT_TYPES,
  type NotificationEvent,
} from "@traycer/protocol/notifications/notification-entry";
import {
  existingEpicTabIntentWithNestedFocus,
  navigateToTabIntent,
  openOrFocusEpicIntent,
} from "@/lib/tab-navigation";
import { ensureSettingsTab } from "@/lib/commands/actions/open-system-tab";
import type { SettingsSectionId } from "@/lib/settings-sections";
import {
  findOpenArtifactInTab,
  useEpicCanvasStore,
} from "@/stores/epics/canvas/store";
import {
  type ChatTranscriptJumpTarget,
  useChatTranscriptJumpStore,
} from "@/stores/chats/chat-transcript-jump-store";

export type NotificationPayloadKind =
  | "session"
  | "artifact"
  | "epic"
  | "approval"
  | "interview"
  | "chat"
  | "terminal"
  | "hostSurface";

export interface SessionNotificationPayload {
  readonly kind: "session";
  readonly sessionId: string;
}

export interface ArtifactNotificationPayload {
  readonly kind: "artifact";
  readonly artifactId: string;
  readonly epicId: string | undefined;
  readonly threadId: string | undefined;
}

export interface EpicNotificationPayload {
  readonly kind: "epic";
  readonly epicId: string;
}

export interface ApprovalNotificationPayload {
  readonly kind: "approval";
  readonly epicId: string | undefined;
  readonly chatId: string | undefined;
  readonly approvalId: string | undefined;
  readonly sessionId: string | undefined;
  readonly artifactId: string | undefined;
}

export interface InterviewNotificationPayload {
  readonly kind: "interview";
  readonly epicId: string;
  readonly chatId: string;
  readonly interviewBlockId: string | undefined;
}

export interface ChatNotificationPayload {
  readonly kind: "chat";
  readonly epicId: string;
  readonly chatId: string | undefined;
  /** Durable host binding of the chat itself. This may differ from the host
   * that authored the notification feed row. */
  readonly hostId?: string;
  /** Optional transcript row associated with the notification occurrence. */
  readonly messageId?: string;
  /** Optional durable event associated with an inline transcript occurrence. */
  readonly eventId?: string;
  /** Explicit current-state navigation. Final Done always supersedes an older
   * occurrence anchor and opens at the live end of the transcript. */
  readonly scrollToEnd?: true;
}

export interface TerminalNotificationPayload {
  readonly kind: "terminal";
  readonly epicId: string;
  readonly terminalId: string;
  readonly tabId: string;
  readonly paneId: string;
  readonly tileInstanceId: string;
}

/**
 * A host-managed surface rather than a document inside an epic.
 *
 * One destination FAMILY, not one payload kind per operation: the notification
 * model is expected to grow to test boxes, development environments, and other
 * host-owned resources, and each of those would otherwise add a transport type
 * for what is really the same navigation shape. `surface` grows here in client
 * code - it is never persisted in a notification row, because a durable route
 * would freeze today's UI into data that outlives it.
 *
 * `focus` is a HINT. A surface must always be reachable without it: the
 * resource a row describes may be gone by the time the row is read (a deleted
 * worktree, by construction), and failing to resolve a focus target must never
 * turn into a dead-end activation.
 */
export interface HostSurfaceNotificationPayload {
  readonly kind: "hostSurface";
  readonly surface: "worktreeSettings";
  readonly focus: { readonly resourceId: string } | undefined;
}

export type NotificationPayload =
  | SessionNotificationPayload
  | ArtifactNotificationPayload
  | EpicNotificationPayload
  | ApprovalNotificationPayload
  | InterviewNotificationPayload
  | ChatNotificationPayload
  | TerminalNotificationPayload
  | HostSurfaceNotificationPayload;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseSessionPayload(
  value: Record<string, unknown>,
): SessionNotificationPayload | null {
  const sessionId = readString(value.sessionId);
  if (sessionId === null) {
    return null;
  }
  return { kind: "session", sessionId };
}

function parseArtifactPayload(
  value: Record<string, unknown>,
): ArtifactNotificationPayload | null {
  const artifactId = readString(value.artifactId);
  if (artifactId === null) {
    return null;
  }
  const epicId = readString(value.epicId);
  const threadId = readString(value.threadId);
  return {
    kind: "artifact",
    artifactId,
    epicId: epicId === null ? undefined : epicId,
    threadId: threadId === null ? undefined : threadId,
  };
}

function parseEpicPayload(
  value: Record<string, unknown>,
): EpicNotificationPayload | null {
  const epicId = readString(value.epicId);
  if (epicId === null) {
    return null;
  }
  return { kind: "epic", epicId };
}

function parseChatPayload(
  value: Record<string, unknown>,
): ChatNotificationPayload | null {
  const epicId = readString(value.epicId);
  if (epicId === null) {
    return null;
  }
  const chatId = readString(value.chatId);
  const hostId = readString(value.hostId);
  const messageId = readString(value.messageId);
  const eventId = readString(value.eventId);
  const scrollToEnd =
    value.outcome === "completed" && value.backgroundWorkRunning !== true;
  const includeTranscriptAnchor = !scrollToEnd;
  return {
    kind: "chat",
    epicId,
    chatId: chatId === null ? undefined : chatId,
    ...(hostId === null ? {} : { hostId }),
    messageId:
      includeTranscriptAnchor && messageId !== null ? messageId : undefined,
    eventId: includeTranscriptAnchor && eventId !== null ? eventId : undefined,
    ...(scrollToEnd ? { scrollToEnd: true as const } : {}),
  };
}

function parseTerminalPayload(
  value: Record<string, unknown>,
): TerminalNotificationPayload | null {
  const epicId = readString(value.epicId);
  const terminalId = readString(value.terminalId);
  const tabId = readString(value.tabId);
  const paneId = readString(value.paneId);
  const tileInstanceId = readString(value.tileInstanceId);
  if (
    epicId === null ||
    terminalId === null ||
    tabId === null ||
    paneId === null ||
    tileInstanceId === null
  ) {
    return null;
  }
  return {
    kind: "terminal",
    epicId,
    terminalId,
    tabId,
    paneId,
    tileInstanceId,
  };
}

function parseApprovalPayload(
  value: Record<string, unknown>,
): ApprovalNotificationPayload | null {
  const epicId = readString(value.epicId);
  const chatId = readString(value.chatId);
  const sessionId = readString(value.sessionId);
  if (epicId === null && sessionId === null) {
    return null;
  }
  const approvalId = readString(value.approvalId);
  const artifactId = readString(value.artifactId);
  return {
    kind: "approval",
    epicId: epicId === null ? undefined : epicId,
    chatId: chatId === null ? undefined : chatId,
    approvalId: approvalId === null ? undefined : approvalId,
    sessionId: sessionId === null ? undefined : sessionId,
    artifactId: artifactId === null ? undefined : artifactId,
  };
}

function parseInterviewPayload(
  value: Record<string, unknown>,
): InterviewNotificationPayload | null {
  const epicId = readString(value.epicId);
  const chatId = readString(value.chatId);
  if (epicId === null || chatId === null) {
    return null;
  }
  const interviewBlockId = readString(value.interviewBlockId);
  return {
    kind: "interview",
    epicId,
    chatId,
    interviewBlockId: interviewBlockId === null ? undefined : interviewBlockId,
  };
}

/**
 * Total parse of a host-surface destination. An unknown `surface` yields
 * `null` (degrade to opening the centre) rather than a payload the router
 * would have to guess at - a native envelope can arrive from a NEWER build
 * that knows surfaces this one does not.
 */
function parseHostSurfacePayload(
  value: Record<string, unknown>,
): HostSurfaceNotificationPayload | null {
  if (value.surface !== "worktreeSettings") {
    return null;
  }
  const focus = isRecord(value.focus)
    ? readString(value.focus.resourceId)
    : null;
  return {
    kind: "hostSurface",
    surface: "worktreeSettings",
    focus: focus === null ? undefined : { resourceId: focus },
  };
}

export function parseNotificationPayload(
  value: unknown,
): NotificationPayload | null {
  if (!isRecord(value)) {
    return null;
  }

  switch (value.kind) {
    case "hostSurface":
      return parseHostSurfacePayload(value);
    case "session":
      return parseSessionPayload(value);
    case "artifact":
      return parseArtifactPayload(value);
    case "epic":
      return parseEpicPayload(value);
    case "chat":
      return parseChatPayload(value);
    case "terminal":
      return parseTerminalPayload(value);
    case "approval":
      return parseApprovalPayload(value);
    case "interview":
      return parseInterviewPayload(value);
    default:
      return null;
  }
}

/**
 * Derives a typed `NotificationPayload` from a `NotificationEvent` stored in
 * the shared notification-room schema. Comment-thread events carry epic +
 * artifact + thread context; permission events carry only the epic.
 */
export function buildPayloadFromEvent(
  event: NotificationEvent,
): NotificationPayload {
  switch (event.kind) {
    case NOTIFICATION_EVENT_TYPES.INVITED:
    case NOTIFICATION_EVENT_TYPES.ROLE_CHANGED:
    case NOTIFICATION_EVENT_TYPES.REVOKED:
      return { kind: "epic", epicId: event.epicId };
    case NOTIFICATION_EVENT_TYPES.THREAD_CREATED:
    case NOTIFICATION_EVENT_TYPES.COMMENT_ADDED:
    case NOTIFICATION_EVENT_TYPES.THREAD_RESOLVED:
    case NOTIFICATION_EVENT_TYPES.THREAD_DELETED:
      return {
        kind: "artifact",
        epicId: event.epicId,
        artifactId: event.artifactId,
        threadId: event.threadId,
      };
  }
}

export type NotificationNavigate = UseNavigateResult<string>;

/**
 * Pure predicate mirroring `routeNotification`'s no-op branches, without
 * navigating. Lets a caller (native click routing) decide upfront whether an
 * activation will actually go anywhere, so a non-navigable payload (a
 * `session` kind, or an `artifact`/`approval` missing the ids it needs) can
 * fall back to opening the center instead of activating silently.
 */
export function isNotificationPayloadRoutable(
  payload: NotificationPayload,
): boolean {
  switch (payload.kind) {
    // `hostSurface` is always routable: the surface needs no ids to resolve,
    // and its focus hint is allowed to miss.
    case "epic":
    case "chat":
    case "interview":
    case "terminal":
    case "hostSurface":
      return true;
    case "approval":
      return payload.epicId !== undefined && payload.chatId !== undefined;
    case "artifact":
      return payload.epicId !== undefined;
    case "session":
      return false;
  }
}

/**
 * Single routing entry point used by both `NotificationFocusBridge` (OS toast
 * clicks) and the in-app notifications popover. Keeps the route-target
 * contract in one place so the two surfaces cannot drift.
 */
export function routeNotification(
  navigate: NotificationNavigate,
  payload: NotificationPayload,
  receivedAt: number,
): void {
  // Host-agnostic legacy entry: no origin to honour, so the hostless fallback
  // is the correct destination and the origin-bound answer is not consulted.
  routeNotificationForHost(navigate, payload, receivedAt, {
    originHostId: null,
    effectiveHostId: null,
  });
}

export interface NotificationHostRouteContext {
  readonly originHostId: string | null;
  readonly effectiveHostId: string | null;
}

/**
 * Routes a notification and answers whether it reached the required
 * host-bound target. Approval/interview rows require their feed origin;
 * chat lifecycle rows may name the chat's distinct durable host in payload.
 *
 * `false` means the route fell through to a hostless intent, which resolves
 * through the ambient effective host - fine for an epic or a plain chat, wrong
 * for an approval or interview that only its origin host can serve.
 */
export function routeNotificationForHost(
  navigate: NotificationNavigate,
  payload: NotificationPayload,
  receivedAt: number,
  context: NotificationHostRouteContext,
): boolean {
  const { originHostId, effectiveHostId } = context;
  switch (payload.kind) {
    case "epic":
      navigateToTabIntent(
        navigate,
        openOrFocusEpicIntent({
          epicId: payload.epicId,
          focus: {
            focusedAt: receivedAt,
            focusArtifactId: undefined,
            focusThreadId: undefined,
            migrationSource: undefined,
          },
        }),
        undefined,
      );
      return true;
    case "chat":
      return routeEpicChatNotification(navigate, payload, receivedAt, {
        targetHostId: payload.hostId ?? originHostId,
        effectiveHostId,
        transcriptTarget: chatNotificationTranscriptTarget(payload),
      });
    case "terminal":
      routeTerminalNotification(navigate, payload, receivedAt);
      return true;
    case "approval":
      if (payload.epicId === undefined || payload.chatId === undefined) {
        return false;
      }
      return routeEpicChatNotification(
        navigate,
        {
          kind: "chat",
          epicId: payload.epicId,
          chatId: payload.chatId,
          messageId: undefined,
          eventId: undefined,
        },
        receivedAt,
        {
          targetHostId: originHostId,
          effectiveHostId,
          transcriptTarget: null,
        },
      );
    case "interview":
      return routeEpicChatNotification(
        navigate,
        {
          kind: "chat",
          epicId: payload.epicId,
          chatId: payload.chatId,
          messageId: undefined,
          eventId: undefined,
        },
        receivedAt,
        {
          targetHostId: originHostId,
          effectiveHostId,
          transcriptTarget:
            payload.interviewBlockId === undefined
              ? null
              : { kind: "block", blockId: payload.interviewBlockId },
        },
      );
    case "artifact": {
      if (payload.epicId === undefined) {
        return false;
      }
      navigateToTabIntent(
        navigate,
        openOrFocusEpicIntent({
          epicId: payload.epicId,
          focus: {
            focusedAt: receivedAt,
            focusArtifactId: payload.artifactId,
            focusThreadId: payload.threadId,
            migrationSource: undefined,
          },
        }),
        undefined,
      );
      return true;
    }
    case "hostSurface":
      routeHostSurfaceNotification(navigate, payload);
      return true;
    case "session":
      return false;
  }
}

/**
 * Opens the host-managed surface a row points at.
 *
 * Goes through `ensureSettingsTab` rather than navigating to the route
 * directly so the Settings tab exists, is focused, and REMEMBERS worktrees as
 * its last section - the same path the command palette and header take. Panel
 * state that lives outside the route (search text, tier filters, sort) is
 * therefore untouched: the user lands back on the list they had set up.
 *
 * Worktree deletion passes no focus hint on purpose. The row it would point at
 * has just been deleted, so the only honest destination is the list.
 */
function routeHostSurfaceNotification(
  navigate: NotificationNavigate,
  payload: HostSurfaceNotificationPayload,
): void {
  navigateToTabIntent(
    navigate,
    ensureSettingsTab({
      subSection: HOST_SURFACE_SETTINGS_SECTION[payload.surface],
      resetToGeneral: false,
    }),
    undefined,
  );
}

/**
 * Every host surface, mapped to the Settings section that hosts it.
 *
 * A `Record` keyed by the surface union rather than a switch: it is exhaustive
 * by construction, so adding a surface fails to compile here until it declares
 * a destination. A future surface that is NOT a Settings section (a dedicated
 * route, say) is the point at which this becomes a real dispatch rather than a
 * table - which is a change to make then, not a switch to guess at now.
 */
const HOST_SURFACE_SETTINGS_SECTION: Record<
  HostSurfaceNotificationPayload["surface"],
  SettingsSectionId
> = {
  worktreeSettings: "worktrees",
};

function routeTerminalNotification(
  navigate: NotificationNavigate,
  payload: TerminalNotificationPayload,
  receivedAt: number,
): void {
  const store = useEpicCanvasStore.getState();
  const tab = store.tabsById[payload.tabId];
  if (tab?.epicId !== payload.epicId) {
    navigateToTabIntent(
      navigate,
      openOrFocusEpicIntent({
        epicId: payload.epicId,
        focus: {
          focusedAt: receivedAt,
          focusArtifactId: undefined,
          focusThreadId: undefined,
          migrationSource: undefined,
        },
      }),
      undefined,
    );
    return;
  }

  // The payload names the EXACT tab that owns the terminal. Prepare THAT tab's
  // nested focus and activate it - never resolve by epic, which would pick an
  // active/MRU same-epic sibling and land on the wrong tab. A retained,
  // currently-closed tab is reopened by the controller's legacy projection
  // (`setActiveTab` reinserts it into `openTabOrder`).
  const nestedFocus = useEpicCanvasStore
    .getState()
    .prepareSetActiveTileTabFocusTarget(
      payload.tabId,
      payload.paneId,
      payload.tileInstanceId,
    );
  navigateToTabIntent(
    navigate,
    existingEpicTabIntentWithNestedFocus({
      epicId: payload.epicId,
      tabId: payload.tabId,
      focus: {
        focusedAt: receivedAt,
        focusArtifactId: undefined,
        focusThreadId: undefined,
        migrationSource: undefined,
      },
      nestedFocus,
    }),
    undefined,
  );
}

interface ChatNotificationRouteContext {
  readonly targetHostId: string | null;
  readonly effectiveHostId: string | null;
  readonly transcriptTarget: ChatTranscriptJumpTarget | null;
}

function chatNotificationTranscriptTarget(
  payload: ChatNotificationPayload,
): ChatTranscriptJumpTarget | null {
  if (payload.scrollToEnd === true) {
    return { kind: "end" };
  }
  if (payload.eventId !== undefined) {
    return { kind: "event", eventId: payload.eventId };
  }
  if (payload.messageId !== undefined) {
    return { kind: "message", messageId: payload.messageId };
  }
  return null;
}

function parkChatTranscriptJump(
  payload: ChatNotificationPayload,
  context: ChatNotificationRouteContext,
): void {
  if (
    context.targetHostId === null ||
    payload.chatId === undefined ||
    context.transcriptTarget === null
  ) {
    return;
  }
  useChatTranscriptJumpStore
    .getState()
    .requestJump(
      context.targetHostId,
      payload.chatId,
      context.transcriptTarget,
    );
}

function routeEpicChatNotification(
  navigate: NotificationNavigate,
  payload: ChatNotificationPayload,
  receivedAt: number,
  context: ChatNotificationRouteContext,
): boolean {
  if (
    routeLegacyTerminalNotification(
      navigate,
      payload,
      receivedAt,
      context.targetHostId,
    )
  )
    return true;
  if (
    routeOpenChatNotification(
      navigate,
      payload,
      receivedAt,
      context.targetHostId,
    )
  ) {
    parkChatTranscriptJump(payload, context);
    return true;
  }
  // A fresh tile is opened through a hostless epic intent. Park its jump only
  // when the window is already addressing the chat's target host; a
  // different-host tile with the same chat id must never consume the target.
  if (
    context.targetHostId !== null &&
    context.targetHostId === context.effectiveHostId
  ) {
    parkChatTranscriptJump(payload, context);
  }
  // Everything above matched a target BOUND to `targetHostId`. The fallback
  // below does not: `openOrFocusEpicIntent` is hostless by construction, so it
  // resolves through whichever host is effective. Reported as `false` so an
  // ORIGIN-REQUIRED activation can decline to ACKNOWLEDGE a prompt it did not
  // open on its own host - see `useNotificationActivationWithNavigate`. The
  // navigation still happens: opening the epic is useful either way, and
  // suppressing it would strand every row whose origin cannot be established.
  navigateToTabIntent(
    navigate,
    openOrFocusEpicIntent({
      epicId: payload.epicId,
      focus: {
        focusedAt: receivedAt,
        focusArtifactId: payload.chatId,
        focusThreadId: undefined,
        migrationSource: undefined,
      },
    }),
    undefined,
  );
  return false;
}

function isChatArtifactTileType(type: string | undefined): boolean {
  return type === "chat" || type === "terminal-agent";
}

function routeOpenChatNotification(
  navigate: NotificationNavigate,
  payload: ChatNotificationPayload,
  receivedAt: number,
  targetHostId: string | null,
): boolean {
  const chatId = payload.chatId;
  if (chatId === undefined) return false;
  const state = useEpicCanvasStore.getState();
  const preferredTabId = state.resolveTabIdForEpic(payload.epicId);
  const candidateTabIds = [
    ...(preferredTabId === null ? [] : [preferredTabId]),
    ...state.openTabOrder,
    ...Object.keys(state.tabsById),
  ].filter((tabId, index, tabIds) => tabIds.indexOf(tabId) === index);
  const match = candidateTabIds
    .flatMap((tabId) => {
      const tab = state.tabsById[tabId];
      if (tab?.epicId !== payload.epicId) return [];
      const found = findOpenArtifactInTab(tabId, chatId);
      if (found === null) return [];
      const tile =
        state.canvasByTabId[tabId]?.tilesByInstanceId[found.instanceId];
      if (
        !isChatArtifactTileType(tile?.type) ||
        (targetHostId !== null && tile?.hostId !== targetHostId)
      )
        return [];
      return [{ tabId, ...found }];
    })
    .at(0);
  if (match === undefined) {
    const closedMatchTabId = candidateTabIds.find((tabId) => {
      const tab = state.tabsById[tabId];
      if (tab?.epicId !== payload.epicId) return false;
      return Object.values(state.closedTilePayloadsByTabId[tabId] ?? {}).some(
        (closed) => {
          const node = closed?.node;
          if (node === undefined) return false;
          return (
            node.id === chatId &&
            isChatArtifactTileType(node.type) &&
            (targetHostId === null || node.hostId === targetHostId)
          );
        },
      );
    });
    if (closedMatchTabId === undefined) return false;
    navigateToTabIntent(
      navigate,
      existingEpicTabIntentWithNestedFocus({
        epicId: payload.epicId,
        tabId: closedMatchTabId,
        focus: {
          focusedAt: receivedAt,
          focusArtifactId: chatId,
          focusThreadId: undefined,
          migrationSource: undefined,
        },
        nestedFocus: null,
      }),
      undefined,
    );
    return true;
  }

  const nestedFocus = state.prepareSetActiveTileTabFocusTarget(
    match.tabId,
    match.paneId,
    match.instanceId,
  );
  navigateToTabIntent(
    navigate,
    existingEpicTabIntentWithNestedFocus({
      epicId: payload.epicId,
      tabId: match.tabId,
      focus: {
        focusedAt: receivedAt,
        focusArtifactId: chatId,
        focusThreadId: undefined,
        migrationSource: undefined,
      },
      nestedFocus,
    }),
    undefined,
  );
  return true;
}

function routeLegacyTerminalNotification(
  navigate: NotificationNavigate,
  payload: ChatNotificationPayload,
  receivedAt: number,
  originHostId: string | null,
): boolean {
  if (payload.chatId === undefined) return false;
  const terminalId = payload.chatId;
  const state = useEpicCanvasStore.getState();
  const match = Object.values(state.tabsById)
    .flatMap((tab) => {
      if (tab === undefined || tab.epicId !== payload.epicId) return [];
      const found = findOpenArtifactInTab(tab.tabId, terminalId);
      if (found === null) return [];
      const tile =
        state.canvasByTabId[tab.tabId]?.tilesByInstanceId[found.instanceId];
      return tile?.type === "terminal" &&
        (originHostId === null || tile.hostId === originHostId)
        ? [{ tab, found }]
        : [];
    })
    .at(0);
  if (match === undefined) return false;

  routeTerminalNotification(
    navigate,
    {
      kind: "terminal",
      epicId: payload.epicId,
      terminalId,
      tabId: match.tab.tabId,
      paneId: match.found.paneId,
      tileInstanceId: match.found.instanceId,
    },
    receivedAt,
  );
  return true;
}
