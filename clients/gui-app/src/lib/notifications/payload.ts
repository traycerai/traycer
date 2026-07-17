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
import {
  findOpenArtifactInTab,
  useEpicCanvasStore,
} from "@/stores/epics/canvas/store";

export type NotificationPayloadKind =
  | "session"
  | "artifact"
  | "epic"
  | "approval"
  | "interview"
  | "chat"
  | "terminal";

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
}

export interface TerminalNotificationPayload {
  readonly kind: "terminal";
  readonly epicId: string;
  readonly terminalId: string;
  readonly tabId: string;
  readonly paneId: string;
  readonly tileInstanceId: string;
}

export type NotificationPayload =
  | SessionNotificationPayload
  | ArtifactNotificationPayload
  | EpicNotificationPayload
  | ApprovalNotificationPayload
  | InterviewNotificationPayload
  | ChatNotificationPayload
  | TerminalNotificationPayload;

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
  return {
    kind: "chat",
    epicId,
    chatId: chatId === null ? undefined : chatId,
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

export function parseNotificationPayload(
  value: unknown,
): NotificationPayload | null {
  if (!isRecord(value)) {
    return null;
  }

  switch (value.kind) {
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

type NavigateFn = UseNavigateResult<string>;

/**
 * Single routing entry point used by both `NotificationFocusBridge` (OS toast
 * clicks) and the in-app notifications popover. Keeps the route-target
 * contract in one place so the two surfaces cannot drift.
 */
export function routeNotification(
  navigate: NavigateFn,
  payload: NotificationPayload,
  receivedAt: number,
): void {
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
      );
      return;
    case "chat":
      routeEpicChatNotification(navigate, payload, receivedAt);
      return;
    case "terminal":
      routeTerminalNotification(navigate, payload, receivedAt);
      return;
    case "approval":
      if (payload.epicId === undefined || payload.chatId === undefined) {
        return;
      }
      routeEpicChatNotification(
        navigate,
        {
          kind: "chat",
          epicId: payload.epicId,
          chatId: payload.chatId,
        },
        receivedAt,
      );
      return;
    case "interview":
      routeEpicChatNotification(
        navigate,
        {
          kind: "chat",
          epicId: payload.epicId,
          chatId: payload.chatId,
        },
        receivedAt,
      );
      return;
    case "artifact": {
      if (payload.epicId === undefined) {
        return;
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
      );
      return;
    }
    case "session":
      return;
  }
}

function routeTerminalNotification(
  navigate: NavigateFn,
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
    );
    return;
  }

  const nestedFocus = store.prepareSetActiveTileTabFocusTarget(
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
  );
}

function routeEpicChatNotification(
  navigate: NavigateFn,
  payload: ChatNotificationPayload,
  receivedAt: number,
): void {
  if (routeLegacyTerminalNotification(navigate, payload, receivedAt)) return;
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
  );
}

function routeLegacyTerminalNotification(
  navigate: NavigateFn,
  payload: ChatNotificationPayload,
  receivedAt: number,
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
      return tile?.type === "terminal" ? [{ tab, found }] : [];
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
