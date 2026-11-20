/**
 * A bot's Activity page (Tracy Bots, decision 182): one list of the tasks the
 * bot started, while anything in them is still going on. The real page runs
 * over the real `useBotActiveTasks`, the real agent-activity store (driven by
 * its test seams), the real notification-indicator hooks (the host answers
 * `host.notifications.indicatorState`), and, for a warm task, a real open-epic
 * store registered in the real registry. Only the external boundaries are
 * replaced: the host's query transport, the task-title read, host
 * reachability, the member actions' writes and navigation. This file holds
 * which tasks are listed and how each row's status is worked out.
 */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type {
  BotInputNeeded,
  BotTaskEntry,
} from "@traycer/protocol/host/bot/schemas";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
import {
  __resetAgentActivityStoreForTests,
  __setHostAgentActivityHealthForTests,
  __setHostAgentActivityStateForTests,
  TEST_LOCAL_ACTIVITY_HOST_ID,
} from "@/stores/agent-activity-store";
import { useCloudNotificationsStore } from "@/stores/notifications/cloud-notifications-store";
import { postThread } from "@/components/bots/__tests__/bot-turn-test-support";
import { mocks } from "@/components/bots/__tests__/bot-activity-page-mocks";
import {
  HOST_ID,
  Harness,
  NOW,
  type WarmAgent,
  band,
  completed,
  holdCloudFeed,
  localFailure,
  mount,
  narrowActivity,
  periodic,
  remoteUnseenResult,
  row,
  rowIds,
  rows,
  task,
  warmTask,
  working,
  installPageCaseLifecycle,
} from "@/components/bots/__tests__/bot-activity-page-support";
import {
  waiting,
  taskUnread,
  agentUnread,
  glyphKind,
  sidebarRollupKind,
  expandRow,
} from "@/components/bots/__tests__/bot-activity-page-listing-support";

vi.mock("@tanstack/react-router", async () =>
  (
    await import("@/components/bots/__tests__/bot-activity-page-mocks")
  ).routerMock(),
);
vi.mock("@/lib/tab-navigation", async (importOriginal) =>
  (
    await import("@/components/bots/__tests__/bot-activity-page-mocks")
  ).tabNavigationMock(
    await importOriginal<typeof import("@/lib/tab-navigation")>(),
  ),
);
vi.mock("@/hooks/host/use-tab-host-client", async () =>
  (
    await import("@/components/bots/__tests__/bot-activity-page-mocks")
  ).tabHostClientMock(),
);
vi.mock("@/hooks/epic/use-epic-get-task-contexts-query", async () =>
  (
    await import("@/components/bots/__tests__/bot-activity-page-mocks")
  ).taskContextsMock(),
);
vi.mock("@/hooks/host/use-host-supports-method", async (importOriginal) =>
  (
    await import("@/components/bots/__tests__/bot-activity-page-mocks")
  ).hostSupportsMethodMock(
    await importOriginal<
      typeof import("@/hooks/host/use-host-supports-method")
    >(),
  ),
);
vi.mock("@/hooks/bots/use-bot-activity", async () =>
  (
    await import("@/components/bots/__tests__/bot-activity-page-mocks")
  ).botActivityMock(),
);
vi.mock("@/hooks/agent/use-host-reachability", async () =>
  (
    await import("@/components/bots/__tests__/bot-activity-page-mocks")
  ).hostReachabilityMock(),
);
vi.mock("@/hooks/bots/use-bot-task-action-mutations", async () =>
  (
    await import("@/components/bots/__tests__/bot-activity-page-mocks")
  ).taskActionMutationsMock(),
);
vi.mock("@/components/epic-canvas/sidebar/use-chat-row-open-ref", async () =>
  (
    await import("@/components/bots/__tests__/bot-activity-page-mocks")
  ).chatRowOpenRefMock(),
);
vi.mock("@/hooks/notifications/use-notification-host", async () =>
  (
    await import("@/components/bots/__tests__/bot-activity-page-mocks")
  ).notificationHostMock(),
);
vi.mock("@/hooks/host/use-host-client-for-host-id", async () =>
  (
    await import("@/components/bots/__tests__/bot-activity-page-mocks")
  ).hostClientForHostIdMock(),
);
vi.mock("@/hooks/host/use-host-queries", async () =>
  (
    await import("@/components/bots/__tests__/bot-activity-page-mocks")
  ).hostQueriesMock(),
);

installPageCaseLifecycle();

/** A question of `agentChatId` waiting on a person: the interview surface. */
function waitingQuestion(
  agentChatId: string,
  reportedAt: number,
): BotInputNeeded {
  return {
    ...waiting(agentChatId, reportedAt, "unused"),
    surface: {
      kind: "question",
      blockId: `block-${agentChatId}`,
      questions: [
        {
          questionId: "q-1",
          text: "Which branch?",
          options: ["main", "dev"],
          allowsFreeText: true,
        },
      ],
      askedAt: reportedAt,
    },
  };
}

/** A cloud-fed notification centre: its rows count as evidence only while connected with a snapshot. */
function mountInCloudMode(
  tasks: ReadonlyArray<BotTaskEntry>,
  cloud: { readonly connected: boolean },
): void {
  mocks.state.feedMode = "cloud";
  useCloudNotificationsStore.setState({
    hasSnapshot: cloud.connected,
    connectionState: cloud.connected ? "connected" : "unavailable",
  });
  render(
    <Harness
      threads={[]}
      tasks={tasks}
      boundHere
      notificationSubscriptions={null}
    />,
  );
}

function endedRowIds(): ReadonlyArray<string | null> {
  return screen
    .queryAllByTestId("bot-activity-ended-task")
    .map((el) => el.getAttribute("data-task-id"));
}

function saysStatusUnknownOnce(taskId: string): boolean {
  return row(taskId).textContent.split("Status unknown").length === 2;
}

function glyphLabel(taskId: string): string | null {
  return within(row(taskId))
    .getByTestId("bot-activity-task-glyph")
    .getAttribute("aria-label");
}

const PENDING_KINDS = [
  { flag: "pendingApproval", words: "1 waiting for approval" },
  { flag: "pendingInterview", words: "1 waiting for interview" },
  { flag: "pendingFork", words: "1 waiting for fork resolution" },
] as const;

/** Every way the remote answer for the task's hosts can fail to vouch. */
const UNVOUCHED = [
  {
    name: "indicator read pending",
    apply: () => {
      mocks.state.indicatorRead = "pending";
    },
  },
  {
    name: "indicator read failed",
    apply: () => {
      mocks.state.indicatorRead = "error";
    },
  },
  {
    name: "indicator read unanswered",
    apply: () => {
      mocks.state.indicatorRead = "unanswered";
    },
  },
  {
    name: "hosts unreachable",
    apply: () => {
      mocks.state.unreachable.add("host-notifications");
      mocks.state.unreachable.add("host-a");
    },
  },
] as const;

function agentKinds(
  taskId: string,
): ReadonlyArray<[string | null, string | null]> {
  return within(row(taskId))
    .getAllByTestId("bot-activity-agent")
    .map((el) => [
      el.getAttribute("data-agent-id"),
      el.getAttribute("data-kind"),
    ]);
}

const FORK_WORDS = "1 waiting for fork resolution";

const INTERVIEW_WORDS = "1 waiting for interview";

const APPROVAL_WORDS = "1 waiting for approval";

/** `hostId`'s activity stream is open with its state frame landed, claiming only its own agents. */
function planeAnswers(
  hostId: string,
  byEpic: Record<string, { working: string[]; turn: string[] }>,
): void {
  __setHostAgentActivityStateForTests(hostId, byEpic, "local", null);
  __setHostAgentActivityHealthForTests(hostId, {
    connectionStatus: "open",
    stateFrameSeenThisEpoch: true,
  });
}

/** `hostId`'s stream answered, then dropped: its slice is held, and no one vouches for it. */
function planeHeld(
  hostId: string,
  byEpic: Record<string, { working: string[]; turn: string[] }>,
): void {
  planeAnswers(hostId, byEpic);
  __setHostAgentActivityHealthForTests(hostId, {
    connectionStatus: "reconnecting",
  });
}

