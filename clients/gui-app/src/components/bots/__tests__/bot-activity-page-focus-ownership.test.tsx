/**
 * A bot's Activity page, where keyboard focus goes when the node that holds it
 * leaves: a row removed through the activity store, the cloud feed, evidence
 * going stale, a task's session closing, a pane losing focus, or the hosts of
 * a task's agents changing. Same real page, stores and boundaries as
 * `bot-activity-page.test.tsx`.
 */
import { useEffect, useState, type ReactNode } from "react";
import { act, render, screen, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BotTaskEntry } from "@traycer/protocol/host/bot/schemas";
import {
  chatProjection,
  coolAllEpics,
} from "@/components/layout/tabs/side-strip/__tests__/warm-epic-fixture";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
import { SurfacePresentationBoundary } from "@/components/layout/surface-presentation-boundary";
import { useAppLocalNotificationsStore } from "@/stores/notifications/app-local-notifications-store";
import { useCloudNotificationsStore } from "@/stores/notifications/cloud-notifications-store";
import { recordNegotiatedHostMethods } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { mocks } from "@/components/bots/__tests__/bot-activity-page-mocks";
import {
  HOST_ID,
  Harness,
  NOW,
  REPORT_METHODS,
  type WarmAgent,
  band,
  focusMenuItem,
  holdCloudFeed,
  installPageCaseLifecycle,
  localFailure,
  narrowActivity,
  periodic,
  remoteUnseenResult,
  row,
  rowIds,
  task,
  warmTask,
  working,
} from "@/components/bots/__tests__/bot-activity-page-support";

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

// The real boundary: it publishes the pane's activity and conceals only its
// own portal host, not the page. Focusing something here would make the pane
// the focused one again (its focus capture), so a pane that is no longer
// focused must not be handed focus back.
const scene = {
  setFocused: (_focused: boolean): void => undefined,
  activations: 0,
};

function Pane(props: { readonly children: ReactNode }): ReactNode {
  const [focused, setFocused] = useState(true);
  useEffect(() => {
    scene.setFocused = setFocused;
  }, []);
  return (
    <div
      onFocusCapture={() => {
        if (!focused) scene.activations += 1;
      }}
    >
      <SurfacePresentationBoundary visible focused={focused}>
        {props.children}
      </SurfacePresentationBoundary>
    </div>
  );
}

/** An agent of `taskId` that runs on `hostId`, added to its open session's stores. */
function addAgentOn(taskId: string, agentId: string, hostId: string): void {
  const handle = getOpenEpicRegistry().peek(taskId);
  if (handle === null) throw new Error(`${taskId} is not warm`);
  act(() => {
    handle.store.setState((state) => ({
      chats: {
        allIds: [...state.chats.allIds, agentId],
        byId: {
          ...state.chats.byId,
          [agentId]: chatProjection(agentId, {
            title: agentId,
            hostId,
            updatedAt: 1,
          }),
        },
      },
      tree: {
        rootIds: [...state.tree.rootIds, agentId],
        childrenByParent: { ...state.tree.childrenByParent, [agentId]: [] },
        nodeById: {
          ...state.tree.nodeById,
          [agentId]: {
            id: agentId,
            parentId: null,
            title: agentId,
            type: "chat",
            status: null,
            createdAt: 0,
            updatedAt: 1,
          },
        },
      },
    }));
  });
}

describe("<BotActivityPage /> a row that leaves through the activity store alone", () => {
  // The rows are computed by the page's parent from the tasks and the activity
  // plane, so the parent renders itself again when only the store changes; the
  // case drives nothing but the store.
  // A tracking task that neither checks in on a schedule nor waits for its
  // completion stays listed only while something in it is going on, so the
  // activity plane alone takes it off the list, once both sources are proved.
  const mountListed = (): void => {
    mocks.state.feedMode = "cloud";
    holdCloudFeed([]);
    working({ "t-working": { working: ["a-1"], turn: ["a-1"] } });
    render(
      <Harness
        threads={[]}
        tasks={[
          task("t-working", {
            cadence: { kind: "none" },
            inputNeeded: [],
            lastCheckinAt: NOW,
          }),
        ]}
        boundHere
        notificationSubscriptions={null}
      />,
    );
    expect(rowIds()).toEqual(["t-working"]);
  };

  it("hands focus from the row's open button to the Activity section", () => {
    mountListed();
    within(row("t-working")).getByTestId("bot-activity-task-open").focus();

    act(() => working({}));

    expect(rowIds()).toEqual([]);
    expect(document.activeElement).toBe(
      screen.getByTestId("bot-activity-page"),
    );
  });

  it("leaves focus on the body after a direct blur from the row's open button", () => {
    mountListed();
    const open = within(row("t-working")).getByTestId("bot-activity-task-open");
    open.focus();
    open.blur();
    expect(document.activeElement).toBe(document.body);

    act(() => working({}));

    expect(rowIds()).toEqual([]);
    expect(document.activeElement).toBe(document.body);
  });
});

