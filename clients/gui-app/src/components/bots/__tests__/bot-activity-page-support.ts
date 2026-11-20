/**
 * What the Activity page's suites share: the task fixtures, the harness that
 * mounts the real page over the real hooks and stores, the readers of its rows,
 * and the per-case setup. The replaced boundaries are in
 * `bot-activity-page-mocks.ts`.
 */
import { createElement } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { type UserEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, expect, vi } from "vitest";
import type { HostNotificationsCloudFeedRow } from "@traycer/protocol/host/notifications/contracts";
import type { BotTaskEntry } from "@traycer/protocol/host/bot/schemas";
import {
  chatProjection,
  coolAllEpics,
  warmEpic,
} from "@/components/layout/tabs/side-strip/__tests__/warm-epic-fixture";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
import {
  __resetAgentActivityStoreForTests,
  __setAgentActivityPlaneAnsweringForTests,
  __setAgentActivityStateForTests,
} from "@/stores/agent-activity-store";
import {
  __resetAppLocalNotificationsStoreForTests,
  useAppLocalNotificationsStore,
} from "@/stores/notifications/app-local-notifications-store";
import { useCloudNotificationsStore } from "@/stores/notifications/cloud-notifications-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { resetNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { mocks } from "@/components/bots/__tests__/bot-activity-page-mocks";
import {
  BOT_ID,
  HOST_ID,
  Harness,
} from "@/components/bots/__tests__/bot-activity-page-harness";

export { BOT_ID, HOST_ID, Harness };

export const NOW = Date.now();

export function task(
  taskId: string,
  overrides: Partial<BotTaskEntry>,
): BotTaskEntry {
  return {
    taskId,
    cadence: { kind: "on-completion" },
    lastCheckinAt: null,
    lastCheckin: null,
    nextAt: null,
    state: "tracking",
    endedReason: null,
    createdByUserId: null,
    spun: true,
    label: null,
    originRequestId: null,
    createdByChatId: null,
    inputNeeded: null,
    pause: null,
    stop: null,
    runRequest: null,
    ...overrides,
  };
}

/** A tracking task that checks in every two hours. */
export function periodic(
  taskId: string,
  overrides: Partial<BotTaskEntry>,
): BotTaskEntry {
  return task(taskId, {
    cadence: { kind: "every", seconds: 7_200 },
    nextAt: NOW + 3_600_000,
    // Known to wait on no one; `null` would say the host cannot tell.
    inputNeeded: [],
    ...overrides,
  });
}

/** A task the bot ended because its completion check-in fired. */
export function completed(
  taskId: string,
  overrides: Partial<BotTaskEntry>,
): BotTaskEntry {
  return task(taskId, {
    cadence: { kind: "none" },
    state: "ended",
    endedReason: "completed",
    // Known to wait on no one; `null` would say the host cannot tell.
    inputNeeded: [],
    ...overrides,
  });
}

/** Who works where: the agents in each task, and which are mid-turn. */
export function working(
  byEpic: Record<string, { working: string[]; turn: string[] }>,
): void {
  // An open, answering plane served by the cloud-merged union: the whole fleet is vouched.
  __setAgentActivityPlaneAnsweringForTests();
  __setAgentActivityStateForTests(byEpic, "cloud", "connected");
}

/** The host's activity plane covers only this window's host, not the fleet. */
export function narrowActivity(): void {
  __setAgentActivityPlaneAnsweringForTests();
  __setAgentActivityStateForTests({}, "local", null);
}

export function mount(
  tasks: ReadonlyArray<BotTaskEntry>,
  options: { readonly boundHere: boolean },
): void {
  render(
    createElement(Harness, {
      threads: [],
      tasks,
      boundHere: options.boundHere,
      notificationSubscriptions: null,
    }),
  );
}

export function rows(): ReadonlyArray<HTMLElement> {
  return screen.queryAllByTestId("bot-activity-task");
}

export function rowIds(): ReadonlyArray<string | null> {
  return rows().map((el) => el.getAttribute("data-task-id"));
}

export function endedRowFor(taskId: string): HTMLElement {
  const found = screen
    .getAllByTestId("bot-activity-ended-task")
    .find((el) => el.getAttribute("data-task-id") === taskId);
  if (found === undefined) throw new Error(`no ended row for ${taskId}`);
  return found;
}

export function row(taskId: string): HTMLElement {
  const found = rows().find((el) => el.getAttribute("data-task-id") === taskId);
  if (found === undefined) throw new Error(`no row for ${taskId}`);
  return found;
}