describe("<BotActivityPage /> subscriptions", () => {
  it("says subscriptions are unavailable when unread, and draws no section at all when known empty", () => {
    const view = render(
      <Harness
        threads={[]}
        tasks={[]}
        boundHere
        notificationSubscriptions={null}
      />,
    );
    expect(screen.getByText("Subscriptions unavailable")).toBeTruthy();

    view.rerender(
      <Harness
        threads={[]}
        tasks={[]}
        boundHere
        notificationSubscriptions={[]}
      />,
    );
    expect(screen.queryByText("Subscriptions unavailable")).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Notification subscriptions" }),
    ).toBeNull();
    expect(screen.queryByText("No notification subscriptions")).toBeNull();
    // Nothing in either list: the page says so once.
    expect(screen.getByTestId("bot-activity-empty").textContent).toBe(
      "No activity yetKeep track of work Tracy is handling. Tasks and updates that need your attention will appear here.",
    );
    expect(screen.getByTestId("bot-activity-empty-art")).toBeTruthy();
  });

  it("describes each subscription as watching notifications, with its actual filter and nothing about target or cadence", () => {
    render(
      <Harness
        threads={[]}
        tasks={[]}
        boundHere
        notificationSubscriptions={[
          {
            target: { kind: "trunk" },
            attentionOnly: true,
            everySeconds: 3600,
            since: NOW,
            digests: [],
          },
          {
            target: { kind: "thread", threadId: "thread-1" },
            attentionOnly: false,
            everySeconds: null,
            since: null,
            digests: null,
          },
        ]}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Notification subscriptions" }),
    ).toBeTruthy();
    const region = screen.getByRole("region", {
      name: "Notification subscriptions",
    });
    expect(within(region).getAllByText("Watching notifications")).toHaveLength(
      2,
    );
    expect(within(region).getByText("Needs attention only")).toBeTruthy();
    expect(within(region).getByText("All notifications")).toBeTruthy();
    expect(region.textContent).not.toMatch(
      /Trunk|Thread:|Every hour|Each burst/,
    );
  });
});

describe("<BotActivityPage /> thread subscriptions", () => {
  it("names a thread subscription by its excerpt, or by its position when it has none, never by its thread ID, and shows no shell section", () => {
    const first = postThread();
    if (first.anchor === null) throw new Error("thread fixture has no anchor");
    const named = {
      ...first,
      threadId: "thread-named",
      sessionChatId: "chat-named",
      anchor: { ...first.anchor, excerpt: "Release discussion" },
    };
    const unnamed = {
      ...first,
      threadId: "thread-fallback",
      sessionChatId: "chat-fallback",
    };
    render(
      <Harness
        tasks={[]}
        threads={[named, unnamed]}
        boundHere
        notificationSubscriptions={[
          {
            target: { kind: "thread", threadId: named.threadId },
            attentionOnly: true,
            everySeconds: null,
            since: null,
            digests: null,
          },
          {
            target: { kind: "thread", threadId: unnamed.threadId },
            attentionOnly: false,
            everySeconds: null,
            since: null,
            digests: null,
          },
        ]}
      />,
    );
    const subscriptions = screen.getByRole("region", {
      name: "Notification subscriptions",
    });
    expect(
      within(subscriptions).getAllByText("Watching notifications"),
    ).toHaveLength(2);
    expect(
      within(subscriptions).getByText("Needs attention only"),
    ).toBeTruthy();
    expect(within(subscriptions).getByText("All notifications")).toBeTruthy();
    expect(within(subscriptions).getByText("Release discussion")).toBeTruthy();
    expect(within(subscriptions).getByText("Thread 2")).toBeTruthy();
    expect(subscriptions.textContent).not.toMatch(/Thread:|thread-fallback/);
    expect(
      screen.queryByRole("region", { name: "Shells and monitors" }),
    ).toBeNull();
  });
});

describe("<BotActivityPage /> what is listed", () => {
  it("rule 2: lists a task with a working agent, one that waits on a person, one with an unseen result and a periodic one; a quiet seen task is absent", () => {
    working({ "t-working": { working: ["a-1"], turn: ["a-1"] } });
    // Both sources answer, so the quiet seen task has been proved quiet.
    mocks.state.feedMode = "cloud";
    holdCloudFeed([
      remoteUnseenResult("t-unseen", "chat-t-unseen", "host-remote"),
    ]);
    mount(
      [
        task("t-working", {}),
        task("t-waiting", {
          inputNeeded: [waiting("a-2", NOW, "Merge the release PR")],
        }),
        task("t-unseen", {}),
        periodic("t-every", {}),
        completed("t-quiet", { lastCheckinAt: NOW }),
      ],
      { boundHere: true },
    );

    expect([...rowIds()].sort()).toEqual([
      "t-every",
      "t-unseen",
      "t-waiting",
      "t-working",
    ]);
  });

  it("rule 2: a task ended by its check-in is listed once, as ended, even while an agent in it still works", () => {
    working({ "t-ended": { working: ["a-1"], turn: ["a-1"] } });
    mount([completed("t-ended", { lastCheckinAt: NOW })], { boundHere: true });

    expect(rowIds()).toEqual([]);
    expect(endedRowIds()).toEqual(["t-ended"]);
  });

  it("lists a task the bot adopted by the same rule as one it started, once: a periodic one is active and the ended ones are recent", () => {
    working({ "t-adopted-working": { working: ["a-1"], turn: ["a-1"] } });
    mocks.state.feedMode = "cloud";
    holdCloudFeed([
      remoteUnseenResult(
        "t-adopted-unseen",
        "chat-t-adopted-unseen",
        "host-remote",
      ),
    ]);
    mount(
      [
        periodic("t-adopted-every", { spun: false }),
        completed("t-adopted-working", { spun: false, lastCheckinAt: NOW }),
        completed("t-adopted-unseen", { spun: false, lastCheckinAt: NOW }),
        completed("t-adopted-seen", { spun: false, lastCheckinAt: NOW }),
      ],
      { boundHere: true },
    );

    expect(rowIds()).toEqual(["t-adopted-every"]);
    expect([...endedRowIds()].sort()).toEqual([
      "t-adopted-seen",
      "t-adopted-unseen",
      "t-adopted-working",
    ]);
  });

  it("names a row by the task's own title, never by the bot's label or the id", () => {
    mocks.state.taskTitles = {
      "t-titled": "Release notes for 1.9",
      "t-labelled": "Nightly flake roster",
    };
    mount(
      [
        periodic("t-titled", { label: null }),
        periodic("t-labelled", { label: "bot-supplied-label" }),
      ],
      { boundHere: true },
    );

    expect(
      within(row("t-titled")).getByText("Release notes for 1.9"),
    ).toBeTruthy();
    expect(
      within(row("t-labelled")).getByText("Nightly flake roster"),
    ).toBeTruthy();
    const text = screen.getByTestId("bot-activity-page").textContent;
    expect(text).not.toContain("bot-supplied-label");
    expect(text).not.toContain("t-titled");
    expect(text).not.toContain("t-labelled");
  });

  it("labels a row whose title is not known as Task, still opens it, and shows no id", async () => {
    const user = userEvent.setup();
    mount([periodic("t-untitled-8f3a", { label: "bot-supplied-label" })], {
      boundHere: true,
    });

    const summary = row("t-untitled-8f3a");
    expect(within(summary).getByText("Task")).toBeTruthy();
    expect(summary.textContent).not.toContain("t-untitled-8f3a");
    expect(summary.textContent).not.toContain("bot-supplied-label");

    await user.click(within(summary).getByText("Task"));
    expect(mocks.navigateToTabIntent).toHaveBeenCalledTimes(1);
  });

  it("draws one list under the Tasks heading and none of the old sections", () => {
    working({ "t-working": { working: ["a-1"], turn: ["a-1"] } });
    mount([task("t-working", {}), periodic("t-every", {})], {
      boundHere: true,
    });

    expect(screen.getByRole("heading", { name: "Tasks" })).toBeTruthy();
    const text = screen.getByTestId("bot-activity-page").textContent;
    for (const gone of [
      "Running now",
      "Tasks and automations",
      "Notifications",
      "Finished",
      "All finished work",
    ]) {
      expect(text).not.toContain(gone);
    }
  });

  it("with nothing active, draws no Tasks heading, and says so only when subscriptions are known empty too", () => {
    mocks.state.feedMode = "cloud";
    const view = render(
      <Harness
        threads={[]}
        tasks={[]}
        boundHere
        notificationSubscriptions={[]}
      />,
    );
    expect(rows()).toHaveLength(0);
    expect(screen.queryByRole("heading", { name: "Tasks" })).toBeNull();
    expect(screen.getByTestId("bot-activity-empty").textContent).toBe(
      "No activity yetKeep track of work Tracy is handling. Tasks and updates that need your attention will appear here.",
    );
    expect(screen.getByTestId("bot-activity-empty-art")).toBeTruthy();

    // Subscriptions unread or present: no empty message, and still no heading.
    for (const subscriptions of [
      null,
      [
        {
          target: { kind: "trunk" as const },
          attentionOnly: false,
          everySeconds: null,
          since: null,
          digests: null,
        },
      ],
    ]) {
      view.rerender(
        <Harness
          threads={[]}
          tasks={[]}
          boundHere
          notificationSubscriptions={subscriptions}
        />,
      );
      expect(screen.queryByTestId("bot-activity-empty")).toBeNull();
      expect(screen.queryByRole("heading", { name: "Tasks" })).toBeNull();
    }
  });
});

