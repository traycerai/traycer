import "../../../../../__tests__/test-browser-apis";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { useRegisterTileFindAdapter } from "@/components/epic-canvas/tile-find/tile-find-adapter-context";
import { TileFindScope } from "@/components/epic-canvas/tile-find/tile-find-scope";
import { renderTile } from "@/components/epic-canvas/renderers/tile-render";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";
import {
  useTileFindStore,
  type TileFindAdapter,
  type TileFindCapability,
  type TileFindStateSnapshot,
} from "@/stores/tile-find";

vi.mock("@/components/epic-canvas/renderers/chat-tile", () => ({
  ChatTile: () => <div data-testid="renderer-chat" />,
}));
vi.mock("@/components/epic-canvas/renderers/tui-agent-tile", () => ({
  TuiAgentTile: () => <div data-testid="renderer-terminal-agent" />,
}));
vi.mock("@/components/epic-canvas/renderers/spec-tile", () => ({
  SpecTile: () => <div data-testid="renderer-spec" />,
}));
vi.mock("@/components/epic-canvas/renderers/ticket-tile", () => ({
  TicketTile: () => <div data-testid="renderer-ticket" />,
}));
vi.mock("@/components/epic-canvas/renderers/story-tile", () => ({
  StoryTile: () => <div data-testid="renderer-story" />,
}));
vi.mock("@/components/epic-canvas/renderers/review-tile", () => ({
  ReviewTile: () => <div data-testid="renderer-review" />,
}));
vi.mock("@/components/epic-canvas/renderers/terminal-tile", () => ({
  TerminalTile: () => <div data-testid="renderer-terminal" />,
}));
vi.mock("@/components/epic-canvas/renderers/workspace-file-tile", () => ({
  WorkspaceFileTile: () => <div data-testid="renderer-workspace-file" />,
}));
vi.mock("@/components/epic-canvas/renderers/git-diff-tile", () => ({
  GitDiffTile: () => <div data-testid="renderer-git-diff" />,
}));
vi.mock("@/components/epic-canvas/renderers/snapshot-diff-tile", () => ({
  SnapshotDiffTile: () => <div data-testid="renderer-snapshot-diff" />,
}));
vi.mock("@/components/epic-canvas/canvas/pane-opener", () => ({
  PaneOpener: () => <div data-testid="renderer-blank" />,
}));

const BASE_NODE = {
  id: "node-1",
  instanceId: "instance-1",
  name: "Node",
  hostId: "host-1",
};

const NODES: ReadonlyArray<EpicCanvasTileRef> = [
  { ...BASE_NODE, id: "chat-1", instanceId: "chat-inst", type: "chat" },
  {
    ...BASE_NODE,
    id: "agent-1",
    instanceId: "agent-inst",
    type: "terminal-agent",
  },
  { ...BASE_NODE, id: "spec-1", instanceId: "spec-inst", type: "spec" },
  { ...BASE_NODE, id: "ticket-1", instanceId: "ticket-inst", type: "ticket" },
  { ...BASE_NODE, id: "story-1", instanceId: "story-inst", type: "story" },
  { ...BASE_NODE, id: "review-1", instanceId: "review-inst", type: "review" },
  {
    ...BASE_NODE,
    id: "terminal-1",
    instanceId: "terminal-inst",
    type: "terminal",
    titleSource: "default",
    cwd: "/tmp",
  },
  {
    ...BASE_NODE,
    id: "file-1",
    instanceId: "file-inst",
    type: "workspace-file",
    workspacePath: "/repo",
    filePath: "src/a.ts",
  },
  {
    ...BASE_NODE,
    id: "git-1",
    instanceId: "git-inst",
    type: "git-diff",
    repositoryContext: null,
    diff: {
      kind: "file",
      runningDir: "/repo",
      filePath: "src/a.ts",
      stage: "unstaged",
    },
    view: { collapsedFilePaths: [] },
  },
  {
    ...BASE_NODE,
    id: "snapshot-1",
    instanceId: "snapshot-inst",
    type: "snapshot-diff",
    diff: {
      kind: "snapshot-cumulative",
      chatId: "chat-1",
      filePath: "src/a.ts",
    },
    view: { collapsedFilePaths: [] },
  },
  { ...BASE_NODE, id: "blank-1", instanceId: "blank-inst", type: "blank" },
];