describe("<BotActivityPage /> an archived agent that stops working under a task row", () => {
  // An archived agent is listed under its task only while it works. Moving the
  // one working agent from it to a live sibling leaves the task's working count
  // at one, so the row's parent is not rendered again: only the row's own
  // subscription to the activity store changes which agents are shown. Neither
  // task here has a reporting control to take focus back, and nothing but the
  // activity store changes.
  const AGENTS: ReadonlyArray<WarmAgent> = [
    { id: "a-archived", parentId: null, title: "Archived", archivedAt: 5 },
    { id: "a-live", parentId: null, title: "Live", archivedAt: null },
  ];
  const agentControl = (agentId: string): HTMLButtonElement | null =>
    row("t-w").querySelector<HTMLButtonElement>(`[data-agent-id="${agentId}"]`);
  const mountExpanded = async (user: UserEvent): Promise<HTMLButtonElement> => {
    working({ "t-w": { working: ["a-archived"], turn: ["a-archived"] } });
    warmTask("t-w", AGENTS);
    render(
      <Harness
        threads={[]}
        tasks={[task("t-w", { inputNeeded: [] })]}
        boundHere={false}
        notificationSubscriptions={null}
      />,
    );
    await user.click(
      within(row("t-w")).getByTestId("bot-activity-task-chevron"),
    );
    const archived = agentControl("a-archived");
    if (archived === null)
      throw new Error("the working archived agent is not listed");
    expect(agentControl("a-live")).not.toBeNull();
    return archived;
  };
  const moveWorkToLive = (): void => {
    act(() => working({ "t-w": { working: ["a-live"], turn: ["a-live"] } }));
  };

  it("hands focus from the archived agent that is no longer listed to the row open button", async () => {
    const user = userEvent.setup();
    const archived = await mountExpanded(user);
    archived.focus();
    expect(document.activeElement).toBe(archived);

    moveWorkToLive();

    expect(agentControl("a-archived")).toBeNull();
    expect(agentControl("a-live")).not.toBeNull();
    expect(archived.isConnected).toBe(false);
    expect(document.activeElement).toBe(
      within(row("t-w")).getByTestId("bot-activity-task-open"),
    );
  });

  it("leaves focus on the body after a direct blur from the archived agent that is then no longer listed", async () => {
    const user = userEvent.setup();
    const archived = await mountExpanded(user);
    archived.focus();
    archived.blur();
    expect(document.activeElement).toBe(document.body);

    moveWorkToLive();

    expect(agentControl("a-archived")).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });
});

describe("<BotActivityPage /> an agent list that goes away under a focused agent through the task's session", () => {
  it("hands focus from a focused agent to the row open button when the task's session closes", async () => {
    const user = userEvent.setup();
    warmTask("t-w", [
      { id: "a-one", parentId: null, title: "First", archivedAt: null },
    ]);
    render(
      <Harness
        threads={[]}
        tasks={[task("t-w", { inputNeeded: [] })]}
        boundHere={false}
        notificationSubscriptions={null}
      />,
    );
    await user.click(
      within(row("t-w")).getByTestId("bot-activity-task-chevron"),
    );
    const agent = row("t-w").querySelector<HTMLButtonElement>(
      '[data-agent-id="a-one"]',
    );
    if (agent === null) throw new Error("the agent is not listed");
    agent.focus();

    act(() => coolAllEpics());

    expect(row("t-w").querySelector('[data-agent-id="a-one"]')).toBeNull();
    expect(document.activeElement).toBe(
      within(row("t-w")).getByTestId("bot-activity-task-open"),
    );
  });
});