describe("<BotActivityPage /> when the evidence is incomplete", () => {
  /** A periodic task, seen and quiet: it reads as unknown until every source proves it. */
  const QUIET = (): BotTaskEntry => periodic("t-quiet", { lastCheckinAt: NOW });

  it("keeps an on-completion task still tracking as status unknown, though nothing works or is unseen yet, and drops its ended and seen counterpart", () => {
    mocks.state.feedMode = "cloud";
    // Tracking can precede the completion report: no activity and nothing
    // unread is not proof that the task has finished.
    mount(
      [
        task("t-tracking", { cadence: { kind: "on-completion" } }),
        completed("t-ended", { lastCheckinAt: NOW }),
      ],
      { boundHere: true },
    );

    expect(rowIds()).toEqual(["t-tracking"]);
    expect(row("t-tracking").textContent.split("Status unknown")).toHaveLength(
      2,
    );
  });

  it("keeps it, as status unknown, while the activity plane covers only part of the fleet", () => {
    narrowActivity();
    mount([QUIET()], { boundHere: true });

    expect(rowIds()).toEqual(["t-quiet"]);
    // Said once, not again by the cold-host label.
    expect(row("t-quiet").textContent.split("Status unknown")).toHaveLength(2);
  });

  it("keeps it unknown while the host's indicator read is pending, and reads it periodic when the read lands", () => {
    mocks.state.feedMode = "cloud";
    mocks.state.indicatorRead = "pending";
    const view = render(
      <Harness
        threads={[]}
        tasks={[QUIET()]}
        boundHere
        notificationSubscriptions={null}
      />,
    );
    expect(rowIds()).toEqual(["t-quiet"]);

    mocks.state.indicatorRead = "ok";
    mocks.forgetAnswers();
    view.rerender(
      <Harness
        threads={[]}
        tasks={[QUIET()]}
        boundHere
        notificationSubscriptions={null}
      />,
    );
    expect(rowIds()).toEqual(["t-quiet"]);
    expect(band("t-quiet")).toBe("periodic");
  });

  it("keeps it when the host's indicator read failed", () => {
    mocks.state.indicatorRead = "error";
    mount([QUIET()], { boundHere: true });

    expect(rowIds()).toEqual(["t-quiet"]);
  });

  it("keeps it while the host that answers indicators is unreachable", () => {
    mocks.state.unreachable.add("host-notifications");
    mount([QUIET()], { boundHere: true });

    expect(rowIds()).toEqual(["t-quiet"]);
  });

  it("keeps it unknown while a cloud-fed centre is disconnected or has no snapshot, and reads it periodic once connected", () => {
    mountInCloudMode([QUIET()], { connected: false });
    expect(rowIds()).toEqual(["t-quiet"]);
    expect(band("t-quiet")).toBe("unknown");
    cleanup();

    mountInCloudMode([QUIET()], { connected: true });
    expect(rowIds()).toEqual(["t-quiet"]);
    expect(band("t-quiet")).toBe("periodic");
  });

  it("never lets missing evidence hide a positive signal: waiting, unseen and scheduled rows keep their own band", () => {
    narrowActivity();
    taskUnread("t-unseen", { unreadDone: true });
    mount(
      [
        task("t-unseen", { inputNeeded: [] }),
        task("t-waiting", {
          inputNeeded: [waiting("a-2", NOW, "Merge the release PR")],
        }),
        periodic("t-every", {}),
      ],
      { boundHere: true },
    );

    // Each keeps the band its own signal earns, ahead of any unproven row.
    expect(rowIds()).toEqual(["t-waiting", "t-unseen", "t-every"]);
    // A state that is known is never also called unknown.
    for (const id of ["t-waiting", "t-unseen"]) {
      expect(row(id).textContent).not.toContain("Status unknown");
    }
  });

  it("lists an unproven row last, below every row with a known state", () => {
    narrowActivity();
    mount(
      [
        QUIET(),
        task("t-waiting", {
          inputNeeded: [waiting("a-2", NOW, "Merge the release PR")],
        }),
      ],
      { boundHere: true },
    );

    expect(rowIds()).toEqual(["t-waiting", "t-quiet"]);
  });
});

describe("<BotActivityPage /> a source that cannot vouch never reads as proof of quiet", () => {
  /** A periodic task, seen, nothing working, and waiting on no one: it reads periodic only on proof from every source. */
  const QUIET = (overrides: Partial<BotTaskEntry>): BotTaskEntry =>
    periodic("t-quiet", { lastCheckinAt: NOW, ...overrides });

  it("keeps a task whose waiting is unknown (a host that predates it, or a room it cannot read) as status unknown, while a known-empty one reads periodic", () => {
    mountInCloudMode([QUIET({ inputNeeded: null })], { connected: true });
    expect(rowIds()).toEqual(["t-quiet"]);
    expect(band("t-quiet")).toBe("unknown");
    expect(saysStatusUnknownOnce("t-quiet")).toBe(true);
    cleanup();

    mountInCloudMode([QUIET({ inputNeeded: [] })], { connected: true });
    expect(rowIds()).toEqual(["t-quiet"]);
    expect(band("t-quiet")).toBe("periodic");
  });

  it("keeps a task whose waiting is unknown while the indicator read is still pending", () => {
    mocks.state.indicatorRead = "pending";
    mountInCloudMode([QUIET({ inputNeeded: null })], { connected: true });

    expect(rowIds()).toEqual(["t-quiet"]);
    expect(band("t-quiet")).toBe("unknown");
  });

  it("never lets an unknown waiting list hide a waiting task: a known one keeps its own band", () => {
    mountInCloudMode(
      [
        QUIET({ inputNeeded: null }),
        task("t-waiting", {
          inputNeeded: [waiting("a-2", NOW, "Merge the release PR")],
        }),
      ],
      { connected: true },
    );

    expect(rowIds()).toEqual(["t-waiting", "t-quiet"]);
    expect(band("t-waiting")).toBe("needs-you");
  });

  it("keeps a quiet task when the host's indicator read settled with no answer (a host without the method)", () => {
    mocks.state.indicatorRead = "unanswered";
    mountInCloudMode([QUIET({})], { connected: true });

    expect(rowIds()).toEqual(["t-quiet"]);
    expect(band("t-quiet")).toBe("unknown");
    expect(saysStatusUnknownOnce("t-quiet")).toBe(true);
  });

  it("keeps a quiet task when the cloud feed is unsupported and only this host answers, though another host holds an unseen result for it", () => {
    holdCloudFeed([
      remoteUnseenResult("t-quiet", "chat-t-quiet", "host-remote"),
    ]);
    mocks.state.feedMode = "local";
    mount([QUIET({})], { boundHere: true });

    expect(rowIds()).toEqual(["t-quiet"]);
    expect(band("t-quiet")).toBe("unknown");
    expect(saysStatusUnknownOnce("t-quiet")).toBe(true);
  });

  it("keeps a quiet task while the notification feed needs an upgrade, and reads it periodic over a connected cloud feed", () => {
    mocks.state.feedMode = "upgrade-required";
    mount([QUIET({})], { boundHere: true });
    expect(rowIds()).toEqual(["t-quiet"]);
    cleanup();

    mocks.state.feedMode = "cloud";
    mount([QUIET({})], { boundHere: true });
    expect(rowIds()).toEqual(["t-quiet"]);
    expect(band("t-quiet")).toBe("periodic");
  });
});

