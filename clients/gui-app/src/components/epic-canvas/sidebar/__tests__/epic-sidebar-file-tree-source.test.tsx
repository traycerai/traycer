import "../../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type {
  IStreamSession,
  ServerFrameHandler,
  StatusChangeHandler,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import {
  hostStreamRpcRegistry,
  type HostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import {
  WsStreamClient,
  type ParamsOf,
  type StreamMethodSupport,
} from "@traycer-clients/shared/host-transport/ws-stream-client";
import type { WorkspaceSubscribeFileListServerFrame } from "@traycer/protocol/host/workspace/subscribe";
import { StreamRuntimeContext } from "@/lib/host/stream-runtime-context";
import { useFileTreeStore } from "@/stores/file-tree/file-tree-store";
import { __resetWorkspaceFileListSubscriptionsForTesting } from "@/hooks/workspace/use-workspace-file-list-subscription";

const HOST_ID = "host-1";
const WORKSPACE_PATH = "/work/repo";

const listFileTreeCalls: Array<{
  readonly workspacePath: string | null;
  readonly enabled: boolean;
}> = [];
const resetPathsCalls: Array<ReadonlyArray<string>> = [];

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => HOST_ID,
}));

vi.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({ diffViewerPreferences: { ignoreWhitespace: false } }),
}));

vi.mock("@/hooks/git/use-git-list-changed-files-subscription", () => ({
  useGitListChangedFilesSubscription: () => ({
    data: null,
    error: null,
    isPending: false,
    repoState: null,
    repoMode: null,
    pollStartedAtMs: null,
  }),
}));

vi.mock("@/hooks/workspace/use-list-file-tree-query", () => ({
  useWorkspaceListFileTree: (
    workspacePath: string | null,
    enabled: boolean,
  ) => {
    listFileTreeCalls.push({ workspacePath, enabled });
    return {
      data: enabled
        ? {
            workspacePath,
            files: [{ path: "unary.md", name: "unary.md" }],
            gitStatus: [],
            truncated: false,
          }
        : undefined,
      error: null,
      isLoading: false,
    };
  },
}));

vi.mock("@/components/epic-canvas/dnd/epic-canvas-dnd-context-value", () => ({
  useEpicCanvasDnd: () => ({
    activeSource: null,
    dropPreview: null,
    interactionLocked: false,
    clearDropPreview: () => undefined,
  }),
}));

vi.mock("@pierre/trees/react", () => ({
  FileTree: () => <div data-testid="pierre-file-tree-stub" />,
  useFileTree: () => ({
    model: {
      setSearch: () => undefined,
      setGitStatus: () => undefined,
      resetPaths: (paths: ReadonlyArray<string>) => {
        resetPathsCalls.push(paths);
      },
      subscribe: () => () => undefined,
      getItem: () => null,
    },
  }),
}));

import { FileTreePanelBodyForWorkspace } from "@/components/epic-canvas/sidebar/epic-sidebar-file-tree";

class MockStreamSession implements IStreamSession {
  private serverFrameHandler: ServerFrameHandler | null = null;
  private statusChangeHandler: StatusChangeHandler | null = null;

  onServerFrame(handler: ServerFrameHandler): void {
    this.serverFrameHandler = handler;
  }
  onStatusChange(handler: StatusChangeHandler): void {
    this.statusChangeHandler = handler;
  }
  sendClientFrame(): void {}
  requestReconnect(): void {}
  close(): void {
    this.statusChangeHandler?.("closed", { kind: "caller" });
  }
  emitFrame(frame: WorkspaceSubscribeFileListServerFrame): void {
    this.serverFrameHandler?.(frame, null);
  }
}

class MockWsStreamClient extends WsStreamClient<HostStreamRpcRegistry> {
  readonly subscribedMethods: string[] = [];
  readonly sessions: MockStreamSession[] = [];

  constructor(private readonly support: StreamMethodSupport) {
    super({
      registry: hostStreamRpcRegistry,
      endpoint: () => null,
      bearer: () => null,
      auth: null,
      webSocketFactory: {
        create: () => {
          throw new Error("MockWsStreamClient should not open a websocket");
        },
      },
      dialTimeoutMs: 1_000,
      openAckTimeoutMs: 1_000,
      pingIntervalMs: 25_000,
      pongTimeoutMs: 50_000,
      initialBackoffMs: 10,
      maxBackoffMs: 1_000,
    });
  }

  override getMethodSupport<
    Method extends keyof HostStreamRpcRegistry & string,
  >(_method: Method): StreamMethodSupport {
    return this.support;
  }

  override subscribe<Method extends keyof HostStreamRpcRegistry & string>(
    method: Method,
    _params: ParamsOf<HostStreamRpcRegistry, Method>,
  ): IStreamSession {
    this.subscribedMethods.push(method);
    const session = new MockStreamSession();
    this.sessions.push(session);
    return session;
  }
}

function renderPanel(client: MockWsStreamClient): void {
  const queryClient = new QueryClient();
  const wrap = (children: ReactNode) => (
    <QueryClientProvider client={queryClient}>
      <StreamRuntimeContext.Provider value={{ wsStreamClient: client }}>
        {children}
      </StreamRuntimeContext.Provider>
    </QueryClientProvider>
  );
  render(
    wrap(
      <FileTreePanelBodyForWorkspace
        epicId="epic-1"
        tabId="tab-1"
        workspacePath={WORKSPACE_PATH}
      />,
    ),
  );
}

describe("sidebar file tree source selection", () => {
  beforeEach(() => {
    listFileTreeCalls.length = 0;
    resetPathsCalls.length = 0;
    __resetWorkspaceFileListSubscriptionsForTesting();
    useFileTreeStore.setState({ expandedPathsByScope: {} });
  });

  afterEach(() => {
    cleanup();
    __resetWorkspaceFileListSubscriptionsForTesting();
    useFileTreeStore.setState({ expandedPathsByScope: {} });
  });

  it("builds the tree from the live stream and leaves the unary path disabled", async () => {
    const client = new MockWsStreamClient("unknown");
    renderPanel(client);

    expect(client.subscribedMethods).toEqual(["workspace.subscribeFileList"]);
    expect(listFileTreeCalls.at(-1)?.enabled).toBe(false);

    act(() => {
      client.sessions[0].emitFrame({
        kind: "listing",
        directoryPath: "",
        entries: [
          { path: "live.md", name: "live.md", kind: "file", ignored: false },
        ],
        truncated: false,
        hasBinaryPayload: false,
      });
    });

    await waitFor(() => {
      expect(resetPathsCalls.at(-1)).toEqual(["live.md"]);
    });
  });

  it("falls back to the unary snapshot when the host rejects the method", async () => {
    // What an older host produces: the client-side compatibility mirror marks
    // the method unsupported at handshake and closes that session.
    const client = new MockWsStreamClient("unsupported");
    renderPanel(client);

    expect(client.subscribedMethods).toEqual([]);
    expect(listFileTreeCalls.at(-1)?.enabled).toBe(true);
    await waitFor(() => {
      expect(resetPathsCalls.at(-1)).toEqual(["unary.md"]);
    });
  });
});
