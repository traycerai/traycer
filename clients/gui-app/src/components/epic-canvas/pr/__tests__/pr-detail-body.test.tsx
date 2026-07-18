import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  PrActivitySection,
  PrChecksSection,
  PrCommitsSection,
  PrDetailCore,
  PrFilesSection,
  PrLiveness,
  PrSourceStatus,
  PrSubscribeDetailServerFrame,
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

/**
 * `PrDetailBody` component-level tests - (b) GHES/unknown-host cache-only
 * zero-live-churn, and (c) warm-cache reopen paints before first live frame.
 *
 * `usePrDetailSubscription` resolves its transport via `useTabHostId()` ->
 * `useHostStreamClientFor` (NOT the app-wide default-host
 * `StreamRuntimeContext`), so this file wraps `PrDetailBody` in a real
 * `<TabHostProvider>` and mocks `useHostStreamClientFor` directly, mirroring
 * `pr-panel-body.test.tsx`'s "fake only the WS transport" convention for the
 * list stream. `@/lib/host` is mocked too - `usePrDetailSubscription` calls
 * `useHostDirectoryEntry` / `useStreamAuthRevalidator` directly, and both
 * need a `HostRuntimeContext` provider in production; their return values
 * are discarded since `useHostStreamClientFor` ignores its args here.
 *
 * `PrDetailSidebar` renders `PrOwnerLabel`, which unconditionally calls
 * `useChatById` / `useEpicTerminalAgent` (rules-of-hooks - the id argument
 * gates only which one resolves a record, not whether the hook itself
 * runs). Both read `useEpicStore()` -> `useOpenEpicHandle()`, which throws
 * outside `<EpicSessionProvider>`. That per-Epic Y.doc chain is unrelated to
 * PR-detail behavior under test here (every fixture's `owners` is empty),
 * so it is stubbed the same way `pr-panel-body.test.tsx` stubs it for
 * `PrListRow`'s identical dependency - `importActual` keeps every other
 * selector in the module real.
 */

const wsStreamClientRef = vi.hoisted(() => ({
  value: null as WsStreamClient<HostStreamRpcRegistry> | null,
}));

vi.mock("@/hooks/host/use-host-stream-client-for", () => ({
  useHostStreamClientFor: () => wsStreamClientRef.value,
}));

vi.mock("@/lib/host", () => ({
  useHostDirectory: () => ({
    onChange: () => ({ dispose() {} }),
    findById: () => null,
  }),
  useAuthService: () => ({
    revalidateCurrentContext: () => Promise.resolve({ kind: "valid" as const }),
  }),
}));

vi.mock("@/lib/epic-selectors", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/epic-selectors")>()),
  useChatById: () => null,
  useEpicTerminalAgent: () => null,
}));

import { PrDetailBody } from "@/components/epic-canvas/pr/pr-detail-body";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { prQueryKeys } from "@/lib/query-keys/pr-query-keys";
import {
  __resetPrDetailSubscriptionsForTesting,
  type PrDetailSubscriptionData,
} from "@/hooks/pr/use-pr-detail-subscription";

class MockStreamSession implements IStreamSession {
  private serverFrameHandler: ServerFrameHandler | null = null;
  private statusChangeHandler: StatusChangeHandler | null = null;
  closed: boolean = false;
  sentClientFrames: StreamFrameEnvelope[] = [];

  onServerFrame(handler: ServerFrameHandler): void {
    this.serverFrameHandler = handler;
  }

  onStatusChange(handler: StatusChangeHandler): void {
    this.statusChangeHandler = handler;
  }

  sendClientFrame(
    envelope: StreamFrameEnvelope,
    _binaryPayload: Uint8Array | null,
  ): void {
    this.sentClientFrames.push(envelope);
  }

  close(): void {
    this.closed = true;
    this.statusChangeHandler?.("closed", { kind: "caller" });
  }