describe("<BotActivityPage /> what a lost connection leaves cached is never shown as current", () => {
  it("shows Status unknown, not working, for an agent the activity plane counted before its stream dropped", () => {
    working({ "t-run": { working: ["a-1"], turn: ["a-1"] } });
    const view = render(
      <Harness
        threads={[]}
        tasks={[task("t-run", {})]}
        boundHere
        notificationSubscriptions={null}
      />,
    );
    expect(band("t-run")).toBe("working");

    // The counts stay held; the stream that kept them current is gone.
    act(() =>
      __setHostAgentActivityHealthForTests(TEST_LOCAL_ACTIVITY_HOST_ID, {
        connectionStatus: "reconnecting",
      }),
    );
    view.rerender(
      <Harness
        threads={[]}
        tasks={[task("t-run", {})]}
        boundHere
        notificationSubscriptions={null}
      />,
    );

    expect(rowIds()).toEqual(["t-run"]);
    expect(band("t-run")).toBe("unknown");
    expect(saysStatusUnknownOnce("t-run")).toBe(true);
  });

  it("shows Status unknown, not unread, for a result the cloud feed held before it disconnected", () => {
    mocks.state.feedMode = "cloud";
    holdCloudFeed([remoteUnseenResult("t-done", "chat-t-done", "host-remote")]);
    mount([task("t-done", { inputNeeded: [] })], { boundHere: true });
    expect(band("t-done")).toBe("unseen");

    act(() =>
      useCloudNotificationsStore.getState().setConnectionState("reconnecting"),
    );

    expect(band("t-done")).toBe("unknown");
    expect(saysStatusUnknownOnce("t-done")).toBe(true);
  });

  it("shows Status unknown, not waiting, for a surface the bot's serving host reported before that host became unreachable, and ignores an unrelated host", () => {
    const tasks = [
      task("t-wait", {
        inputNeeded: [waiting("a-2", NOW, "Merge the release PR")],
      }),
    ];
    const view = render(
      <Harness
        threads={[]}
        tasks={tasks}
        boundHere
        notificationSubscriptions={null}
      />,
    );
    expect(band("t-wait")).toBe("needs-you");

    mocks.state.unreachable.add("host-unrelated");
    view.rerender(
      <Harness
        threads={[]}
        tasks={[...tasks]}
        boundHere
        notificationSubscriptions={null}
      />,
    );
    expect(band("t-wait")).toBe("needs-you");

    mocks.state.unreachable.add(HOST_ID);
    view.rerender(
      <Harness
        threads={[]}
        tasks={[...tasks]}
        boundHere
        notificationSubscriptions={null}
      />,
    );
    expect(band("t-wait")).toBe("unknown");
    expect(saysStatusUnknownOnce("t-wait")).toBe(true);
  });
});

describe("<BotActivityPage /> activity held by two hosts' streams", () => {
  const A = "host-agents-a";
  const B = "host-agents-b";
  const bands = (): ReadonlyArray<string | null> =>
    rows().map((el) => el.getAttribute("data-band"));

  /** One host's stream open with its `state` frame landed, claiming what it can see. */
  function hostAnswers(
    hostId: string,
    byEpic: Record<string, { working: string[]; turn: string[] }>,
    servedBy: "cloud" | "local",
  ): void {
    __setHostAgentActivityStateForTests(
      hostId,
      byEpic,
      servedBy,
      servedBy === "cloud" ? "connected" : null,
    );
    __setHostAgentActivityHealthForTests(hostId, {
      connectionStatus: "open",
      stateFrameSeenThisEpoch: true,
    });
  }

  it("does not show working from a host whose stream is held, though another host's fresh fleet answer holds none", () => {
    __resetAgentActivityStoreForTests();
    mocks.state.feedMode = "cloud";
    hostAnswers(A, { "t-run": { working: ["a-1"], turn: ["a-1"] } }, "local");
    hostAnswers(B, {}, "cloud");
    const view = render(
      <Harness
        threads={[]}
        tasks={[task("t-run", { inputNeeded: [] })]}
        boundHere
        notificationSubscriptions={null}
      />,
    );
    // While A answers, its agent is working.
    expect(bands()).toEqual(["working"]);

    // A's stream drops: its slice keeps the count, but no one vouches for it.
    act(() =>
      __setHostAgentActivityHealthForTests(A, {
        connectionStatus: "reconnecting",
      }),
    );
    view.rerender(
      <Harness
        threads={[]}
        tasks={[task("t-run", { inputNeeded: [] })]}
        boundHere
        notificationSubscriptions={null}
      />,
    );

    expect(bands()).not.toContain("working");
  });

  it("still shows working from a host that answers for its own agents when no host vouches for the whole fleet, and keeps a quiet task unproven", () => {
    __resetAgentActivityStoreForTests();
    mocks.state.feedMode = "cloud";
    hostAnswers(A, { "t-run": { working: ["a-1"], turn: ["a-1"] } }, "local");
    render(
      <Harness
        threads={[]}
        tasks={[
          task("t-run", { inputNeeded: [] }),
          task("t-quiet", { inputNeeded: [] }),
        ]}
        boundHere
        notificationSubscriptions={null}
      />,
    );

    // The positive stands on its own host's word; the absence has no proof.
    expect(rowIds()).toEqual(["t-run", "t-quiet"]);
    expect(row("t-run").getAttribute("data-band")).toBe("working");
    expect(row("t-quiet").getAttribute("data-band")).toBe("unknown");
  });
});

describe("<BotActivityPage /> order", () => {
  it("rule 6: needs you, then working, then unseen, then periodic, whatever order the tasks arrive in", () => {
    working({ "t-working": { working: ["a-1"], turn: ["a-1"] } });
    // A scheduled row is "periodic" only on proof from every source.
    mocks.state.feedMode = "cloud";
    holdCloudFeed([
      remoteUnseenResult("t-unseen", "chat-t-unseen", "host-remote"),
    ]);
    mount(
      [
        periodic("t-every", {}),
        task("t-unseen", {}),
        task("t-working", {}),
        task("t-waiting", {
          inputNeeded: [waiting("a-2", NOW, "Merge the release PR")],
        }),
      ],
      { boundHere: true },
    );

    expect(rowIds()).toEqual(["t-waiting", "t-working", "t-unseen", "t-every"]);
    expect(rows().map((el) => el.getAttribute("data-band"))).toEqual([
      "needs-you",
      "working",
      "unseen",
      "periodic",
    ]);
  });

  it("rule 6: within a band the newest activity is first", () => {
    working({
      "w-old": { working: ["a-1"], turn: ["a-1"] },
      "w-new": { working: ["a-2"], turn: ["a-2"] },
    });
    mount(
      [
        task("n-old", {
          inputNeeded: [waiting("a-3", NOW - 5_000, "Merge it")],
        }),
        task("w-old", { lastCheckinAt: NOW - 9_000 }),
        periodic("p-old", { lastCheckinAt: NOW - 8_000 }),
        task("n-new", {
          inputNeeded: [waiting("a-4", NOW - 1_000, "Merge it")],
        }),
        task("w-new", { lastCheckinAt: NOW - 2_000 }),
        periodic("p-new", { lastCheckinAt: NOW - 3_000 }),
      ],
      { boundHere: true },
    );

    expect(rowIds()).toEqual([
      "n-new",
      "n-old",
      "w-new",
      "w-old",
      "p-new",
      "p-old",
    ]);
  });
});