const FIND_CAPABILITY = new Set<TileFindCapability>(["find"]);

function readySnapshot(tileInstanceId: string): TileFindStateSnapshot {
  return {
    requestId: 0,
    status: "idle",
    capabilities: FIND_CAPABILITY,
    query: "",
    matchCase: false,
    replaceText: "",
    current: 0,
    total: 0,
    coverageMessage: null,
    errorMessage: null,
    activeUnitId: tileInstanceId,
    exactHighlight: "none",
  };
}

function createReadyAdapter(tileInstanceId: string): TileFindAdapter {
  const listeners = new Set<() => void>();
  return {
    tileInstanceId,
    tileKind: "spec",
    getSnapshot: () => readySnapshot(tileInstanceId),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    search: () => undefined,
    next: () => undefined,
    previous: () => undefined,
    clear: () => undefined,
    replace: null,
  };
}

function AdapterChild(props: { readonly adapter: TileFindAdapter }): ReactNode {
  useRegisterTileFindAdapter(props.adapter);
  return <div data-testid="registered-adapter-child" />;
}

describe("renderTile tile find scope", () => {
  afterEach(() => {
    cleanup();
    useTileFindStore.getState().resetForTests();
  });

  it.each(NODES)(
    "wraps the $type tile kind with TileFindScope metadata",
    async (node) => {
      render(
        <>
          {renderTile({
            node,
            viewTabId: "view-1",
            tileId: "pane-1",
            epicId: "epic-1",
            isActive: true,
          })}
        </>,
      );

      const scope = screen.getByTestId("tile-find-scope");
      expect(scope.hasAttribute("data-tile-find-scope")).toBe(true);
      expect(scope.getAttribute("data-tile-instance-id")).toBe(node.instanceId);
      expect(scope.getAttribute("data-tile-kind")).toBe(node.type);
      expect(scope.getAttribute("data-view-tab-id")).toBe("view-1");
      expect(scope.getAttribute("data-tile-id")).toBe("pane-1");
      expect(scope.getAttribute("data-epic-id")).toBe("epic-1");
      expect(screen.getByTestId(`renderer-${node.type}`)).toBeTruthy();

      await waitFor(() => {
        expect(useTileFindStore.getState().activeOwner).toMatchObject({
          tileInstanceId: node.instanceId,
          tileKind: node.type,
        });
      });
    },
  );

  it("keeps inactive or hidden tile scopes from owning find", async () => {
    const node = NODES[0];
    render(
      <>
        {renderTile({
          node,
          viewTabId: "view-1",
          tileId: "pane-1",
          epicId: "epic-1",
          isActive: false,
        })}
      </>,
    );

    await waitFor(() => {
      expect(
        useTileFindStore.getState().targetsByTileInstanceId[node.instanceId],
      ).toBeDefined();
    });
    expect(useTileFindStore.getState().activeOwner).toBeNull();
  });

  it("renders the default unavailable bar for blank tiles", async () => {
    const blank = NODES[NODES.length - 1];
    render(
      <>
        {renderTile({
          node: blank,
          viewTabId: "view-1",
          tileId: "pane-1",
          epicId: "epic-1",
          isActive: true,
        })}
      </>,
    );

    await waitFor(() => {
      expect(
        useTileFindStore.getState().targetsByTileInstanceId[blank.instanceId],
      ).toBeDefined();
    });

    act(() => {
      useTileFindStore.getState().openForTile(blank.instanceId);
    });

    expect(screen.getByTestId("tile-find-bar")).toBeTruthy();
    expect(screen.getByText("Open a tile before using find.")).toBeTruthy();
  });

  it("lets tile renderers replace the default adapter through the scope hook", async () => {
    const node = NODES.find((candidate) => candidate.type === "spec");
    if (node === undefined) throw new Error("Expected spec fixture");
    const adapter = createReadyAdapter(node.instanceId);

    render(
      <TileFindScope
        node={node}
        viewTabId="view-1"
        tileId="pane-1"
        epicId="epic-1"
        isActive
      >
        <AdapterChild adapter={adapter} />
      </TileFindScope>,
    );

    await waitFor(() => {
      expect(
        useTileFindStore.getState().targetsByTileInstanceId[node.instanceId]
          ?.adapter,
      ).toBe(adapter);
    });
    expect(screen.getByTestId("registered-adapter-child")).toBeTruthy();
  });
});