export type WarmAgent = {
  readonly id: string;
  readonly parentId: string | null;
  readonly title: string;
  readonly archivedAt: number | null;
};

/** Registers a session for `taskId` whose agents are `agents`, parents first. */
export function warmTask(
  taskId: string,
  agents: ReadonlyArray<WarmAgent>,
): void {
  warmEpic(
    taskId,
    agents.map((agent, index) =>
      chatProjection(agent.id, {
        title: agent.title,
        parentId: agent.parentId,
        archivedAt: agent.archivedAt,
        updatedAt: 100 - index,
      }),
    ),
  );
  const handle = getOpenEpicRegistry().peek(taskId);
  if (handle === null) throw new Error(`${taskId} is not warm`);
  handle.store.setState({
    tree: {
      rootIds: agents.filter((a) => a.parentId === null).map((a) => a.id),
      childrenByParent: Object.fromEntries(
        agents.map((parent) => [
          parent.id,
          agents.filter((a) => a.parentId === parent.id).map((a) => a.id),
        ]),
      ),
      nodeById: Object.fromEntries(
        agents.map((agent, index) => [
          agent.id,
          {
            id: agent.id,
            parentId: agent.parentId,
            title: agent.title,
            type: "chat",
            status: null,
            createdAt: 0,
            updatedAt: 100 - index,
          },
        ]),
      ),
    },
  });
}

/** A result no one has read yet, held by the cloud feed for an agent of `taskId` on another host. */
export function remoteUnseenResult(
  taskId: string,
  chatId: string,
  originHostId: string,
): HostNotificationsCloudFeedRow {
  return {
    entryId: `entry-${taskId}`,
    originHostId,
    coalesceKey: `agent.stopped:${chatId}`,
    entry: {
      id: `entry-${taskId}`,
      updatedAt: NOW,
      readAt: null,
      kind: "agent.stopped",
      sourceRef: `entry-${taskId}`,
      severity: "done",
      outcome: "completed",
      epicId: taskId,
      chatId,
      payload: {
        kind: "chat",
        epicId: taskId,
        chatId,
        outcome: "completed",
      },
    },
    presentation: { epicTitle: "Epic", chatTitle: "Chat" },
  };
}

let cloudFeedVersion = 0;

export function holdCloudFeed(
  rows: ReadonlyArray<HostNotificationsCloudFeedRow>,
): void {
  useCloudNotificationsStore.setState({ accountId: "user-a" });
  useCloudNotificationsStore.getState().applySnapshot({
    rows,
    version: ++cloudFeedVersion,
    summary: {
      totalCount: rows.length,
      unreadCount: rows.filter((r) => r.entry.readAt === null).length,
      attentionCount: 0,
    },
  });
  useCloudNotificationsStore.getState().setConnectionState("connected");
}

export function band(taskId: string): string | null {
  return row(taskId).getAttribute("data-band");
}

/** A renderer-local stream failure of `chatId` in `epicId`, which `originHostId` produced. */
export function localFailure(
  epicId: string,
  chatId: string,
  originHostId: string,
): void {
  // The store keeps rows only for a signed-in identity.
  useAppLocalNotificationsStore.getState().activateIdentity("user-ada");
  useAppLocalNotificationsStore.getState().upsert({
    id: `stream.transport.error:${originHostId}:${chatId}:test`,
    originHostId,
    updatedAt: NOW,
    readAt: null,
    kind: "stream.transport.error",
    sourceRef: chatId,
    payload: { kind: "chat", epicId, chatId },
    message: "Agent stream closed unexpectedly.",
    detail: null,
  });
}

export const REPORT_METHODS = [
  "bot.task.runNow",
  "bot.task.setPaused",
  "bot.task.stop",
] as const;

/** Opens a row's reporting overflow menu, the one place its controls live. */
export async function openReportingMenu(
  user: UserEvent,
  taskId: string,
): Promise<void> {
  await user.click(
    within(row(taskId)).getByRole("button", { name: "Reporting actions" }),
  );
}

/**
 * Resolves when `element` next takes focus. The dialog hands focus back from
 * its own close handler, so a case registers this before closing and awaits
 * the event itself: no clock is read and nothing is polled.
 */
export const focusReturns = (element: HTMLElement): Promise<void> =>
  new Promise((resolve) => {
    element.addEventListener("focus", () => resolve(), { once: true });
  });