describe("<BotActivityPage /> the row's status", () => {
  it("rule 3: the glyph is the Chats panel's rollup of the task's agents: an agent waiting on approval outranks one working", () => {
    working({ "t-mixed": { working: ["a-turn"], turn: ["a-turn"] } });
    mount(
      [
        task("t-mixed", {
          inputNeeded: [waiting("a-approve", NOW, "Merge the release PR")],
        }),
      ],
      { boundHere: true },
    );

    expect(glyphKind("t-mixed")).toBe(
      sidebarRollupKind([
        { state: { pendingApproval: true }, tier: undefined },
        { state: {}, tier: "turn" },
      ]),
    );
    expect(glyphKind("t-mixed")).toBe("approval");
  });

  it("rule 3: working agents alone roll up to running, background work alone to background", () => {
    working({
      "t-turn": { working: ["a-1"], turn: ["a-1"] },
      "t-background": { working: ["a-2"], turn: [] },
    });
    mount([task("t-turn", {}), task("t-background", {})], { boundHere: true });

    expect(glyphKind("t-turn")).toBe(
      sidebarRollupKind([{ state: {}, tier: "turn" }]),
    );
    expect(glyphKind("t-turn")).toBe("running");
    expect(glyphKind("t-background")).toBe(
      sidebarRollupKind([{ state: {}, tier: "background" }]),
    );
    expect(glyphKind("t-background")).toBe("background");
    expect(
      within(row("t-turn")).getByTestId("bot-activity-task-line").textContent,
    ).toContain("1 agent working");
  });

  it("rule 3: a periodic task with nothing going on has no glyph", () => {
    mount([periodic("t-every", {})], { boundHere: true });

    expect(glyphKind("t-every")).toBe("none");
  });

  it("rule 3: a cold task whose own indicator holds an unread done rolls up to done, and an unread failure to failure", () => {
    taskUnread("t-done", { unreadDone: true });
    taskUnread("t-failed", { unreadFailure: true });
    mount([task("t-done", {}), task("t-failed", {})], { boundHere: true });

    expect(glyphKind("t-done")).toBe(
      sidebarRollupKind([{ state: { unreadDone: true }, tier: undefined }]),
    );
    expect(glyphKind("t-done")).toBe("done");
    expect(glyphKind("t-failed")).toBe("failure");
  });

  it("rule 3: a warm task whose agents hold no unread done still shows the task's own unread done", () => {
    warmTask("t-warm", [
      { id: "a-idle", parentId: null, title: "Idle agent", archivedAt: null },
    ]);
    taskUnread("t-warm", { unreadDone: true });
    mount([task("t-warm", {})], { boundHere: true });

    expect(glyphKind("t-warm")).toBe("done");
  });

  it("rule 3: a known agent's own unread done does not hide the task's unread failure", () => {
    warmTask("t-warm", [
      {
        id: "a-done",
        parentId: null,
        title: "Finished agent",
        archivedAt: null,
      },
    ]);
    agentUnread("a-done", { unreadDone: true });
    taskUnread("t-warm", { unreadDone: true, unreadFailure: true });
    mount([task("t-warm", {})], { boundHere: true });

    expect(glyphKind("t-warm")).toBe("failure");
  });

  it("rule 3: a task's unread done that a known agent already carries is counted once", () => {
    warmTask("t-warm", [
      {
        id: "a-done",
        parentId: null,
        title: "Finished agent",
        archivedAt: null,
      },
    ]);
    agentUnread("a-done", { unreadDone: true });
    taskUnread("t-warm", { unreadDone: true });
    mount([task("t-warm", {})], { boundHere: true });

    expect(
      within(row("t-warm"))
        .getByTestId("bot-activity-task-glyph")
        .getAttribute("aria-label"),
    ).toBe("1 completed");
  });

  it("rule 3: a cold task's unread done no known agent carries is one more completed", () => {
    working({ "t-cold": { working: ["a-1"], turn: ["a-1"] } });
    taskUnread("t-cold", { unreadDone: true });
    mount([task("t-cold", {})], { boundHere: true });

    expect(
      within(row("t-cold"))
        .getByTestId("bot-activity-task-glyph")
        .getAttribute("aria-label"),
    ).toBe("1 running · 1 completed");
  });
});

describe("<BotActivityPage /> a pending ask is counted once", () => {
  const WARM_ASKER: ReadonlyArray<WarmAgent> = [
    { id: "a-ask", parentId: null, title: "Asker", archivedAt: null },
  ];

  it.each(PENDING_KINDS)(
    "counts an agent's own $flag and the task's same pending as one ask",
    ({ flag, words }) => {
      warmTask("t-warm", WARM_ASKER);
      agentUnread("a-ask", { [flag]: true });
      taskUnread("t-warm", { [flag]: true });
      mount([task("t-warm", {})], { boundHere: true });

      expect(glyphLabel("t-warm")).toBe(words);
    },
  );

  it("counts an approval the bot reports for an agent and the task's pending approval as one", () => {
    warmTask("t-warm", WARM_ASKER);
    taskUnread("t-warm", { pendingApproval: true });
    mount([task("t-warm", { inputNeeded: [waiting("a-ask", NOW, "Merge")] })], {
      boundHere: true,
    });

    expect(glyphLabel("t-warm")).toBe("1 waiting for approval");
  });

  it("counts a question the bot reports for an agent and the task's pending interview as one", () => {
    warmTask("t-warm", WARM_ASKER);
    taskUnread("t-warm", { pendingInterview: true });
    mount([task("t-warm", { inputNeeded: [waitingQuestion("a-ask", NOW)] })], {
      boundHere: true,
    });

    expect(glyphLabel("t-warm")).toBe("1 waiting for interview");
  });

  it("counts one ask for an agent that is both working and reported waiting, beside the task's pending approval", () => {
    warmTask("t-warm", WARM_ASKER);
    working({ "t-warm": { working: ["a-ask"], turn: ["a-ask"] } });
    taskUnread("t-warm", { pendingApproval: true });
    mount([task("t-warm", { inputNeeded: [waiting("a-ask", NOW, "Merge")] })], {
      boundHere: true,
    });

    expect(glyphLabel("t-warm")).toBe("1 waiting for approval");
  });

  it("counts two agents' approvals as two, whatever the task's pending says", () => {
    warmTask("t-warm", [
      ...WARM_ASKER,
      { id: "a-ask-2", parentId: null, title: "Second", archivedAt: null },
    ]);
    agentUnread("a-ask", { pendingApproval: true });
    agentUnread("a-ask-2", { pendingApproval: true });
    taskUnread("t-warm", { pendingApproval: true });
    mount([task("t-warm", {})], { boundHere: true });

    expect(glyphLabel("t-warm")).toBe("2 waiting for approval");
  });

  it("keeps a task's pending approval that no known agent carries as one ask", () => {
    working({ "t-cold": { working: ["a-1"], turn: ["a-1"] } });
    taskUnread("t-cold", { pendingApproval: true });
    mount([task("t-cold", {})], { boundHere: true });

    expect(glyphLabel("t-cold")).toBe("1 waiting for approval · 1 running");
  });

  it("does not let an agent's approval hide the task's pending interview", () => {
    warmTask("t-warm", WARM_ASKER);
    agentUnread("a-ask", { pendingApproval: true });
    taskUnread("t-warm", { pendingInterview: true });
    mount([task("t-warm", {})], { boundHere: true });

    expect(glyphLabel("t-warm")).toBe(
      "1 waiting for interview · 1 waiting for approval",
    );
  });

  it("counts an unread failure a known agent carries and the task's unread failure as one", () => {
    warmTask("t-warm", WARM_ASKER);
    agentUnread("a-ask", { unreadFailure: true });
    taskUnread("t-warm", { unreadFailure: true });
    mount([task("t-warm", {})], { boundHere: true });

    expect(glyphLabel("t-warm")).toBe("1 needs attention");
  });
});

describe("<BotActivityPage /> a task that holds an unread failure and a pending ask counts each once", () => {
  const MIXED = [
    {
      flag: "pendingApproval",
      words: "1 needs attention · 1 waiting for approval",
    },
    {
      flag: "pendingInterview",
      words: "1 needs attention · 1 waiting for interview",
    },
    {
      flag: "pendingFork",
      words: "1 needs attention · 1 waiting for fork resolution",
    },
  ] as const;

  it.each(MIXED)(
    "counts a known agent's unread failure once and the task's $flag as its own ask",
    ({ flag, words }) => {
      warmTask("t-warm", [
        { id: "a-fail", parentId: null, title: "Failed", archivedAt: null },
      ]);
      agentUnread("a-fail", { unreadFailure: true });
      taskUnread("t-warm", { unreadFailure: true, [flag]: true });
      mount([task("t-warm", {})], { boundHere: true });

      expect(glyphLabel("t-warm")).toBe(words);
    },
  );

  it.each(MIXED)(
    "counts a task's unread failure no known agent carries once, beside its $flag",
    ({ flag, words }) => {
      working({ "t-cold": { working: ["a-1"], turn: ["a-1"] } });
      taskUnread("t-cold", { unreadFailure: true, [flag]: true });
      mount([task("t-cold", {})], { boundHere: true });

      expect(glyphLabel("t-cold")).toBe(`${words} · 1 running`);
    },
  );

  it("counts the unread failure once and the approval once for a task with no agent at all", () => {
    taskUnread("t-bare", { unreadFailure: true, pendingApproval: true });
    mount([task("t-bare", {})], { boundHere: true });

    expect(glyphLabel("t-bare")).toBe(
      "1 needs attention · 1 waiting for approval",
    );
  });
});

