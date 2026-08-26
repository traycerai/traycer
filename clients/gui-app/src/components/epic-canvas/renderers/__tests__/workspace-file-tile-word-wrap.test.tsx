import "../../../../../__tests__/test-browser-apis";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { WorkspaceFileRef } from "@/stores/epics/canvas/types";
import { fileEditRuntimeRegistry } from "@/lib/workspace/file-edit-runtime-registry";

interface WordWrapTestState {
  coarsePointer: boolean;
  readonly rendererWordWrap: Mock<(wordWrap: boolean) => void>;
}

const state = vi.hoisted((): WordWrapTestState => ({
  coarsePointer: false,
  rendererWordWrap: vi.fn(),
}));

vi.mock("@/components/diff/diff-edit-provider-loader", () => ({
  preloadDiffEditProvider: () => Promise.resolve(),
}));

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => ({ status: "reachable", hostLabel: "Host A" }),
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: () => false,
}));

vi.mock("@/hooks/workspace/use-read-file-query", () => ({
  useWorkspaceReadFile: () => ({
    data: { content: "const value = 1;\n", error: null, truncated: false },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

// The pointer class is the whole input to the default, and jsdom's
// `matchMedia` answers `false` to every query - so it is stubbed here rather
// than inferred from the environment.
vi.mock("@/hooks/ui/use-coarse-pointer", () => ({
  useCoarsePointer: () => state.coarsePointer,
}));

vi.mock(
  "@/components/epic-canvas/workspace-file/workspace-file-renderer",
  () => ({
    WorkspaceFileRenderer: (props: {
      readonly wordWrap: boolean;
    }): ReactNode => {
      state.rendererWordWrap(props.wordWrap);
      return <div data-testid="workspace-file-source" />;
    },
  }),
);

import { WorkspaceFileTile } from "../workspace-file-tile";
import { TabHostProvider } from "../../tab-host-provider";
import { useSettingsStore } from "@/stores/settings/settings-store";

const NODE: WorkspaceFileRef = {
  id: "workspace-file:host-A:/work/repo:src/index.ts",
  instanceId: "workspace-file-instance",
  type: "workspace-file",
  name: "index.ts",
  hostId: "host-A",
  workspacePath: "/work/repo",
  filePath: "src/index.ts",
};

describe("<WorkspaceFileTile /> word wrap", () => {
  beforeEach(() => {
    fileEditRuntimeRegistry.resetForTesting();
    state.coarsePointer = false;
    state.rendererWordWrap.mockReset();
    useSettingsStore.setState({ workspaceFileWordWrap: null });
  });

  afterEach(() => {
    cleanup();
    fileEditRuntimeRegistry.resetForTesting();
    useSettingsStore.setState({ workspaceFileWordWrap: null });
  });

  it("wraps by default on a coarse pointer and not on a fine one", () => {
    renderTile(NODE);
    expect(lastWordWrap()).toBe(false);
    cleanup();

    state.coarsePointer = true;
    state.rendererWordWrap.mockReset();
    renderTile(NODE);
    expect(lastWordWrap()).toBe(true);
  });

  it("keeps an explicit choice, so the pointer default stops applying", () => {
    state.coarsePointer = true;
    renderTile(NODE);
    expect(lastWordWrap()).toBe(true);

    toggleWordWrap();

    expect(lastWordWrap()).toBe(false);
    // `false`, not `null`: the device default must not be able to win it back.
    expect(useSettingsStore.getState().workspaceFileWordWrap).toBe(false);
  });

  it("turns wrapping on from the toolbar on a fine pointer", () => {
    renderTile(NODE);
    expect(lastWordWrap()).toBe(false);

    toggleWordWrap();

    expect(lastWordWrap()).toBe(true);
    expect(useSettingsStore.getState().workspaceFileWordWrap).toBe(true);
  });

  it("shares one stored choice across two tiles showing different files", () => {
    renderTile(NODE);
    toggleWordWrap();
    cleanup();
    state.rendererWordWrap.mockReset();

    renderTile({
      ...NODE,
      id: "workspace-file:host-A:/work/repo:src/other.ts",
      instanceId: "workspace-file-other",
      name: "other.ts",
      filePath: "src/other.ts",
    });

    expect(lastWordWrap()).toBe(true);
  });
});

function lastWordWrap(): boolean {
  const calls = state.rendererWordWrap.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0];
}

function toggleWordWrap(): void {
  fireEvent.click(screen.getByRole("button", { name: "File view settings" }));
  fireEvent.click(screen.getByRole("switch"));
}

function renderTile(node: WorkspaceFileRef) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TabHostProvider hostId="host-A">
        <WorkspaceFileTile node={node} viewTabId="view-1" isActive />
      </TabHostProvider>
    </QueryClientProvider>,
  );
}
