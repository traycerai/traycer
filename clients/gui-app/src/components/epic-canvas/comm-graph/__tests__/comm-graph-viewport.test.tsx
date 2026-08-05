import "../../../../../__tests__/test-browser-apis";

const reactFlowMock = vi.hoisted(() => vi.fn((_props: unknown) => null));

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return { ...actual, ReactFlow: reactFlowMock };
});

vi.mock("@/providers/use-resolved-theme", () => ({
  useResolvedTheme: () => ({
    resolvedTheme: "light" as const,
    themePreset: "default",
  }),
}));

vi.mock("@/lib/epic-selectors", () => ({
  useEpicAgentActivityTiers: () => new Map(),
}));

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommGraphCanvas } from "@/components/epic-canvas/comm-graph/comm-graph-canvas";
import type { CommGraphAgentNode } from "@/lib/comm-graph/comm-graph-model";
import { DEFAULT_COMM_GRAPH_VIEW } from "@/stores/epics/canvas/tile-schema/comm-graph-tile";
import type { CommGraphTileViewState } from "@/stores/epics/canvas/types";

const AGENT: CommGraphAgentNode = {
  id: "agent-1",
  kind: "chat",
  name: "Agent",
  hostId: "host-1",
  parentId: null,
  harnessId: null,
  archived: false,
  createdAt: 1,
};

function renderCanvas(view: CommGraphTileViewState): void {
  render(
    <CommGraphCanvas
      epicId="epic-1"
      agents={[AGENT]}
      agentIds={new Set([AGENT.id])}
      events={[]}
      hosts={[]}
      pulse={null}
      view={view}
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

afterEach(() => {
  cleanup();
  reactFlowMock.mockClear();
});

describe("CommGraphCanvas viewport", () => {
  it("fits every node on first open and permits a full-graph overview", () => {
    renderCanvas(DEFAULT_COMM_GRAPH_VIEW);

    expect(reactFlowMock.mock.lastCall?.[0]).toEqual(
      expect.objectContaining({
        defaultViewport: DEFAULT_COMM_GRAPH_VIEW,
        fitView: true,
        minZoom: 0.1,
      }),
    );
  });

  it("restores a user-positioned viewport instead of fitting it again", () => {
    const persistedView = { x: 120, y: -80, zoom: 0.75 };
    renderCanvas(persistedView);

    expect(reactFlowMock.mock.lastCall?.[0]).toEqual(
      expect.objectContaining({
        defaultViewport: persistedView,
        fitView: false,
        minZoom: 0.1,
      }),
    );
  });
});