describe("<BotActivityPage /> what the cloud notification feed takes off a task row alone", () => {
  it("hands focus from the row open button of a task whose unseen result is read to the Activity section", () => {
    mocks.state.feedMode = "cloud";
    holdCloudFeed([remoteUnseenResult("t-u", "chat-t-u", "host-remote")]);
    render(
      <Harness
        threads={[]}
        tasks={[
          task("t-u", {
            cadence: { kind: "none" },
            inputNeeded: [],
            lastCheckinAt: NOW,
          }),
        ]}
        boundHere
        notificationSubscriptions={null}
      />,
    );
    expect(rowIds()).toEqual(["t-u"]);
    within(row("t-u")).getByTestId("bot-activity-task-open").focus();

    act(() => holdCloudFeed([]));

    expect(rowIds()).toEqual([]);
    expect(document.activeElement).toBe(
      screen.getByTestId("bot-activity-page"),
    );
  });

  it.each([
    [
      "hands focus from an archived agent whose local failure is cleared, in a task that stays listed, to the row open button",
      false,
    ],
    [
      "leaves focus on the body after a direct blur from an archived agent whose local failure is then cleared",
      true,
    ],
  ] as const)("%s", async (_name, blurred) => {
    const user = userEvent.setup();
    mocks.state.feedMode = "cloud";
    working({ "t-u": { working: ["a-live"], turn: ["a-live"] } });
    warmTask("t-u", [
      { id: "a-archived", parentId: null, title: "Archived", archivedAt: 5 },
      { id: "a-live", parentId: null, title: "Live", archivedAt: null },
    ]);
    localFailure("t-u", "a-archived", "host-a");
    render(
      <Harness
        threads={[]}
        tasks={[task("t-u", { inputNeeded: [] })]}
        boundHere={false}
        notificationSubscriptions={null}
      />,
    );
    await user.click(
      within(row("t-u")).getByTestId("bot-activity-task-chevron"),
    );
    const archived = row("t-u").querySelector<HTMLButtonElement>(
      '[data-agent-id="a-archived"]',
    );
    if (archived === null)
      throw new Error("the archived agent with a failure is not listed");
    archived.focus();
    if (blurred) archived.blur();

    act(() => useAppLocalNotificationsStore.getState().clearAll());

    expect(row("t-u").querySelector('[data-agent-id="a-archived"]')).toBeNull();
    expect(document.activeElement).toBe(
      blurred
        ? document.body
        : within(row("t-u")).getByTestId("bot-activity-task-open"),
    );
  });
});

