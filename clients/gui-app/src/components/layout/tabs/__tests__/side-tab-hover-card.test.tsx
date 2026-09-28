/**
 * `SideTabHoverCardBody` reads live agent names through the REAL open-epic
 * registry (`useRegisteredEpicLiveAgents` / `useRegisteredEpicLiveAgentIds`,
 * the shape `use-mounted-epic-projection.test.tsx` already exercises this
 * way), and live counts through the real `agent-activity-store`. A cold epic
 * (no registry session) must show counts only, never invented names.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type {
  ChatProjection,
  TuiAgentProjection,
} from "@/stores/epics/open-epic/types";
import type { EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import {
  PARTIAL_ACTIVITY_NOTICE,
  UNKNOWN_ACTIVITY_TITLE,
} from "@/components/notifications/notification-indicator-icon";
import type { AgentActivityCoverage } from "@/lib/agent-activity";
import {
  __resetAgentActivityStoreForTests,
  __setAgentActivityStateForTests,
} from "@/stores/agent-activity-store";
import { SideTabHoverCardBody } from "../side-strip/side-tab-hover-card";
import type { SideTabLiveAgents } from "../side-strip/agent-meter";
import { NO_LIVE_AGENTS } from "../side-strip/side-tab-live-agents";

const fakeStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

function chatProjection(
  id: string,
  overrides: Partial<ChatProjection>,
): ChatProjection {
  return {
    id,
    title: "Chat",
    parentId: null,
    createdAt: 0,
    updatedAt: 0,
    userId: null,
    hostId: "host-a",
    isTitleEditedByUser: false,
    docResident: false,
    archivedAt: null,
    settings: null,
    ...overrides,
  };
}

function tuiAgentProjection(
  id: string,
  overrides: Partial<TuiAgentProjection>,
): TuiAgentProjection {
  return {
    id,
    docResident: false,
    origin: "registry",
    harnessId: "codex",
    title: "Codex",
    parentId: null,
    createdAt: 0,
    updatedAt: 0,
    userId: null,
    hostId: "host-a",
    workspaceFolders: [],
    workspaceMode: undefined,
    model: null,
    reasoningEffort: null,
    agentMode: "regular",
    profileId: null,
    archivedAt: null,
    harnessSessionId: null,
    terminalAgentArgs: null,
    terminalShellCommand: null,
    terminalShellArgs: null,
    sessionState: null,
    lastExit: null,
    ...overrides,
  };
}

const handles: OpenedStoreForTest[] = [];

function openEpic(epicId: string): OpenedStoreForTest {
  const handle = openStoreForTest({
    epicId,
    userId: null,
    factories: {
      streamClientFactory: fakeStreamClientFactory,
      laneSelection: null,
    },
    writeCommand: null,
  });
  handles.push(handle);
  return handle;
}

function agents(
  turn: number,
  background: number,
  coverage: AgentActivityCoverage,
): SideTabLiveAgents {
  return { turn, background, coverage };
}

afterEach(() => {
  cleanup();
  __getOpenEpicRegistryForTests().disposeAll();
  for (const handle of handles) handle.dispose();
  handles.length = 0;
  __resetAgentActivityStoreForTests();
});

describe("SideTabHoverCardBody", () => {
  it("shows only counts for a cold epic, no invented agent list", () => {
    render(
      <SideTabHoverCardBody
        title="Fix login"
        epicId="epic-cold"
        badge={null}
        agents={agents(2, 1, "covered")}
      />,
    );
    expect(screen.getByText("Fix login")).not.toBeNull();
    expect(screen.getByTestId("side-tab-hover-card-counts").textContent).toBe(
      "2 running · 1 background",
    );
    expect(screen.queryByTestId("side-tab-hover-card-agents")).toBeNull();
  });

  it("lists working agents by name for a warm epic", () => {
    const registry = __getOpenEpicRegistryForTests();
    const handle = openEpic("epic-warm");
    handle.store.setState({
      chats: {
        allIds: ["agent-1"],
        byId: { "agent-1": chatProjection("agent-1", { title: "Agent One" }) },
      },
      tuiAgents: {
        allIds: ["agent-2"],
        byId: {
          "agent-2": tuiAgentProjection("agent-2", { title: "Agent Two" }),
        },
      },
    });
    act(() => {
      registry.acquire("epic-warm", () => handle);
    });
    __setAgentActivityStateForTests(
      { "epic-warm": { working: ["agent-1", "agent-2"], turn: ["agent-1"] } },
      "local",
      "connected",
    );

    render(
      <SideTabHoverCardBody
        title="Fix login"
        epicId="epic-warm"
        badge={null}
        agents={agents(1, 1, "covered")}
      />,
    );

    const list = screen.getByTestId("side-tab-hover-card-agents");
    const items = Array.from(list.querySelectorAll("li[data-tier]"));
    // The name is the li's second direct child, after the tier glyph - read
    // that element specifically so this does not depend on whatever fallback
    // text the (possibly nested) running spinner paints.
    expect(items.map((item) => item.children[1]?.textContent)).toEqual([
      "Agent One",
      "Agent Two",
    ]);
    expect(items.map((item) => (item as HTMLElement).dataset.tier)).toEqual([
      "turn",
      "background",
    ]);
    // G5: only the agent rows draw a running/background status glyph - the
    // state line's own counts stay plain text.
    expect(
      screen
        .getByTestId("side-tab-hover-card-state")
        .querySelectorAll("[data-status-glyph]"),
    ).toHaveLength(0);
    expect(
      items.map((item) =>
        item
          .querySelector("[data-status-glyph]")
          ?.getAttribute("data-status-glyph"),
      ),
    ).toEqual(["running", "background"]);
  });

  it("names an untitled warm agent rather than leaving it blank", () => {
    const registry = __getOpenEpicRegistryForTests();
    const handle = openEpic("epic-warm-untitled");
    handle.store.setState({
      // An untitled chat's projection carries "" (`ChatProjection.title` is
      // `string`, never `null`) - not the sentinel `WarmAgentList` itself
      // shows a fallback for.
      chats: {
        allIds: ["agent-1"],
        byId: { "agent-1": chatProjection("agent-1", { title: "" }) },
      },
    });
    act(() => {
      registry.acquire("epic-warm-untitled", () => handle);
    });
    __setAgentActivityStateForTests(
      { "epic-warm-untitled": { working: ["agent-1"], turn: ["agent-1"] } },
      "local",
      "connected",
    );

    render(
      <SideTabHoverCardBody
        title="Fix login"
        epicId="epic-warm-untitled"
        badge={null}
        agents={agents(1, 0, "covered")}
      />,
    );

    expect(
      screen.getByTestId("side-tab-hover-card-agents").textContent,
    ).toContain("Untitled agent");
  });

  it("shows no agent list, warm or cold, when there is nothing live", () => {
    const registry = __getOpenEpicRegistryForTests();
    const handle = openEpic("epic-warm-idle");
    handle.store.setState({ chats: { allIds: [], byId: {} } });
    act(() => {
      registry.acquire("epic-warm-idle", () => handle);
    });

    render(
      <SideTabHoverCardBody
        title="Fix login"
        epicId="epic-warm-idle"
        badge={null}
        agents={{ ...NO_LIVE_AGENTS, coverage: "covered" }}
      />,
    );
    expect(screen.queryByTestId("side-tab-hover-card-counts")).toBeNull();
    expect(screen.queryByTestId("side-tab-hover-card-agents")).toBeNull();
    expect(screen.getByTestId("side-tab-hover-card-state").textContent).toBe(
      "Idle",
    );
  });

  it.each([
    ["approval", "Needs approval"],
    ["reply", "Needs a reply"],
    ["failed", "Failed"],
    ["unread", "Done, unread"],
  ] as const)(
    "states the %s badge ahead of running or background work",
    (badge, label) => {
      render(
        <SideTabHoverCardBody
          title="Fix login"
          epicId={null}
          badge={badge}
          agents={agents(2, 0, "covered")}
        />,
      );
      expect(
        screen.getByTestId("side-tab-hover-card-state").textContent,
      ).toContain(label);
    },
  );

  it("shows the state line as plain counts text with no status glyph, with no badge (G5)", () => {
    render(
      <SideTabHoverCardBody
        title="Fix login"
        epicId={null}
        badge={null}
        agents={agents(1, 0, "covered")}
      />,
    );
    const running = screen.getByTestId("side-tab-hover-card-state");
    expect(running.textContent).toBe("1 running");
    expect(running.querySelectorAll("[data-status-glyph]")).toHaveLength(0);
    cleanup();

    render(
      <SideTabHoverCardBody
        title="Fix login"
        epicId={null}
        badge={null}
        agents={agents(2, 1, "covered")}
      />,
    );
    const both = screen.getByTestId("side-tab-hover-card-state");
    expect(both.textContent).toBe("2 running · 1 background");
    expect(both.querySelectorAll("[data-status-glyph]")).toHaveLength(0);
  });

  it("marks the badge glyph and right-aligns the counts only when a badge is present (G5)", () => {
    render(
      <SideTabHoverCardBody
        title="Fix login"
        epicId={null}
        badge="approval"
        agents={agents(2, 0, "covered")}
      />,
    );
    const state = screen.getByTestId("side-tab-hover-card-state");
    const glyph = state.querySelector("[data-status-glyph]");
    expect(glyph?.getAttribute("data-status-glyph")).toBe("approval");
    expect(
      screen
        .getByTestId("side-tab-hover-card-counts")
        .classList.contains("ms-auto"),
    ).toBe(true);
    cleanup();

    render(
      <SideTabHoverCardBody
        title="Fix login"
        epicId={null}
        badge={null}
        agents={agents(2, 0, "covered")}
      />,
    );
    expect(
      screen
        .getByTestId("side-tab-hover-card-counts")
        .classList.contains("ms-auto"),
    ).toBe(false);
  });
});

describe("SideTabHoverCardBody under unserved/indeterminate coverage (F8 round 2)", () => {
  it("shows the unknown glyph and title, never Idle, under unserved coverage with no badge and no agents", () => {
    render(
      <SideTabHoverCardBody
        title="Fix login"
        epicId={null}
        badge={null}
        agents={agents(0, 0, "unserved")}
      />,
    );
    const state = screen.getByTestId("side-tab-hover-card-state");
    expect(state.textContent).toContain(UNKNOWN_ACTIVITY_TITLE);
    expect(state.textContent).not.toContain("Idle");
    expect(screen.getByTestId("side-tab-hover-card-unknown")).toBeTruthy();
    expect(screen.queryByTestId("side-tab-hover-card-partial")).toBeNull();
  });

  it("shows the plain counts and adds the partial notice when unserved coverage still has agents (G5)", () => {
    render(
      <SideTabHoverCardBody
        title="Fix login"
        epicId={null}
        badge={null}
        agents={agents(1, 0, "unserved")}
      />,
    );
    const state = screen.getByTestId("side-tab-hover-card-state");
    expect(state.textContent).toBe("1 running");
    expect(state.querySelectorAll("[data-status-glyph]")).toHaveLength(0);
    expect(screen.queryByTestId("side-tab-hover-card-unknown")).toBeNull();
    expect(screen.getByTestId("side-tab-hover-card-partial").textContent).toBe(
      PARTIAL_ACTIVITY_NOTICE,
    );
  });

  it("keeps the badge state and adds the partial notice when unserved coverage has a badge but no agents", () => {
    render(
      <SideTabHoverCardBody
        title="Fix login"
        epicId={null}
        badge="approval"
        agents={agents(0, 0, "unserved")}
      />,
    );
    const state = screen.getByTestId("side-tab-hover-card-state");
    expect(state.textContent).toContain("Needs approval");
    expect(screen.queryByTestId("side-tab-hover-card-unknown")).toBeNull();
    expect(screen.getByTestId("side-tab-hover-card-partial").textContent).toBe(
      PARTIAL_ACTIVITY_NOTICE,
    );
  });

  it("reads plain Idle with no partial line under indeterminate coverage - nothing answering is the pill's story, not a per-row one", () => {
    render(
      <SideTabHoverCardBody
        title="Fix login"
        epicId={null}
        badge={null}
        agents={agents(0, 0, "indeterminate")}
      />,
    );
    const state = screen.getByTestId("side-tab-hover-card-state");
    expect(state.textContent).toBe("Idle");
    expect(screen.queryByTestId("side-tab-hover-card-unknown")).toBeNull();
    expect(screen.queryByTestId("side-tab-hover-card-partial")).toBeNull();
  });
});
