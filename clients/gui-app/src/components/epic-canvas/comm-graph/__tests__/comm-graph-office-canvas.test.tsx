const registerFindAdapterMock = vi.hoisted(() =>
  vi.fn<(adapter: TileFindAdapter) => void>(),
);

vi.mock("@/components/epic-canvas/tile-find/tile-find-adapter-context", () => ({
  useRegisterTileFindAdapter: registerFindAdapterMock,
}));

vi.mock("@/providers/use-resolved-theme", () => ({
  useResolvedTheme: () => ({
    resolvedTheme: "light" as const,
    themePreset: "default",
  }),
}));

// `useEpicAgentActivityTiers` resolves the open-epic session handle, which this
// suite has no use for: the office statuses it feeds are covered in
// `lib/comm-graph/office/__tests__/office-status.test.ts`. PARTIAL, because the
// detail panel this suite opens reaches other selectors in the same module.
vi.mock("@/lib/epic-selectors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/epic-selectors")>();
  return { ...actual, useEpicAgentActivityTiers: () => new Map() };
});

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommGraphOfficeCanvas } from "@/components/epic-canvas/comm-graph/office/comm-graph-office-canvas";
import type { CommGraphAgentNode } from "@/lib/comm-graph/comm-graph-model";
import type { CommGraphTileViewState } from "@/stores/epics/canvas/types";
import type { TileFindAdapter } from "@/stores/tile-find";

const OFFICE_VIEW: CommGraphTileViewState = {
  x: 0,
  y: 0,
  zoom: 1,
  mode: "office",
};

function agent(id: string, name: string): CommGraphAgentNode {
  return {
    id,
    kind: "chat",
    name,
    hostId: "host-1",
    parentId: null,
    harnessId: null,
    archived: false,
    createdAt: 1,
  };
}

const ORCHESTRATOR = agent("agent-1", "Orchestrator");
const REVIEWER = agent("agent-2", "Reviewer");

function renderOffice(visibleIds: ReadonlySet<string>) {
  return render(
    <CommGraphOfficeCanvas
      epicId="epic-1"
      tileInstanceId="comm-graph-instance-1"
      agents={[ORCHESTRATOR, REVIEWER]}
      agentIds={visibleIds}
      events={[]}
      hosts={[]}
      initialHistoryCaughtUp={false}
      playing={false}
      pulse={null}
      pulseKey={null}
      modeToggle={null}
      view={OFFICE_VIEW}
      onViewChange={vi.fn()}
      canOpenAgentForEvent={() => true}
      canJump={() => false}
      onJump={vi.fn()}
      canJumpToSender={() => false}
      onJumpToSender={vi.fn()}
      canJumpToCreated={() => false}
      onJumpToCreated={vi.fn()}
      onOpenAgent={vi.fn()}
    />,
  );
}

function latestFindAdapter(): TileFindAdapter {
  const adapter = registerFindAdapterMock.mock.lastCall?.[0];
  if (adapter === undefined) throw new Error("Find adapter was not registered");
  return adapter;
}

afterEach(() => {
  cleanup();
  registerFindAdapterMock.mockClear();
  vi.restoreAllMocks();
});

/**
 * jsdom has no 2d canvas context, so nothing here can assert a pixel. That is
 * deliberate rather than a gap being tolerated: the drawing is a pure function
 * of the frame (covered where the frame is built, in the scene's own suite),
 * while what a person can DO with the floor - reach an agent, open it, and not
 * lose the surface when there is no context at all - is exactly what survives
 * the missing context and is asserted below.
 */
describe("CommGraphOfficeCanvas", () => {
  it("renders the floor without a 2d context instead of throwing", () => {
    const result = renderOffice(new Set([ORCHESTRATOR.id, REVIEWER.id]));

    expect(result.getByTestId("comm-graph-office-canvas")).toBeDefined();
    expect(
      screen.getByRole("img", {
        name: "Office view of the communication graph",
      }),
    ).toBeDefined();
  });

  it("exposes one accessible control per agent that exists as of the cursor", () => {
    // The second agent has not been revealed by the cursor yet, so it has no
    // character on the floor and must have no way to be opened either.
    renderOffice(new Set([ORCHESTRATOR.id]));

    expect(
      screen.getByTestId(`comm-graph-office-agent-${ORCHESTRATOR.id}`)
        .textContent,
    ).toBe("Orchestrator");
    expect(
      screen.queryByTestId(`comm-graph-office-agent-${REVIEWER.id}`),
    ).toBeNull();
  });

  it("opens the agent's activity panel from the accessible control", () => {
    renderOffice(new Set([ORCHESTRATOR.id, REVIEWER.id]));
    expect(screen.queryByTestId("comm-graph-agent-panel")).toBeNull();

    fireEvent.click(
      screen.getByTestId(`comm-graph-office-agent-${REVIEWER.id}`),
    );

    expect(screen.getByTestId("comm-graph-agent-panel")).toBeDefined();
    // The panel names the agent that was clicked, not merely "an" agent.
    expect(screen.getAllByText("Reviewer").length).toBeGreaterThan(0);
  });

  it("registers a Find adapter that searches the agents on the floor", async () => {
    renderOffice(new Set([ORCHESTRATOR.id, REVIEWER.id]));

    await act(async () => {
      await latestFindAdapter().search({
        requestId: 3,
        query: "review",
        matchCase: false,
      });
    });

    const snapshot = latestFindAdapter().getSnapshot();
    expect(snapshot.total).toBe(1);
    expect(snapshot.activeUnitId).toBe(REVIEWER.id);
  });

  it("searches only the agents the cursor has revealed", async () => {
    // The floor is drawn as of the time cursor, so an agent that has not been
    // created yet is not on it - and must not be findable on it either.
    renderOffice(new Set([ORCHESTRATOR.id]));

    await act(async () => {
      await latestFindAdapter().search({
        requestId: 4,
        query: "review",
        matchCase: false,
      });
    });

    expect(latestFindAdapter().getSnapshot().total).toBe(0);
  });

  it("opens the agent panel when Find focuses a match", async () => {
    renderOffice(new Set([ORCHESTRATOR.id, REVIEWER.id]));
    await act(async () => {
      await latestFindAdapter().search({
        requestId: 5,
        query: "e",
        matchCase: false,
      });
    });
    expect(screen.queryByTestId("comm-graph-agent-panel")).toBeNull();

    // `next` moves off the first match and focuses the one it lands on;
    // focusing is what opens the panel, so a match is readable and not merely
    // pointed at.
    await act(async () => {
      await latestFindAdapter().next();
    });

    expect(screen.getByTestId("comm-graph-agent-panel")).toBeDefined();
  });

  it("carries a zoom control set the pointer gestures are not the only route to", () => {
    renderOffice(new Set([ORCHESTRATOR.id]));

    expect(screen.getByTestId("comm-graph-office-zoom-in")).toBeDefined();
    expect(screen.getByTestId("comm-graph-office-zoom-out")).toBeDefined();
    expect(screen.getByTestId("comm-graph-office-fit")).toBeDefined();
  });
});