describe("<BotActivityPage /> what evidence becoming fresh or going stale does to a focused node", () => {
  // A tracking task with no schedule and no completion to wait for is listed as
  // status unknown only while its evidence is not fresh; once every source
  // vouches for it, it has nothing going on and leaves.
  const quietUnscheduled = (): BotTaskEntry =>
    task("t-quiet", {
      cadence: { kind: "none" },
      inputNeeded: [],
      lastCheckinAt: NOW,
    });
  const listUnknown = (): HTMLElement => {
    render(
      <Harness
        threads={[]}
        tasks={[quietUnscheduled()]}
        boundHere
        notificationSubscriptions={null}
      />,
    );
    expect(rowIds()).toEqual(["t-quiet"]);
    expect(band("t-quiet")).toBe("unknown");
    const open = within(row("t-quiet")).getByTestId("bot-activity-task-open");
    open.focus();
    return open;
  };
  const sources: ReadonlyArray<{
    readonly name: string;
    readonly start: () => void;
    readonly vouch: () => void;
  }> = [
    {
      name: "the cloud notification feed connects with its snapshot",
      start: () => {
        mocks.state.feedMode = "cloud";
        working({});
        useCloudNotificationsStore.setState({
          hasSnapshot: false,
          connectionState: "unavailable",
        });
      },
      vouch: () => holdCloudFeed([]),
    },
    {
      name: "the activity plane comes to span the fleet",
      start: () => {
        mocks.state.feedMode = "cloud";
        holdCloudFeed([]);
        narrowActivity();
      },
      vouch: () => working({}),
    },
  ];

  it.each(sources)(
    "hands focus from the row open button to the Activity section when $name and the status-unknown row leaves",
    ({ start, vouch }) => {
      start();
      listUnknown();

      act(() => vouch());

      expect(rowIds()).toEqual([]);
      expect(document.activeElement).toBe(
        screen.getByTestId("bot-activity-page"),
      );
    },
  );

  it.each(sources)(
    "leaves focus on the body after a direct blur from the row open button when $name and the status-unknown row leaves",
    ({ start, vouch }) => {
      start();
      const open = listUnknown();
      open.blur();
      expect(document.activeElement).toBe(document.body);

      act(() => vouch());

      expect(rowIds()).toEqual([]);
      expect(document.activeElement).toBe(document.body);
    },
  );

  it.each([
    [
      "hands focus from an archived agent whose cloud-fed unread result stops being attested, in a task that stays listed, to the row open button",
      false,
    ],
    [
      "leaves focus on the body after a direct blur from an archived agent whose cloud-fed unread result then stops being attested",
      true,
    ],
  ] as const)("%s", async (_name, blurred) => {
    const user = userEvent.setup();
    mocks.state.feedMode = "cloud";
    holdCloudFeed([remoteUnseenResult("t-u", "a-archived", "host-a")]);
    working({ "t-u": { working: ["a-live"], turn: ["a-live"] } });
    warmTask("t-u", [
      { id: "a-archived", parentId: null, title: "Archived", archivedAt: 5 },
      { id: "a-live", parentId: null, title: "Live", archivedAt: null },
    ]);
    render(
      <Harness
        threads={[]}
        tasks={[task("t-u", { inputNeeded: [] })]}
        boundHere={false}
        notificationSubscriptions={null}
      />,
    );
    await user.click(
      within(row("t-u")).getByTestId("bot-activity-task-chevron"),
    );
    const archived = row("t-u").querySelector<HTMLButtonElement>(
      '[data-agent-id="a-archived"]',
    );
    if (archived === null)
      throw new Error("the archived agent with an unread result is not listed");
    archived.focus();
    if (blurred) archived.blur();

    act(() =>
      useCloudNotificationsStore.getState().setConnectionState("reconnecting"),
    );

    expect(row("t-u").querySelector('[data-agent-id="a-archived"]')).toBeNull();
    expect(document.activeElement).toBe(
      blurred
        ? document.body
        : within(row("t-u")).getByTestId("bot-activity-task-open"),
    );
  });
});

describe("<BotActivityPage /> a pane that stops being the focused one in the same commit as a removal", () => {
  beforeEach(() => {
    scene.activations = 0;
  });
  const mountListed = (): HTMLElement => {
    mocks.state.feedMode = "cloud";
    holdCloudFeed([]);
    working({ "t-working": { working: ["a-1"], turn: ["a-1"] } });
    render(
      <Pane>
        <Harness
          threads={[]}
          tasks={[
            task("t-working", {
              cadence: { kind: "none" },
              inputNeeded: [],
              lastCheckinAt: NOW,
            }),
          ]}
          boundHere
          notificationSubscriptions={null}
        />
      </Pane>,
    );
    const open = within(row("t-working")).getByTestId("bot-activity-task-open");
    open.focus();
    return open;
  };

  it("hands focus to the Activity section when the pane stays the focused one", () => {
    mountListed();

    act(() => working({}));

    expect(rowIds()).toEqual([]);
    expect(document.activeElement).toBe(
      screen.getByTestId("bot-activity-page"),
    );
    expect(scene.activations).toBe(0);
  });

  it("leaves focus on the body, and the pane unactivated, when the focused row leaves as the pane stops being the focused one", () => {
    mountListed();

    act(() => {
      working({});
      scene.setFocused(false);
    });

    expect(rowIds()).toEqual([]);
    expect(document.activeElement).toBe(document.body);
    expect(scene.activations).toBe(0);
  });

  it("leaves focus on the body, and the pane unactivated, when the focused reporting trigger's methods are lost as the pane stops being the focused one", () => {
    mocks.state.realManifest = true;
    act(() =>
      recordNegotiatedHostMethods(HOST_ID, ["host.status", ...REPORT_METHODS]),
    );
    render(
      <Pane>
        <Harness
          threads={[]}
          tasks={[periodic("t-every", {})]}
          boundHere
          notificationSubscriptions={null}
        />
      </Pane>,
    );
    within(row("t-every"))
      .getByRole("button", { name: "Reporting actions" })
      .focus();

    act(() => {
      recordNegotiatedHostMethods(HOST_ID, ["host.status"]);
      scene.setFocused(false);
    });

    expect(
      within(row("t-every")).queryByRole("button", {
        name: "Reporting actions",
      }),
    ).toBeNull();
    expect(document.activeElement).toBe(document.body);
    expect(scene.activations).toBe(0);
  });
});