describe("<BotActivityPage /> an app-local failure is a local fact, whatever the host's remote answer", () => {
  it.each(UNVOUCHED)(
    "keeps a task that holds one listed, as unseen, with its glyph, while the $name",
    ({ apply }) => {
      mocks.state.feedMode = "cloud";
      apply();
      localFailure("t-cold", "a-x", "host-a");
      mount([task("t-cold", {})], { boundHere: true });

      expect(rowIds()).toEqual(["t-cold"]);
      expect(row("t-cold").getAttribute("data-band")).toBe("unseen");
      expect(glyphLabel("t-cold")).toBe("1 needs attention");
    },
  );

  it.each(UNVOUCHED)(
    "keeps an agent's own listed with its failure kind while the $name",
    async ({ apply }) => {
      mocks.state.feedMode = "cloud";
      apply();
      warmTask("t-warm", [
        { id: "a-fail", parentId: null, title: "Failed", archivedAt: null },
        { id: "a-quiet", parentId: null, title: "Quiet", archivedAt: null },
      ]);
      localFailure("t-warm", "a-fail", "host-a");
      mount([task("t-warm", {})], { boundHere: true });
      await userEvent
        .setup()
        .click(within(row("t-warm")).getByTestId("bot-activity-task-chevron"));

      expect(agentKinds("t-warm")).toContainEqual(["a-fail", "failure"]);
      expect(glyphLabel("t-warm")).toBe("1 needs attention");
    },
  );

  it.each(UNVOUCHED)(
    "shows the local failure but none of the host's own unproven flags while the $name",
    ({ apply }) => {
      mocks.state.feedMode = "cloud";
      apply();
      warmTask("t-warm", [
        { id: "a-local", parentId: null, title: "Local", archivedAt: null },
        { id: "a-remote", parentId: null, title: "Remote", archivedAt: null },
      ]);
      localFailure("t-warm", "a-local", "host-a");
      mocks.state.chatFlags = { "a-remote": { pendingApproval: true } };
      mocks.state.epicFlags = { "t-warm": { pendingApproval: true } };
      mount([task("t-warm", {})], { boundHere: true });

      expect(glyphLabel("t-warm")).toBe("1 needs attention");
    },
  );

  it("counts the local failure and the host's vouched approval together once the host answers (control)", () => {
    mocks.state.feedMode = "cloud";
    warmTask("t-warm", [
      { id: "a-local", parentId: null, title: "Local", archivedAt: null },
      { id: "a-remote", parentId: null, title: "Remote", archivedAt: null },
    ]);
    localFailure("t-warm", "a-local", "host-a");
    mocks.state.chatFlags = { "a-remote": { pendingApproval: true } };
    mocks.state.epicFlags = { "t-warm": { pendingApproval: true } };
    mount([task("t-warm", {})], { boundHere: true });

    expect(glyphLabel("t-warm")).toBe(
      "1 needs attention · 1 waiting for approval",
    );
  });
});

describe("<BotActivityPage /> a row whose task band is unknown", () => {
  it("still names what a vouching agent host holds in its glyph, while the task's own read is unreachable", () => {
    mocks.state.feedMode = "cloud";
    mocks.state.unreachable.add("host-notifications");
    warmTask("t-warm", [
      { id: "a-ask", parentId: null, title: "Asker", archivedAt: null },
    ]);
    mocks.state.chatFlags = { "a-ask": { pendingApproval: true } };
    mount([task("t-warm", {})], { boundHere: true });

    expect(row("t-warm").getAttribute("data-band")).toBe("unknown");
    expect(glyphLabel("t-warm")).toBe("1 waiting for approval");
    expect(
      within(row("t-warm")).getByTestId("bot-activity-task-line").textContent,
    ).toContain("waiting on you");
  });

  it("says a fork waits on the person in its second line, though the band is unknown", () => {
    mocks.state.feedMode = "cloud";
    mocks.state.unreachable.add("host-notifications");
    warmTask("t-warm", [
      { id: "a-fork", parentId: null, title: "Forker", archivedAt: null },
    ]);
    mocks.state.chatFlags = { "a-fork": { pendingFork: true } };
    mount([task("t-warm", {})], { boundHere: true });

    expect(row("t-warm").getAttribute("data-band")).toBe("unknown");
    expect(
      within(row("t-warm")).getByTestId("bot-activity-task-line").textContent,
    ).toContain("waiting on you: a fork to resolve");
  });
});

describe("<BotActivityPage /> an expanded agent whose host cannot vouch", () => {
  const AGENTS: ReadonlyArray<WarmAgent> = [
    { id: "a-quiet", parentId: null, title: "Quiet", archivedAt: null },
    { id: "a-ask", parentId: null, title: "Asker", archivedAt: null },
  ];

  async function expandedKinds(): Promise<
    ReadonlyArray<[string | null, string | null]>
  > {
    await userEvent
      .setup()
      .click(within(row("t-warm")).getByTestId("bot-activity-task-chevron"));
    return agentKinds("t-warm");
  }

  it.each(UNVOUCHED)(
    "reads unknown, not idle, for an agent with nothing known while the $name",
    async ({ apply }) => {
      mocks.state.feedMode = "cloud";
      apply();
      warmTask("t-warm", AGENTS);
      mount([task("t-warm", {})], { boundHere: true });

      expect(await expandedKinds()).toEqual([
        ["a-quiet", "unknown"],
        ["a-ask", "unknown"],
      ]);
    },
  );

  it("reads idle for the quiet agent and the host's own flag for the other once the host vouches (control)", async () => {
    mocks.state.feedMode = "cloud";
    warmTask("t-warm", AGENTS);
    mocks.state.chatFlags = { "a-ask": { pendingApproval: true } };
    mount([task("t-warm", { inputNeeded: [] })], { boundHere: true });

    expect(await expandedKinds()).toEqual([
      ["a-quiet", "idle"],
      ["a-ask", "approval"],
    ]);
  });
});

describe("<BotActivityPage /> distinct pending kinds the task holds are each counted", () => {
  const ASKER: ReadonlyArray<WarmAgent> = [
    { id: "a-ask", parentId: null, title: "Asker", archivedAt: null },
  ];

  it.each([
    {
      name: "interview and approval",
      flags: ["pendingInterview", "pendingApproval"],
      words: `${INTERVIEW_WORDS} · ${APPROVAL_WORDS}`,
    },
    {
      name: "fork and interview",
      flags: ["pendingFork", "pendingInterview"],
      words: `${FORK_WORDS} · ${INTERVIEW_WORDS}`,
    },
    {
      name: "fork and approval",
      flags: ["pendingFork", "pendingApproval"],
      words: `${FORK_WORDS} · ${APPROVAL_WORDS}`,
    },
    {
      name: "fork, interview and approval",
      flags: ["pendingFork", "pendingInterview", "pendingApproval"],
      words: `${FORK_WORDS} · ${INTERVIEW_WORDS} · ${APPROVAL_WORDS}`,
    },
  ] as const)(
    "no known agent carries $name: one of each",
    ({ flags, words }) => {
      warmTask("t-warm", ASKER);
      taskUnread(
        "t-warm",
        Object.fromEntries(flags.map((flag) => [flag, true])),
      );
      mount([task("t-warm", {})], { boundHere: true });

      expect(glyphLabel("t-warm")).toBe(words);
    },
  );

  it.each([
    {
      name: "approval",
      own: "pendingApproval",
      flags: ["pendingInterview", "pendingApproval"],
      words: `${INTERVIEW_WORDS} · ${APPROVAL_WORDS}`,
    },
    {
      name: "interview",
      own: "pendingInterview",
      flags: ["pendingInterview", "pendingApproval"],
      words: `${INTERVIEW_WORDS} · ${APPROVAL_WORDS}`,
    },
    {
      name: "approval",
      own: "pendingApproval",
      flags: ["pendingFork", "pendingInterview", "pendingApproval"],
      words: `${FORK_WORDS} · ${INTERVIEW_WORDS} · ${APPROVAL_WORDS}`,
    },
    {
      name: "interview",
      own: "pendingInterview",
      flags: ["pendingFork", "pendingInterview", "pendingApproval"],
      words: `${FORK_WORDS} · ${INTERVIEW_WORDS} · ${APPROVAL_WORDS}`,
    },
    {
      name: "fork",
      own: "pendingFork",
      flags: ["pendingFork", "pendingInterview", "pendingApproval"],
      words: `${FORK_WORDS} · ${INTERVIEW_WORDS} · ${APPROVAL_WORDS}`,
    },
  ] as const)(
    "a known agent carries its own $name beside the task's pending kinds: still one of each",
    ({ own, flags, words }) => {
      warmTask("t-warm", ASKER);
      agentUnread("a-ask", { [own]: true });
      taskUnread(
        "t-warm",
        Object.fromEntries(flags.map((flag) => [flag, true])),
      );
      mount([task("t-warm", {})], { boundHere: true });

      expect(glyphLabel("t-warm")).toBe(words);
    },
  );
});

