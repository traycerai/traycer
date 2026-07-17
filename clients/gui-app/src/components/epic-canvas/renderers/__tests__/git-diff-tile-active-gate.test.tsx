import "../../../../../__tests__/test-browser-apis";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { IStreamSession } from "@traycer-clients/shared/host-transport/i-stream-session";
import {
  hostStreamRpcRegistry,
  type HostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import {
  WsStreamClient,
  type ParamsOf,
} from "@traycer-clients/shared/host-transport/ws-stream-client";
import { StreamRuntimeContext } from "@/lib/host/stream-runtime-context";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { makeGitBundleDiffTile } from "@/lib/git/git-diff-tile";
import { DEFAULT_DIFF_VIEWER_PREFERENCES } from "@/lib/diff/diff-viewer-preferences";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { __resetSubscriptionsForTesting } from "@/hooks/git/use-git-list-changed-files-subscription";

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "host-A",
}));

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => ({
    status: "reachable",
    hostLabel: "Host A",
  }),
}));

vi.mock("react-virtuoso", () => ({
  Virtuoso: () => <div data-testid="virtuoso" />,
}));

vi.mock("@/hooks/editor/use-editor-open-mutation", () => ({
  useEditorOpen: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("@/hooks/git/use-git-refresh-worktree-status", () => ({
  useGitRefreshWorktreeStatus: () => ({
    mutateAsync: vi.fn(() => Promise.resolve()),
  }),
}));

import { GitDiffTile } from "../git-diff-tile";

/**
 * A stream session that just tracks whether it has been closed. Unlike the
 * shared-session fixture used by the subscription hook's own tests, this
 * mock hands back a brand-new session on every `subscribe()` call (matching
 * production `WsStreamClient` behavior) so re-activation after teardown is
 * observably a fresh, open session rather than a stale closed one.
 */
class MockStreamSession implements IStreamSession {
  closed = false;
  onServerFrame(): void {
    // No frames are emitted in this test; gating is observed purely through
    // subscribe/close call counts.
  }
  onStatusChange(): void {
    // Not exercised here.
  }
  sendClientFrame(): void {
    // Not exercised here.
  }
  close(): void {
    this.closed = true;
  }
}

class MockWsStreamClient extends WsStreamClient<HostStreamRpcRegistry> {
  readonly sessions: MockStreamSession[] = [];

  constructor() {
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

  override subscribe<Method extends keyof HostStreamRpcRegistry & string>(
    _method: Method,
    _params: ParamsOf<HostStreamRpcRegistry, Method>,
  ): IStreamSession {
    const session = new MockStreamSession();
    this.sessions.push(session);
    return session;
  }
}

const NODE = makeGitBundleDiffTile({
  hostId: "host-A",
  runningDir: "/work/repo",
  bundleGroup: "changes",
  repositoryContext: null,
});

describe("<GitDiffTile /> subscription active-gating", () => {
  let queryClient: QueryClient;
  let client: MockWsStreamClient;

  beforeEach(() => {
    __resetSubscriptionsForTesting();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    client = new MockWsStreamClient();
    useSettingsStore.setState({
      diffViewerPreferences: DEFAULT_DIFF_VIEWER_PREFERENCES,
    });
  });

  afterEach(() => {
    cleanup();
    __resetSubscriptionsForTesting();
    vi.restoreAllMocks();
  });

  it("does not open the git status stream while the tile starts inactive", () => {
    render(tileElement(queryClient, client, false));

    expect(client.sessions).toHaveLength(0);
  });

  it("opens the git status stream on activation and releases it on deactivation", async () => {
    const rendered = render(tileElement(queryClient, client, false));
    expect(client.sessions).toHaveLength(0);

    rendered.rerender(tileElement(queryClient, client, true));

    await waitFor(() => {
      expect(client.sessions).toHaveLength(1);
    });
    const firstSession = client.sessions[0];
    expect(firstSession.closed).toBe(false);

    rendered.rerender(tileElement(queryClient, client, false));

    await waitFor(() => {
      expect(firstSession.closed).toBe(true);
    });
    // Deactivation releases the session without opening a new one.
    expect(client.sessions).toHaveLength(1);

    rendered.rerender(tileElement(queryClient, client, true));

    await waitFor(() => {
      expect(client.sessions).toHaveLength(2);
    });
    const secondSession = client.sessions[1];
    expect(secondSession.closed).toBe(false);
  });
});

function tileElement(
  queryClient: QueryClient,
  wsStreamClient: MockWsStreamClient,
  isActive: boolean,
): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      <StreamRuntimeContext.Provider value={{ wsStreamClient }}>
        <TabHostProvider hostId="host-A">
          <GitDiffTile
            node={NODE}
            viewTabId="view-1"
            tileId={NODE.id}
            isActive={isActive}
          />
        </TabHostProvider>
      </StreamRuntimeContext.Provider>
    </QueryClientProvider>
  );
}
