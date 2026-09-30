/**
 * `useStripTaskAgents` reads the REAL open-epic registry (names, warmth), the
 * real activity store (tiers) and the strip's indicator context (waiting and
 * failed), the way `side-tab-hover-card.test.tsx` reads the first two.
 */
import type { ReactNode } from "react";
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NotificationIndicatorsProvider } from "@/components/notifications/notification-indicators-provider";
import {
  __resetAgentActivityStoreForTests,
  __setAgentActivityStateForTests,
} from "@/stores/agent-activity-store";
import type { SurfaceNotificationIndicators } from "@/stores/notifications/notification-indicator-state";
import { useStripTaskAgents } from "../strip-task-agents";
import { chatProjection, coolAllEpics, warmEpic } from "./warm-epic-fixture";

const NO_FLAGS = {
  pendingApproval: false,
  pendingInterview: false,
  pendingFork: false,
  unreadFailure: false,
  unreadDone: false,
};

function wrapperOf(chats: SurfaceNotificationIndicators["chats"]) {
  return function Wrapper(props: { readonly children: ReactNode }): ReactNode {
    return (
      <NotificationIndicatorsProvider indicators={{ epics: {}, chats }}>
        {props.children}
      </NotificationIndicatorsProvider>
    );
  };
}

afterEach(() => {
  cleanup();
  coolAllEpics();
  __resetAgentActivityStoreForTests();
});

describe("useStripTaskAgents", () => {
  it("names a warm task's live agents: needs you, failed, running (latest first), background", () => {
    warmEpic("epic-warm", [
      chatProjection("approval", { title: "Needs approval", updatedAt: 10 }),
      chatProjection("reply", { title: "Needs an answer", updatedAt: 15 }),
      chatProjection("fork", { title: "Fork to resolve", updatedAt: 12 }),
      chatProjection("failed", { title: "Crashed", updatedAt: 20 }),
      chatProjection("turn-new", { title: "Newest turn", updatedAt: 90 }),
      chatProjection("turn-old", { title: "", updatedAt: 40 }),
      chatProjection("background", { title: "Watcher", updatedAt: 50 }),
      chatProjection("done", { title: "Finished", updatedAt: 60 }),
      chatProjection("idle", { title: "Idle", updatedAt: 70 }),
    ]);
    __setAgentActivityStateForTests(
      {
        "epic-warm": {
          working: ["turn-new", "turn-old", "background"],
          turn: ["turn-new", "turn-old"],
        },
      },
      "local",
      "connected",
    );

    const { result } = renderHook(() => useStripTaskAgents("epic-warm"), {
      wrapper: wrapperOf({
        approval: { ...NO_FLAGS, pendingApproval: true },
        reply: { ...NO_FLAGS, pendingInterview: true },
        fork: { ...NO_FLAGS, pendingFork: true },
        failed: { ...NO_FLAGS, unreadFailure: true },
        done: { ...NO_FLAGS, unreadDone: true },
      }),
    });

    expect(result.current.warm).toBe(true);
    expect(
      result.current.agents.map(({ id, title, status, since }) => ({
        id,
        title,
        status,
        since,
      })),
    ).toEqual([
      { id: "reply", title: "Needs an answer", status: "waiting", since: 15 },
      { id: "fork", title: "Fork to resolve", status: "waiting", since: 12 },
      { id: "approval", title: "Needs approval", status: "waiting", since: 10 },
      { id: "failed", title: "Crashed", status: "failed", since: 20 },
      { id: "turn-new", title: "Newest turn", status: "turn", since: 90 },
      { id: "turn-old", title: null, status: "turn", since: 40 },
      { id: "background", title: "Watcher", status: "background", since: 50 },
    ]);
  });

  it("is cold with no agents while the activity plane says the task is busy", () => {
    __setAgentActivityStateForTests(
      { "epic-cold": { working: ["agent-1"], turn: ["agent-1"] } },
      "local",
      "connected",
    );

    const { result } = renderHook(() => useStripTaskAgents("epic-cold"), {
      wrapper: wrapperOf({}),
    });

    expect(result.current).toEqual({ warm: false, agents: [] });
  });

  it("is warm with no agents when nothing in the task is live", () => {
    warmEpic("epic-idle", [chatProjection("idle", { title: "Idle" })]);

    const { result } = renderHook(() => useStripTaskAgents("epic-idle"), {
      wrapper: wrapperOf({}),
    });

    expect(result.current).toEqual({ warm: true, agents: [] });
  });
});
