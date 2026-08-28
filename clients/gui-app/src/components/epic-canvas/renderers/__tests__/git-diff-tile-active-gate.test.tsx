import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
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

// The tile re-provides its own `StreamRuntimeContext` for the host it is BOUND
// to, so `git.subscribeStatus` cannot ride the window's effective host while
// carrying the tile's host id as a param. `null` is that hook's FOLLOWING
// answer, so the tile falls back to the ambient binding this suite supplies -
// which is what every assertion here is about. Which transport a host resolves
// to is a different question with its own suite:
// `use-surface-host-stream-binding.test.tsx`.
// The hook returns the value to PROVIDE: the ambient binding while following
// (this suite's), the pin's own once built, null while pending. Following here.
vi.mock("@/hooks/host/use-surface-host-stream-binding", async () => {
  const { use } = await import("react");
  const { StreamRuntimeContext } =
    await import("@/lib/host/stream-runtime-context");
  return { useSurfaceHostStreamBinding: () => use(StreamRuntimeContext) };
});

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-A",
}));

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => ({
    status: "reachable",
    hostLabel: "Host A",
  }),
  resolvedHostLabel: (r: { status: string; hostLabel: string | null }) =>
    r.status === "checking" ? null : r.hostLabel,
}));

vi.mock("react-virtuoso", () => ({
  Virtuoso: () => <div data-testid="virtuoso" />,
}));

// The toolbar's "open file" now dispatches on the TAB client (D15); these tests
// mount the tile without the whole host runtime, so the seam is stubbed the
// same way the sibling git-diff-tile suites already stub it.
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));

// The tile dispatches `editor.openPaths` on its TAB client, not the app-wide
// one - `editor.openPaths` resolves paths on the host it is sent to (D15). The
// mocked hook ignores the client it is handed; what this repoint pins is that
// the tile no longer imports the app-wide `useEditorOpen` at all.
vi.mock("@/hooks/editor/use-editor-open-mutation", () => ({
  useEditorOpenForClient: () => ({
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
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";

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
  /** Never negotiates: this fake exercises no version-dependent path. */
  getNegotiatedSchemaVersion(): SchemaVersion | null {
    return null;
  }

  requestReconnect(): void {
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
      clientIdentity: TEST_CLIENT_IDENTITY,
      registry: hostStreamRpcRegistry,
      endpoint: () => null,
      bearer: () => null,
      auth: null,
      hostCredentialMint: null,
      onHostCredentialState: null,
      evidence: NO_TRANSPORT_EVIDENCE,
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
      <StreamRuntimeContext.Provider value={{ wsStreamClient, hostId: null }}>
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