describe("<BotActivityPage /> a fresh cloud unread stands without the host's partition answering", () => {
  const QUIET_UNSEEN = (): BotTaskEntry => task("t-x", { inputNeeded: [] });

  it.each(UNVOUCHED)(
    "lists the task as unseen, with its completed glyph, while the $name",
    ({ apply }) => {
      mocks.state.feedMode = "cloud";
      holdCloudFeed([remoteUnseenResult("t-x", "chat-t-x", "host-remote")]);
      apply();
      mount([QUIET_UNSEEN()], { boundHere: true });

      expect(rowIds()).toEqual(["t-x"]);
      expect(band("t-x")).toBe("unseen");
      expect(glyphLabel("t-x")).toBe("1 completed");
    },
  );

  it("lists it as unseen when the partition answers too (control)", () => {
    mocks.state.feedMode = "cloud";
    holdCloudFeed([remoteUnseenResult("t-x", "chat-t-x", "host-remote")]);
    mount([QUIET_UNSEEN()], { boundHere: true });

    expect(band("t-x")).toBe("unseen");
  });

  it("keeps it unknown when the cloud feed is disconnected and the partition is pending: no source holds the unread", () => {
    mocks.state.feedMode = "cloud";
    mocks.state.indicatorRead = "pending";
    mountInCloudMode([QUIET_UNSEEN()], { connected: false });

    expect(band("t-x")).toBe("unknown");
  });

  it("keeps a task with no cloud row unknown while the partition is pending: absence is not proved", () => {
    mocks.state.feedMode = "cloud";
    holdCloudFeed([]);
    mocks.state.indicatorRead = "pending";
    mount([QUIET_UNSEEN()], { boundHere: true });

    expect(band("t-x")).toBe("unknown");
  });
});

describe("<BotActivityPage /> an agent's fresh cloud unread stands without its host's partition answering", () => {
  const AGENTS: ReadonlyArray<WarmAgent> = [
    { id: "a-done", parentId: null, title: "Finished", archivedAt: null },
    { id: "a-quiet", parentId: null, title: "Quiet", archivedAt: null },
  ];

  it.each(UNVOUCHED)("reads it done while the $name", async ({ apply }) => {
    mocks.state.feedMode = "cloud";
    // An agent's chat reports from the host that owns it.
    holdCloudFeed([remoteUnseenResult("t-warm", "a-done", "host-a")]);
    apply();
    warmTask("t-warm", AGENTS);
    mount([task("t-warm", { inputNeeded: [] })], { boundHere: true });
    await expandRow("t-warm");

    expect(agentKinds("t-warm")).toContainEqual(["a-done", "done"]);
  });

  it("reads it unknown when the cloud feed is disconnected and the partition is pending: no source holds it", async () => {
    mocks.state.feedMode = "cloud";
    mocks.state.indicatorRead = "pending";
    warmTask("t-warm", AGENTS);
    mountInCloudMode([task("t-warm", { inputNeeded: [] })], {
      connected: false,
    });
    await expandRow("t-warm");

    expect(agentKinds("t-warm")).toContainEqual(["a-done", "unknown"]);
  });
});

describe("<BotActivityPage /> a host-local approval stands while the cloud feed is disconnected", () => {
  const AGENTS: ReadonlyArray<WarmAgent> = [
    { id: "a-live", parentId: null, title: "Lead", archivedAt: null },
    { id: "a-old", parentId: null, title: "Old", archivedAt: 5 },
  ];

  it("puts the task in needs-you from its own host's pending approval (control)", () => {
    mocks.state.feedMode = "cloud";
    mocks.state.epicFlags = { "t-x": { pendingApproval: true } };
    mountInCloudMode([task("t-x", {})], { connected: false });

    expect(band("t-x")).toBe("needs-you");
  });

  it("reveals an archived agent holding a host-local approval, and counts it once, with the cloud feed disconnected", async () => {
    mocks.state.feedMode = "cloud";
    warmTask("t-warm", AGENTS);
    mocks.state.chatFlags = { "a-old": { pendingApproval: true } };
    mocks.state.epicFlags = { "t-warm": { pendingApproval: true } };
    mountInCloudMode([task("t-warm", {})], { connected: false });
    await expandRow("t-warm");

    expect(agentKinds("t-warm")).toContainEqual(["a-old", "approval"]);
    expect(glyphLabel("t-warm")).toBe("1 waiting for approval");
  });

  it("reads a quiet agent unknown with the cloud feed disconnected", async () => {
    mocks.state.feedMode = "cloud";
    warmTask("t-warm", AGENTS);
    mountInCloudMode([task("t-warm", {})], { connected: false });
    await expandRow("t-warm");
    expect(agentKinds("t-warm")).toEqual([["a-live", "unknown"]]);
  });

  it("reads a quiet agent idle with every source vouching (control)", async () => {
    mocks.state.feedMode = "cloud";
    warmTask("t-warm", AGENTS);
    mount([task("t-warm", { inputNeeded: [] })], { boundHere: true });
    await expandRow("t-warm");

    expect(agentKinds("t-warm")).toEqual([["a-live", "idle"]]);
  });
});

describe("<BotActivityPage /> an expanded agent whose activity stream is held", () => {
  const AGENTS: ReadonlyArray<WarmAgent> = [
    { id: "a-quiet", parentId: null, title: "Quiet", archivedAt: null },
    { id: "a-ask", parentId: null, title: "Asker", archivedAt: null },
  ];

  it("reads unknown, not idle, though the host's indicators answer freshly empty", async () => {
    __resetAgentActivityStoreForTests();
    mocks.state.feedMode = "cloud";
    planeHeld("host-a", {});
    warmTask("t-warm", AGENTS);
    mount([task("t-warm", { inputNeeded: [] })], { boundHere: true });
    await expandRow("t-warm");

    expect(agentKinds("t-warm")).toEqual([
      ["a-quiet", "unknown"],
      ["a-ask", "unknown"],
    ]);
  });

  it("still shows a fresh host fact on its own while the stream is held, and the quiet one unknown", async () => {
    __resetAgentActivityStoreForTests();
    mocks.state.feedMode = "cloud";
    planeHeld("host-a", {});
    warmTask("t-warm", AGENTS);
    mocks.state.chatFlags = { "a-ask": { pendingApproval: true } };
    mount([task("t-warm", { inputNeeded: [] })], { boundHere: true });
    await expandRow("t-warm");

    expect(agentKinds("t-warm")).toEqual([
      ["a-quiet", "unknown"],
      ["a-ask", "approval"],
    ]);
  });

  it("does not read running from a held slice's count", async () => {
    __resetAgentActivityStoreForTests();
    mocks.state.feedMode = "cloud";
    planeHeld("host-a", {
      "t-warm": { working: ["a-quiet"], turn: ["a-quiet"] },
    });
    warmTask("t-warm", AGENTS);
    mount([task("t-warm", { inputNeeded: [] })], { boundHere: true });
    await expandRow("t-warm");

    expect(agentKinds("t-warm")[0]).toEqual(["a-quiet", "unknown"]);
  });

  it("reads unknown for an agent whose host the answering stream does not cover", async () => {
    __resetAgentActivityStoreForTests();
    mocks.state.feedMode = "cloud";
    planeAnswers("host-elsewhere", {});
    warmTask("t-warm", AGENTS);
    mount([task("t-warm", { inputNeeded: [] })], { boundHere: true });
    await expandRow("t-warm");

    expect(agentKinds("t-warm")[0]).toEqual(["a-quiet", "unknown"]);
  });

  it.each([
    { inputNeeded: null, kind: "unknown" },
    { inputNeeded: [], kind: "idle" },
  ] as const)(
    "reads a quiet agent $kind when the task's waiting list is $inputNeeded, every other source vouching",
    async ({ inputNeeded, kind }) => {
      mocks.state.feedMode = "cloud";
      warmTask("t-warm", [
        { id: "a-live", parentId: null, title: "Lead", archivedAt: null },
      ]);
      mount(
        [
          task("t-warm", {
            inputNeeded: inputNeeded === null ? null : [...inputNeeded],
          }),
        ],
        { boundHere: true },
      );
      await expandRow("t-warm");

      expect(agentKinds("t-warm")).toEqual([["a-live", kind]]);
    },
  );

  it("reads idle when the agent's own host's stream is open with its state landed (control)", async () => {
    __resetAgentActivityStoreForTests();
    mocks.state.feedMode = "cloud";
    planeAnswers("host-a", {});
    warmTask("t-warm", AGENTS);
    mount([task("t-warm", { inputNeeded: [] })], { boundHere: true });
    await expandRow("t-warm");

    expect(agentKinds("t-warm")[0]).toEqual(["a-quiet", "idle"]);
  });
});