/**
 * Opens the End reporting confirmation of `t-every` with the keyboard alone:
 * the trigger takes focus, Enter opens the menu, arrows reach End reporting…
 * and Enter picks it. Returns the trigger the focus has to come back to.
 */
export async function openEndReportingByKeyboard(
  user: UserEvent,
): Promise<HTMLElement> {
  const trigger = within(row("t-every")).getByRole("button", {
    name: "Reporting actions",
  });
  trigger.focus();
  await user.keyboard("{Enter}");
  const end = screen.getByRole("menuitem", { name: "End reporting…" });
  for (let step = 0; step < 6 && document.activeElement !== end; step += 1)
    await user.keyboard("{ArrowDown}");
  if (document.activeElement !== end)
    throw new Error("arrow keys never reached End reporting…");
  await user.keyboard("{Enter}");
  expect(screen.getByText("End reporting?")).toBeTruthy();
  return trigger;
}

/**
 * The sweep: each surface of the reporting controls crossed with each way the
 * controls can go away under it. Whatever the surface, nothing of it may
 * outlive the controls, no request may follow, a held answer that arrives
 * later must change nothing, a later restored row must start fresh, and the
 * keyboard must not be stranded on a removed node.
 */
export type ReportingSurface =
  | "menu"
  | "confirmation"
  | "stop in flight"
  | "check-in in flight"
  | "pause in flight";

/** Brings the keyboard to the menu item named `name`, with the menu open. */
export async function focusMenuItem(
  user: UserEvent,
  name: string,
): Promise<void> {
  const trigger = within(row("t-every")).getByRole("button", {
    name: "Reporting actions",
  });
  trigger.focus();
  await user.keyboard("{Enter}");
  const item = screen.getByRole("menuitem", { name });
  for (let step = 0; step < 6 && document.activeElement !== item; step += 1)
    await user.keyboard("{ArrowDown}");
  if (document.activeElement !== item)
    throw new Error(`arrow keys never reached ${name}`);
}

/** Puts the controls of `t-every` into `surface` and returns once it is up. */
export async function reachReportingSurface(
  user: UserEvent,
  surface: ReportingSurface,
): Promise<void> {
  if (surface === "menu") {
    await focusMenuItem(user, "Check in now");
  } else if (surface === "confirmation") {
    await openEndReportingByKeyboard(user);
  } else if (surface === "stop in flight") {
    mocks.stop.hold = true;
    await openEndReportingByKeyboard(user);
    await user.click(screen.getByRole("button", { name: "End reporting" }));
  } else {
    const key = surface === "check-in in flight" ? "runNow" : "setPaused";
    mocks[key].hold = true;
    await focusMenuItem(
      user,
      surface === "check-in in flight" ? "Check in now" : "Pause reports",
    );
    await user.keyboard("{Enter}");
  }
}

export function installPageCaseLifecycle(): void {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.supported = new Set();
    mocks.state.realManifest = false;
    resetNegotiatedManifests();
    mocks.state.taskTitles = {};
    mocks.state.epicFlags = {};
    mocks.state.chatFlags = {};
    mocks.state.chatFlagsByHost = {};
    mocks.state.unreachable = new Set();
    mocks.state.indicatorRead = "ok";
    mocks.state.feedMode = "local";
    mocks.actions.length = 0;
    mocks.stop.hold = false;
    mocks.stop.settle = null;
    mocks.runNow.hold = false;
    mocks.runNow.settle = null;
    mocks.runNow.fail = null;
    mocks.setPaused.hold = false;
    mocks.setPaused.settle = null;
    mocks.setPaused.fail = null;
    mocks.forgetAnswers();
    __resetAgentActivityStoreForTests();
    // Every case starts with the fleet vouched, so a quiet seen row can leave.
    working({});
    // Both sources answer: the cloud feed is connected with its snapshot, so a
    // quiet seen row has been proved quiet everywhere and may leave.
    holdCloudFeed([]);
    useAuthStore.setState({
      status: "signed-in",
      profile: {
        userId: "user-ada",
        userName: "Ada",
        email: "ada@example.com",
      },
      contextMetadata: { userId: "user-ada", username: "ada" },
    });
  });

  afterEach(() => {
    cleanup();
    __resetAppLocalNotificationsStoreForTests();
    useCloudNotificationsStore.getState().reset();
    coolAllEpics();
    __resetAgentActivityStoreForTests();
    useAuthStore.setState({
      status: "signed-out",
      profile: null,
      contextMetadata: null,
    });
  });
}
