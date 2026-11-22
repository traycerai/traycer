import "../../../../../__tests__/test-browser-apis";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
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

const rendererLanguage = vi.hoisted((): Mock<(language: string) => void> =>
  vi.fn(),
);

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
  useHostMethodSchemaVersion: () => null,
  useHostSupportsMethod: () => false,
}));

vi.mock("@/hooks/workspace/use-read-file-query", () => ({
  useWorkspaceReadFile: () => ({
    data: { content: "text\n", error: null, truncated: false },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock(
  "@/components/epic-canvas/workspace-file/workspace-file-renderer",
  () => ({
    WorkspaceFileRenderer: (props: {
      readonly language: string;
    }): ReactNode => {
      rendererLanguage(props.language);
      return <div data-testid="workspace-file-source" />;
    },
  }),
);

import { WorkspaceFileTile } from "../workspace-file-tile";
import { TabHostProvider } from "../../tab-host-provider";

function nodeNamed(name: string): WorkspaceFileRef {
  return {
    id: `workspace-file:host-A:/work/repo:${name}`,
    instanceId: "workspace-file-instance",
    type: "workspace-file",
    name,
    hostId: "host-A",
    workspacePath: "/work/repo",
    filePath: name,
  };
}

function renderTile(node: WorkspaceFileRef): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TabHostProvider hostId="host-A">
        <WorkspaceFileTile node={node} viewTabId="view-1" isActive />
      </TabHostProvider>
    </QueryClientProvider>,
  );
}

describe("<WorkspaceFileTile /> language", () => {
  beforeEach(() => {
    fileEditRuntimeRegistry.resetForTesting();
    rendererLanguage.mockReset();
  });

  afterEach(() => {
    cleanup();
    fileEditRuntimeRegistry.resetForTesting();
  });

  it.each([
    ["Dockerfile", "dockerfile"],
    ["index.ts", "typescript"],
    ["README", "text"],
    ["constructor", "text"],
  ])("opens %s as %s", (name, language) => {
    renderTile(nodeNamed(name));

    expect(rendererLanguage).toHaveBeenLastCalledWith(language);
  });
});