describe("<BotActivityPage /> a reporting trigger replaced when the hosts that answer for the task's agents change", () => {
  // The row's chat-indicator layers nest once per host that runs one of the
  // task's agents, so a session arriving (no layer, then one) or an agent of
  // another host arriving (one layer, then two) rebuilds what is inside them,
  // trigger included, while the person's focus is in the old trigger's menu.
  // Only the task's session and its agents' stores change.
  type Change = {
    readonly name: string;
    readonly before: () => void;
    readonly change: () => void;
  };
  const AGENT: WarmAgent = {
    id: "a-one",
    parentId: null,
    title: "First",
    archivedAt: null,
  };
  const CHANGES: ReadonlyArray<Change> = [
    {
      name: "the task's session arrives",
      before: () => undefined,
      change: () => warmTask("t-every", [AGENT]),
    },
    {
      name: "an agent of a second host arrives",
      before: () => warmTask("t-every", [AGENT]),
      change: () => addAgentOn("t-every", "a-two", "host-b"),
    },
  ];
  beforeEach(() => {
    scene.activations = 0;
    mocks.state.realManifest = true;
  });
  const mount = (change: Change): void => {
    change.before();
    act(() =>
      recordNegotiatedHostMethods(HOST_ID, ["host.status", ...REPORT_METHODS]),
    );
    render(
      <Pane>
        <Harness
          threads={[]}
          tasks={[periodic("t-every", {})]}
          boundHere
          notificationSubscriptions={null}
        />
      </Pane>,
    );
  };
  // An open menu hides the rest of the page from the accessibility tree.
  const trigger = (): HTMLElement =>
    within(row("t-every")).getByRole("button", {
      name: "Reporting actions",
      hidden: true,
    });

  it.each(CHANGES)(
    "when $name, the focused menu item's trigger is replaced and focus arrives at the replacement trigger with the menu closed and nothing sent",
    async (change) => {
      const user = userEvent.setup();
      mount(change);
      const old = trigger();
      await focusMenuItem(user, "Check in now");

      act(() => change.change());
      await act(async () => {
        await Promise.resolve();
      });

      const replacement = trigger();
      expect(old.isConnected).toBe(false);
      expect(replacement).not.toBe(old);
      expect(screen.queryByRole("menu")).toBeNull();
      expect(document.activeElement).toBe(replacement);
      expect(mocks.actions).toHaveLength(0);
    },
    5_000,
  );

  it.each(CHANGES)(
    "when $name after a direct blur from the trigger, focus stays on the body",
    (change) => {
      mount(change);
      const old = trigger();
      old.focus();
      old.blur();
      expect(document.activeElement).toBe(document.body);

      act(() => change.change());

      expect(old.isConnected).toBe(false);
      expect(document.activeElement).toBe(document.body);
    },
  );

  it.each(CHANGES)(
    "when $name in the commit where the pane stops being the focused one, focus stays on the body and the pane is not activated",
    async (change) => {
      const user = userEvent.setup();
      mount(change);
      const old = trigger();
      await focusMenuItem(user, "Check in now");

      act(() => {
        change.change();
        scene.setFocused(false);
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(old.isConnected).toBe(false);
      expect(document.activeElement).toBe(document.body);
      expect(scene.activations).toBe(0);
    },
    5_000,
  );

  it("keeps the original trigger, its open menu and the focused item when another agent of the same host arrives", async () => {
    const user = userEvent.setup();
    const change: Change = {
      name: "same host",
      before: () => warmTask("t-every", [AGENT]),
      change: () => addAgentOn("t-every", "a-two", "host-a"),
    };
    mount(change);
    const original = trigger();
    await focusMenuItem(user, "Check in now");
    const item = screen.getByRole("menuitem", { name: "Check in now" });

    act(() => change.change());

    expect(original.isConnected).toBe(true);
    expect(trigger()).toBe(original);
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(document.activeElement).toBe(item);
    expect(mocks.actions).toHaveLength(0);
  });
});