  emitFrame(frame: PrSubscribeDetailServerFrame): void {
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

function buildPrDetailCore(overrides: Partial<PrDetailCore>): PrDetailCore {
  return {
    observedAt: 1_000,
    githubHost: "ghes.example.com",
    base: { owner: "acme", repo: "widgets", prNumber: 7 },
    prUrl: "https://ghes.example.com/acme/widgets/pull/7",
    state: "open",
    isDraft: false,
    title: "Add feature X",
    body: "Some description",
    author: { login: "octocat", avatarUrl: null },
    baseRefName: "main",
    headRefName: "feature/x",
    headRefOid: "abc123",
    additions: 10,
    deletions: 2,
    checksRollup: { success: 1, failure: 0, pending: 0, total: 1 },
    reviewDecision: null,
    reviewRequests: [],
    commentCount: 0,
    updatedAt: 1_000,
    mergedAt: null,
    repoIdentifier: { owner: "acme", repo: "widgets" },
    owners: [],
    ...overrides,
  };
}

function buildPrChecksSection(
  overrides: Partial<PrChecksSection>,
): PrChecksSection {
  return {
    observedAt: 1_000,
    contexts: [],
    isTruncated: false,
    ...overrides,
  };
}

function buildPrActivitySection(
  overrides: Partial<PrActivitySection>,
): PrActivitySection {
  return {
    observedAt: 1_000,
    items: [],
    isTruncated: false,
    ...overrides,
  };
}

function buildPrFilesSection(
  overrides: Partial<PrFilesSection>,
): PrFilesSection {
  return {
    observedAt: 1_000,
    files: [],
    totalCount: null,
    isTruncated: false,
    ...overrides,
  };
}

function buildPrCommitsSection(
  overrides: Partial<PrCommitsSection>,
): PrCommitsSection {
  return {
    observedAt: 1_000,
    commits: [],
    totalCount: null,
    isTruncated: false,
    ...overrides,
  };
}

function buildPrDetailFrame(
  overrides: Partial<{
    readonly kind: "snapshot" | "updated";
    readonly sourceStatus: PrSourceStatus;
    readonly liveness: PrLiveness;
    readonly core: Partial<PrDetailCore>;
    readonly checks: Partial<PrChecksSection>;
    readonly activity: Partial<PrActivitySection>;
    readonly files: Partial<PrFilesSection>;
    readonly commits: Partial<PrCommitsSection>;
  }>,
): PrSubscribeDetailServerFrame {
  return {
    kind: overrides.kind ?? "snapshot",
    hasBinaryPayload: false,
    sourceStatus: overrides.sourceStatus ?? "ok",
    liveness: overrides.liveness ?? "live",
    core: buildPrDetailCore(overrides.core ?? {}),
    checks: buildPrChecksSection(overrides.checks ?? {}),
    activity: buildPrActivitySection(overrides.activity ?? {}),
    files: buildPrFilesSection(overrides.files ?? {}),
    commits: buildPrCommitsSection(overrides.commits ?? {}),
  };
}

function buildPrDetailSubscriptionData(
  overrides: Partial<{
    readonly sourceStatus: PrSourceStatus;
    readonly liveness: PrLiveness;
    readonly core: Partial<PrDetailCore>;
    readonly checks: Partial<PrChecksSection>;
    readonly activity: Partial<PrActivitySection>;
    readonly files: Partial<PrFilesSection>;
    readonly commits: Partial<PrCommitsSection>;
  }>,
): PrDetailSubscriptionData {
  return {
    sourceStatus: overrides.sourceStatus ?? "ok",
    liveness: overrides.liveness ?? "live",
    core: buildPrDetailCore(overrides.core ?? {}),
    checks: buildPrChecksSection(overrides.checks ?? {}),
    activity: buildPrActivitySection(overrides.activity ?? {}),
    files: buildPrFilesSection(overrides.files ?? {}),
    commits: buildPrCommitsSection(overrides.commits ?? {}),
  };
}

describe("PrDetailBody", () => {
  let queryClient: QueryClient;
  let mockWsStreamClient: MockWsStreamClient;

  const renderBody = (props: {
    epicId: string;
    githubHost: string;
    owner: string;
    repo: string;
    prNumber: number;
    isActive: boolean;
  }) => {
    return render(
      <QueryClientProvider client={queryClient}>
        <TabHostProvider hostId="host1">
          <PrDetailBody
            epicId={props.epicId}
            githubHost={props.githubHost}
            owner={props.owner}
            repo={props.repo}
            prNumber={props.prNumber}
            isActive={props.isActive}
          />
        </TabHostProvider>
      </QueryClientProvider>,
    );
  };

  beforeEach(() => {
    __resetPrDetailSubscriptionsForTesting();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mockWsStreamClient = new MockWsStreamClient();
    wsStreamClientRef.value = mockWsStreamClient;
  });

  afterEach(() => {
    cleanup();
    __resetPrDetailSubscriptionsForTesting();
    queryClient.clear();
    wsStreamClientRef.value = null;
  });

  it("(b) GHES/unknown-host cache-only PR shows Not live, refresh sends exactly one client frame with zero new subscribe calls, and a cache-only re-emit updates content without a new subscribe", async () => {
    renderBody({
      epicId: "epic-1",
      githubHost: "ghes.example.com",
      owner: "acme",
      repo: "widgets",
      prNumber: 7,
      isActive: true,
    });

    await waitFor(() => {
      expect(mockWsStreamClient.subscribeCallCount).toBe(1);
    });
    const session = mockWsStreamClient.getSession("pr.subscribeDetail", {
      epicId: "epic-1",
      githubHost: "ghes.example.com",
      owner: "acme",
      repo: "widgets",
      prNumber: 7,
    });
    expect(session).toBeDefined();
    if (session === undefined) return;

    session.emitFrame(
      buildPrDetailFrame({
        sourceStatus: "cached",
        liveness: "cache-only",
        core: { title: "Initial title" },
      }),
    );

    await screen.findByTestId("pr-detail-body");
    expect(screen.getByTestId("pr-detail-not-live")).toBeTruthy();
    expect(screen.getByText(/Initial title/)).toBeTruthy();

    fireEvent.click(screen.getByTestId("pr-detail-refresh"));

    await waitFor(() => {
      expect(session.sentClientFrames).toHaveLength(1);
    });
    expect(session.sentClientFrames[0]).toEqual({
      kind: "refresh",
      hasBinaryPayload: false,
    });
    // Refresh reuses the existing session - it must not open a second stream.
    expect(mockWsStreamClient.subscribeCallCount).toBe(1);

    // Simulate the host's cache-only re-emit contract: the GHES/unknown-host
    // policy never runs a live sweep for this PR, it only re-serves the
    // cached facts in response to the refresh request.
    session.emitFrame(
      buildPrDetailFrame({
        kind: "updated",
        sourceStatus: "cached",
        liveness: "cache-only",
        core: { title: "Refreshed title" },
      }),
    );

    await screen.findByText(/Refreshed title/);
    expect(screen.getByTestId("pr-detail-not-live")).toBeTruthy();
    expect(mockWsStreamClient.subscribeCallCount).toBe(1);
  });

  it("(c) warm-cache reopen paints pr-detail-body immediately from the pre-seeded query cache - pr-detail-loading never appears on first paint", async () => {
    queryClient.setQueryData(
      prQueryKeys.detail({
        hostId: "host1",
        epicId: "epic-2",
        githubHost: "github.com",
        owner: "acme",
        repo: "widgets",
        prNumber: 42,
      }),
      buildPrDetailSubscriptionData({
        sourceStatus: "ok",
        liveness: "live",
        core: { title: "Warm cached title" },
      }),
    );

    renderBody({
      epicId: "epic-2",
      githubHost: "github.com",
      owner: "acme",
      repo: "widgets",
      prNumber: 42,
      isActive: true,
    });

    // First paint must already show the warm data - assert synchronously
    // right after render, before any server frame is emitted, so the
    // loading spinner is caught absent on the FIRST render rather than
    // merely absent "eventually".
    expect(screen.queryByTestId("pr-detail-loading")).toBeNull();
    expect(screen.getByTestId("pr-detail-body")).toBeTruthy();
    expect(screen.getByText(/Warm cached title/)).toBeTruthy();

    // The hook still opens its own session (it always does), but no server
    // frame has been emitted yet - the paint above came from the pre-seeded
    // cache, not a fast frame race.
    await waitFor(() => {
      expect(mockWsStreamClient.subscribeCallCount).toBe(1);
    });
    expect(screen.getByTestId("pr-detail-body")).toBeTruthy();
    expect(screen.queryByTestId("pr-detail-loading")).toBeNull();
  });

  it("renders files-changed rows and interleaves commits chronologically before later comments", async () => {
    renderBody({
      epicId: "epic-3",
      githubHost: "github.com",
      owner: "acme",
      repo: "widgets",
      prNumber: 9,
      isActive: true,
    });
    await waitFor(() => {
      expect(mockWsStreamClient.subscribeCallCount).toBe(1);
    });
    const session = mockWsStreamClient.getSession("pr.subscribeDetail", {
      epicId: "epic-3",
      githubHost: "github.com",
      owner: "acme",
      repo: "widgets",
      prNumber: 9,
    });
    expect(session).toBeDefined();
    if (session === undefined) return;

    session.emitFrame(
      buildPrDetailFrame({
        core: { base: { owner: "acme", repo: "widgets", prNumber: 9 } },
        activity: {
          items: [
            {
              kind: "comment",
              id: "c1",
              author: { login: "octocat", avatarUrl: null },
              body: "later comment",
              createdAt: 2_000,
            },
          ],
        },
        commits: {
          commits: [
            {
              oid: "abcdef1234567890",
              messageHeadline: "feat: first commit",
              author: null,
              authorName: "Git Author",
              committedAt: 1_000,
            },
          ],
          totalCount: 1,
          isTruncated: false,
        },
        files: {
          files: [
            {
              path: "src/app.ts",
              additions: 4,
              deletions: 1,
              changeType: "modified",
            },
          ],
          totalCount: 1,
          isTruncated: false,
        },
      }),
    );

    await screen.findByTestId("pr-detail-body");
    expect(screen.getByTestId("pr-detail-files")).toBeTruthy();
    expect(screen.getByText("src/app.ts")).toBeTruthy();
    const commit = screen.getByTestId("pr-detail-commit-item");
    expect(commit.textContent).toContain("feat: first commit");
    expect(commit.textContent).toContain("abcdef1");
    // The commit (committedAt 1_000) precedes the comment (createdAt 2_000).
    const timeline = screen.getByTestId("pr-detail-timeline");
    const order = [
      ...timeline.querySelectorAll(
        '[data-testid="pr-detail-commit-item"], [data-testid="pr-detail-activity-item"]',
      ),
    ].map((element) => element.getAttribute("data-testid"));
    expect(order).toEqual(["pr-detail-commit-item", "pr-detail-activity-item"]);
  });
});
