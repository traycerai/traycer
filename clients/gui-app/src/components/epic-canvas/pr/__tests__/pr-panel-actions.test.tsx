import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import type {
  PrLightItem,
  PrSubscribeListForEpicServerFrame,
} from "@traycer/protocol/host/pr-schemas";
import type {
  IStreamSession,
  ServerFrameHandler,
  StatusChangeHandler,
  StreamFrameEnvelope,
  StreamCloseReason,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import {
  hostStreamRpcRegistry,
  type HostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import {
  WsStreamClient,
  type ParamsOf,
} from "@traycer-clients/shared/host-transport/ws-stream-client";
import { StreamRuntimeContext } from "@/lib/host/stream-runtime-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "host1",
}));

import { PrPanelActions } from "@/components/epic-canvas/pr/pr-panel-actions";

/**
 * Mirrors `pr-panel-body.test.tsx`'s mock session/client - the list
 * subscription is the only external boundary either component depends on.
 */
class MockStreamSession implements IStreamSession {
  private serverFrameHandler: ServerFrameHandler | null = null;
  private statusChangeHandler: StatusChangeHandler | null = null;
  closed: boolean = false;

  onServerFrame(handler: ServerFrameHandler): void {
    this.serverFrameHandler = handler;
  }

  onStatusChange(handler: StatusChangeHandler): void {
    this.statusChangeHandler = handler;
  }

  sendClientFrame(
    _envelope: StreamFrameEnvelope,
    _binaryPayload: Uint8Array | null,
  ): void {
    // No-op for this test.
  }

  requestReconnect(): void {
    // No-op for this test; reconnect is owned by the real StreamSession.
  }

  close(): void {
    this.closed = true;
    this.statusChangeHandler?.("closed", { kind: "caller" });
  }

  emitFrame(frame: PrSubscribeListForEpicServerFrame): void {
    if (this.serverFrameHandler !== null) {
      const handler = this.serverFrameHandler;
      const envelope = { ...frame } satisfies StreamFrameEnvelope;
      handler(envelope, null);
    }
  }

  emitStatus(
    status: "connecting" | "open" | "reconnecting" | "closed",
    reason: StreamCloseReason | null,
  ): void {
    this.statusChangeHandler?.(status, reason);
  }
}

class MockWsStreamClient extends WsStreamClient<HostStreamRpcRegistry> {
  sessions: Map<string, MockStreamSession> = new Map();
  subscribeCallCount: number = 0;

  constructor() {
    super({
      registry: hostStreamRpcRegistry,
      endpoint: () => null,
      bearer: () => null,
      auth: null,
      hostCredentialMint: null,
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
    method: Method,
    params: ParamsOf<HostStreamRpcRegistry, Method>,
  ): IStreamSession {
    this.subscribeCallCount += 1;
    const key = JSON.stringify({ method, params });

    if (!this.sessions.has(key)) {
      this.sessions.set(key, new MockStreamSession());
    }

    const session = this.sessions.get(key);
    if (session === undefined) {
      throw new Error("Session not found");
    }
    return session;
  }

  getSession(method: string, params: unknown): MockStreamSession | undefined {
    const key = JSON.stringify({ method, params });
    return this.sessions.get(key);
  }
}

function buildPrItem(overrides: Partial<PrLightItem>): PrLightItem {
  return {
    githubHost: null,
    base: null,
    prUrl: null,
    state: "open",
    liveness: "live",
    observedAt: null,
    isDraft: false,
    title: "Test PR",
    baseRefName: "main",
    headRefName: "feature/test",
    additions: 10,
    deletions: 2,
    checksRollup: null,
    reviewDecision: null,
    commentCount: 0,
    updatedAt: 1_000,
    repoIdentifier: { owner: "acme", repo: "widgets" },
    repoRole: "superproject",
    linkGroupKey: null,
    owners: [],
    ...overrides,
  };
}

function resetCanvas(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
}

describe("PrPanelActions staleness hint", () => {
  let queryClient: QueryClient;
  let mockWsStreamClient: MockWsStreamClient;

  const renderActions = (props: { epicId: string; tabId: string }) => {
    return render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <StreamRuntimeContext.Provider
            value={{ wsStreamClient: mockWsStreamClient }}
          >
            <PrPanelActions
              epicId={props.epicId}
              tabId={props.tabId}
              collapsed={false}
            />
          </StreamRuntimeContext.Provider>
        </TooltipProvider>
      </QueryClientProvider>,
    );
  };

  const emitSnapshot = async (
    epicId: string,
    items: readonly PrLightItem[],
  ): Promise<MockStreamSession> => {
    await waitFor(() => {
      expect(mockWsStreamClient.subscribeCallCount).toBe(1);
    });
    const session = mockWsStreamClient.getSession("pr.subscribeListForEpic", {
      epicId,
      mode: "foreground",
    });
    expect(session).toBeDefined();
    if (session === undefined) throw new Error("missing list session");
    session.emitFrame({
      kind: "snapshot",
      hasBinaryPayload: false,
      sourceStatus: "ok",
      notice: null,
      items: [...items],
    });
    return session;
  };

  beforeEach(() => {
    resetCanvas();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mockWsStreamClient = new MockWsStreamClient();
  });

  afterEach(() => {
    cleanup();
    resetCanvas();
    queryClient.clear();
  });

  it("says 'Not yet fetched' when the subscription has data but no PR has ever been observed", async () => {
    const epicId = "epic-never-fetched";
    renderActions({ epicId, tabId: "tab-nf" });
    // A snapshot with items whose `observedAt` is all null - the host has
    // discovered the PRs but never successfully swept any of them.
    await emitSnapshot(epicId, [buildPrItem({ observedAt: null })]);

    const hint = await screen.findByTestId("pr-panel-staleness");
    expect(hint.textContent).toBe("Not yet fetched");
  });

  it("says 'Updated …' once at least one PR carries a real observedAt", async () => {
    const epicId = "epic-fetched";
    renderActions({ epicId, tabId: "tab-f" });
    await emitSnapshot(epicId, [buildPrItem({ observedAt: 1_000 })]);

    const hint = await screen.findByTestId("pr-panel-staleness");
    await waitFor(() => {
      expect(hint.textContent).not.toBe("Not yet fetched");
    });
    expect(hint.textContent).toMatch(/^Updated /);
  });
});
