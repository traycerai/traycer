import type { BackgroundItem } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ManagedCommand } from "@traycer/protocol/host/managed-command/unary-schemas";
import type { HostNotificationsIndicatorState } from "@traycer/protocol/host/notifications/contracts";
import { categoryForNotificationSource } from "@/lib/notifications/notification-category";
import type {
  ApprovalNotificationPayload,
  BrowserSessionNotificationPayload,
  InterviewNotificationPayload,
} from "@/lib/notifications/payload";
import type {
  MergedNotificationRow,
  MergedNotificationSource,
} from "@/stores/notifications/merged-notifications";
import type { EpicAgentActivity } from "@/lib/agent-activity";
import type { FocusAgentIdentity } from "@/lib/home-focus/focus-tasks";
import type { FocusBackgroundChat } from "@/lib/home-focus/focus-background";

/**
 * Small typed factories for the home-focus test suites, mirroring the
 * `Partial<T> & Pick<T, ...>` shape `notification-lifecycle.test.ts` already
 * uses for its own row fixture: every field defaults to an innocuous value so
 * a test only names what it is actually asserting on, and `overrides` always
 * wins because it spreads last.
 */

export function makeMergedNotificationRow(
  overrides: Partial<MergedNotificationRow> &
    Pick<MergedNotificationRow, "feedId">,
): MergedNotificationRow {
  const source: MergedNotificationSource = overrides.source ?? "host";
  return {
    source,
    sourceId: overrides.feedId,
    createdAt: 0,
    readAt: null,
    title: "Notification",
    body: "Body",
    payload: null,
    agentSurface: null,
    hostKind: null,
    appLocalKind: null,
    globalEntry: null,
    severity: "info",
    outcome: null,
    resolvedAt: null,
    sourceRef: null,
    originHostId: null,
    providerPackAttribution: null,
    category: categoryForNotificationSource(source),
    ...overrides,
  };
}

export function makeApprovalPayload(
  epicId: string | undefined,
  chatId: string | undefined,
): ApprovalNotificationPayload {
  return {
    kind: "approval",
    epicId,
    chatId,
    approvalId: undefined,
    sessionId: undefined,
    artifactId: undefined,
  };
}

export function makeInterviewPayload(
  epicId: string,
  chatId: string,
): InterviewNotificationPayload {
  return { kind: "interview", epicId, chatId, interviewBlockId: undefined };
}

export function makeBrowserSessionPayload(
  epicId: string,
  sessionId: string,
  tabId: string,
): BrowserSessionNotificationPayload {
  return { kind: "browserSession", epicId, sessionId, tabId };
}

export function makeEpicAgentActivity(
  working: ReadonlyArray<string>,
  turn: ReadonlyArray<string>,
): EpicAgentActivity {
  return { working: new Set(working), turn: new Set(turn) };
}

export function makeFocusAgentIdentity(
  overrides: Partial<FocusAgentIdentity> & Pick<FocusAgentIdentity, "surface">,
): FocusAgentIdentity {
  return {
    title: null,
    parentId: null,
    hostId: null,
    ...overrides,
  };
}

export function makeIndicatorFlags(
  overrides: Partial<HostNotificationsIndicatorState>,
): HostNotificationsIndicatorState {
  return {
    pendingApproval: false,
    pendingInterview: false,
    unreadFailure: false,
    unreadDone: false,
    pendingFork: false,
    ...overrides,
  };
}

export function makeManagedCommand(
  overrides: Partial<ManagedCommand> & Pick<ManagedCommand, "id">,
): ManagedCommand {
  return {
    monitoring: false,
    description: "Command",
    command: null,
    cwd: null,
    cadence: null,
    status: { state: "running", pid: 1, startedAtMs: 0 },
    relaunchOnHostRestart: true,
    chatId: "chat-1",
    createdAtMs: 0,
    updatedAtMs: 0,
    ...overrides,
  };
}

interface RunningBackgroundItemOverrides {
  readonly taskId: string;
  readonly title?: string;
  readonly blockId?: string;
  readonly parentTaskId?: string | null;
  readonly kind?: "subagent" | "monitor";
}

/** A running, non-wakeup background item - the only kind a "root" test needs
 * to distinguish from `wakeup`. */
export function makeRunningBackgroundItem(
  overrides: RunningBackgroundItemOverrides,
): BackgroundItem {
  return {
    kind: overrides.kind ?? "subagent",
    taskId: overrides.taskId,
    title: overrides.title ?? "Subagent",
    blockId: overrides.blockId ?? overrides.taskId,
    parentTaskId: overrides.parentTaskId ?? null,
    scheduledFor: null,
  };
}

interface WakeupBackgroundItemOverrides {
  readonly taskId: string;
  readonly title?: string;
  readonly scheduledFor: number;
  readonly parentTaskId?: string | null;
}

export function makeWakeupBackgroundItem(
  overrides: WakeupBackgroundItemOverrides,
): BackgroundItem {
  return {
    kind: "wakeup",
    taskId: overrides.taskId,
    title: overrides.title ?? "Wakeup",
    blockId: overrides.taskId,
    parentTaskId: overrides.parentTaskId ?? null,
    scheduledFor: overrides.scheduledFor,
  };
}

export function makeFocusBackgroundChat(
  overrides: Partial<FocusBackgroundChat> &
    Pick<FocusBackgroundChat, "epicId" | "chatId">,
): FocusBackgroundChat {
  return {
    hostId: "host-1",
    taskTitle: null,
    chatTitle: null,
    managedCommands: [],
    backgroundItems: [],
    ...overrides,
  };
}