describe("<BotActivityPage /> an archived quiet agent with no attested positive stays folded away, whatever source is unknown", () => {
  const AGENTS: ReadonlyArray<WarmAgent> = [
    { id: "a-live", parentId: null, title: "Lead", archivedAt: null },
    { id: "a-old", parentId: null, title: "Old", archivedAt: 5 },
  ];
  const listed = (): ReadonlyArray<string | null> =>
    agentKinds("t-warm").map(([id]) => id);

  it.each(UNVOUCHED)("stays folded away while the $name", async ({ apply }) => {
    mocks.state.feedMode = "cloud";
    apply();
    warmTask("t-warm", AGENTS);
    mount([task("t-warm", {})], { boundHere: true });
    await expandRow("t-warm");

    expect(listed()).toEqual(["a-live"]);
  });

  it("stays folded away while the cloud feed is disconnected", async () => {
    mocks.state.feedMode = "cloud";
    warmTask("t-warm", AGENTS);
    mountInCloudMode([task("t-warm", {})], { connected: false });
    await expandRow("t-warm");

    expect(listed()).toEqual(["a-live"]);
  });

  it("stays folded away while its host's activity stream is held", async () => {
    __resetAgentActivityStoreForTests();
    mocks.state.feedMode = "cloud";
    planeHeld("host-a", {});
    warmTask("t-warm", AGENTS);
    mount([task("t-warm", {})], { boundHere: true });
    await expandRow("t-warm");

    expect(listed()).toEqual(["a-live"]);
  });

  it("stays folded away once every source vouches it quiet (control)", async () => {
    mocks.state.feedMode = "cloud";
    warmTask("t-warm", AGENTS);
    mount([task("t-warm", {})], { boundHere: true });
    await expandRow("t-warm");

    expect(listed()).toEqual(["a-live"]);
  });
});

describe("<BotActivityPage /> an archived agent the bot reports waiting stays listed whatever the read says", () => {
  const AGENTS: ReadonlyArray<WarmAgent> = [
    { id: "a-live", parentId: null, title: "Lead", archivedAt: null },
    { id: "a-old", parentId: null, title: "Old", archivedAt: 5 },
  ];

  async function openAgents(): Promise<
    ReadonlyArray<[string | null, string | null]>
  > {
    const user = userEvent.setup();
    await user.click(
      within(row("t-warm")).getByTestId("bot-activity-task-chevron"),
    );
    return screen
      .getAllByTestId("bot-activity-agent")
      .map((el) => [
        el.getAttribute("data-agent-id"),
        el.getAttribute("data-kind"),
      ]);
  }

  it.each(["pending", "error", "unanswered"] as const)(
    "lists it as waiting for approval while the host's indicator read is %s",
    async (read) => {
      mocks.state.feedMode = "cloud";
      mocks.state.indicatorRead = read;
      warmTask("t-warm", AGENTS);
      mount(
        [task("t-warm", { inputNeeded: [waiting("a-old", NOW, "Merge")] })],
        { boundHere: true },
      );

      expect(await openAgents()).toContainEqual(["a-old", "approval"]);
    },
  );

  it.each(["pending", "error", "unanswered"] as const)(
    "lists it as waiting for an interview while the host's indicator read is %s",
    async (read) => {
      mocks.state.feedMode = "cloud";
      mocks.state.indicatorRead = read;
      warmTask("t-warm", AGENTS);
      mount(
        [task("t-warm", { inputNeeded: [waitingQuestion("a-old", NOW)] })],
        { boundHere: true },
      );

      expect(await openAgents()).toContainEqual(["a-old", "interview"]);
    },
  );

  it("lists it once the read has answered, too", async () => {
    mocks.state.feedMode = "cloud";
    warmTask("t-warm", AGENTS);
    mount([task("t-warm", { inputNeeded: [waiting("a-old", NOW, "Merge")] })], {
      boundHere: true,
    });

    expect(await openAgents()).toContainEqual(["a-old", "approval"]);
  });

  it.each(["pending", "error"] as const)(
    "keeps an archived agent nothing waits on folded away while the read is %s",
    async (read) => {
      mocks.state.feedMode = "cloud";
      mocks.state.indicatorRead = read;
      warmTask("t-warm", AGENTS);
      mount(
        [task("t-warm", { inputNeeded: [waiting("a-live", NOW, "Merge")] })],
        { boundHere: true },
      );

      expect((await openAgents()).map(([id]) => id)).toEqual(["a-live"]);
    },
  );

  it("agrees with the row's glyph, which already counts that agent once", () => {
    mocks.state.feedMode = "cloud";
    mocks.state.indicatorRead = "pending";
    warmTask("t-warm", AGENTS);
    mount([task("t-warm", { inputNeeded: [waiting("a-old", NOW, "Merge")] })], {
      boundHere: true,
    });

    expect(glyphLabel("t-warm")).toBe("1 waiting for approval");
  });
});

describe("<BotActivityPage /> agents on several hosts", () => {
  it.each(["local", "cloud"] as const)(
    "rule 3: an agent on another host than its task's session is read from the host that owns it (%s feed)",
    async (feedMode) => {
      mocks.state.feedMode = feedMode;
      const user = userEvent.setup();
      warmTask("t-split", [
        { id: "a-lead", parentId: null, title: "Lead", archivedAt: null },
        {
          id: "a-remote",
          parentId: "a-lead",
          title: "Remote reviewer",
          archivedAt: null,
        },
      ]);
      const handle = getOpenEpicRegistry().peek("t-split");
      if (handle === null) throw new Error("t-split is not warm");
      act(() => {
        handle.store.setState((state) => ({
          chats: {
            ...state.chats,
            byId: {
              ...state.chats.byId,
              "a-remote": { ...state.chats.byId["a-remote"], hostId: "host-b" },
            },
          },
        }));
      });
      // The lead's host knows nothing of the reviewer; only the reviewer's own
      // host holds its fork.
      mocks.state.chatFlagsByHost = {
        "host-b": { "a-remote": { pendingFork: true } },
      };
      mount([periodic("t-split", {})], { boundHere: true });

      expect(
        within(row("t-split"))
          .getByTestId("bot-activity-task-glyph")
          .getAttribute("aria-label"),
      ).toBe("1 waiting for fork resolution");
      await user.click(
        within(row("t-split")).getByTestId("bot-activity-task-chevron"),
      );
      const remote = within(row("t-split"))
        .getAllByTestId("bot-activity-agent")
        .find((agent) => agent.getAttribute("data-agent-id") === "a-remote");
      expect(remote?.getAttribute("data-kind")).toBe("fork");
      expect([
        ...new Set(
          mocks.asked
            .filter((read) => read.chatId === "a-remote")
            .map((read) => read.hostId),
        ),
      ]).toEqual(["host-b"]);
    },
  );
});

describe("<BotActivityPage /> an agent's host that cannot vouch", () => {
  it.each(["local", "cloud"] as const)(
    "never shows a fork an agent's own host reported before that host became unreachable, while the lead's host still answers (%s feed)",
    (feedMode) => {
      mocks.state.feedMode = feedMode;
      warmTask("t-split", [
        { id: "a-lead", parentId: null, title: "Lead", archivedAt: null },
        {
          id: "a-remote",
          parentId: "a-lead",
          title: "Remote reviewer",
          archivedAt: null,
        },
      ]);
      const handle = getOpenEpicRegistry().peek("t-split");
      if (handle === null) throw new Error("t-split is not warm");
      act(() => {
        handle.store.setState((state) => ({
          chats: {
            ...state.chats,
            byId: {
              ...state.chats.byId,
              "a-remote": { ...state.chats.byId["a-remote"], hostId: "host-b" },
            },
          },
        }));
      });
      mocks.state.chatFlagsByHost = {
        "host-b": { "a-remote": { pendingFork: true } },
      };
      const view = render(
        <Harness
          threads={[]}
          tasks={[periodic("t-split", {})]}
          boundHere
          notificationSubscriptions={null}
        />,
      );
      // Current while host-b answers and is reachable.
      expect(
        within(row("t-split"))
          .getByTestId("bot-activity-task-glyph")
          .getAttribute("aria-label"),
      ).toBe("1 waiting for fork resolution");

      mocks.state.unreachable.add("host-b");
      view.rerender(
        <Harness
          threads={[]}
          tasks={[periodic("t-split", {})]}
          boundHere
          notificationSubscriptions={null}
        />,
      );

      expect(
        within(row("t-split"))
          .queryByTestId("bot-activity-task-glyph")
          ?.getAttribute("aria-label") ?? null,
      ).not.toBe("1 waiting for fork resolution");
    },
  );
});
