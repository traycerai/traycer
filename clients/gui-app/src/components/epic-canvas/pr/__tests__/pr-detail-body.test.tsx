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
  PrReviewThreadsSection,
  PrChecksSection,
  PrCommitsSection,
  PrDetailCore,
  PrFilesSection,
  PrLiveness,
  PrSourceNotice,
  PrSourceStatus,
  PrSubscribeDetailServerFrame,
} from "@traycer/protocol/host/pr-schemas";
import { MockWsStreamClient as SharedMockWsStreamClient } from "@/components/epic-canvas/pr/__tests__/pr-stream-test-fixtures";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { WsStreamClient } from "@traycer-clients/shared/host-transport/ws-stream-client";
import { readComposerDraftSnapshot } from "@/stores/composer/composer-draft-store";

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
  // Added when the PR detail spinner became a BOUNDED load (invariant 6):
  // past its budget it renders `TileHostLoadState`, whose Report-issue action
  // reaches the barrel's `useHostBinding`. `null` is the production shape for
  // "no binding", which that surface already handles.
  useHostBinding: () => null,
  useHostDirectory: () => ({
    onChange: () => ({ dispose() {} }),
    findById: () => null,
  }),
  useAuthService: () => ({
    revalidateCurrentContext: () => Promise.resolve({ kind: "valid" as const }),
  }),
  // The Files tab reads the local diff over unary RPC. `null` is the
  // production shape for "no client yet", which the query's own guard turns
  // into an error and the tab renders as the GitHub file list - the fallback
  // these tests already assert nothing about. `PrDetailFilesTab` has its own
  // file for the diff/stale/unavailable states.
  useHostClient: () => null,
  // The SPINE, a separate export since redesign P2.1.
  useHostRuntimeClient: () => null,
}));

vi.mock("@/lib/epic-selectors", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/epic-selectors")>()),
  useChatById: () => null,
  useEpicTerminalAgent: () => null,
  // The quote-target picker enumerates the epic's chats and terminal agents.
  // Both selectors reach the same `useOpenEpicHandle()` chain the two above do,
  // so they are stubbed for the same reason: that per-epic Y.doc is unrelated
  // to the PR-detail behaviour under test.
  useEpicChatRecords: () => chatRecordsRef.value,
  useEpicTerminalAgentRecords: () => EMPTY_EPIC_RECORDS,
}));

vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => tileNavigationMock,
}));

/** Stable identity: a fresh `[]` each call would re-run every dependent memo. */
const EMPTY_EPIC_RECORDS: readonly never[] = [];

/**
 * Per-test chat fixtures. Hoisted and mutable because the selector mock is
 * module-level, and the default has to stay EMPTY: most tests here assert on a
 * PR with no owners, where having nothing to send to is the honest state.
 */
const chatRecordsRef = vi.hoisted(() => ({
  value: [] as ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly updatedAt: number;
  }>,
}));

/**
 * Structurally typed on the two fields the assertions read, rather than on
 * `EpicCanvasTileRef` - the ref union's other members would force a cast at the
 * call-site read, and the point of the test is which id and kind got opened.
 */
const tileNavigationMock = vi.hoisted(() => ({
  openTileInTab: vi.fn(
    (_tabId: string, _node: { readonly id: string; readonly type: string }) =>
      null,
  ),
  openTilePreviewInTab: vi.fn(() => null),
  openTileInEpic: vi.fn(() => null),
  openTilePreviewInEpic: vi.fn(() => null),
}));

import { PrDetailBody } from "@/components/epic-canvas/pr/pr-detail-body";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { prQueryKeys } from "@/lib/query-keys/pr-query-keys";
import {
  __resetPrDetailSubscriptionsForTesting,
  type PrDetailSubscriptionData,
} from "@/hooks/pr/use-pr-detail-subscription";

type MockWsStreamClient =
  SharedMockWsStreamClient<PrSubscribeDetailServerFrame>;
// Instantiation expression: binds the shared generic class to THIS
// suite's frame type, so `new MockWsStreamClient()` needs no argument.
const MockWsStreamClient =
  SharedMockWsStreamClient<PrSubscribeDetailServerFrame>;

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
    repoRole: "superproject",
    linkGroupKey: "/tmp/worktrees/widgets",
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

function buildPrReviewThreadsSection(
  overrides: Partial<PrReviewThreadsSection>,
): PrReviewThreadsSection {
  return {
    observedAt: 1_000,
    threads: [],
    isTruncated: false,
    ...overrides,
  };
}

function buildPrDetailFrame(
  overrides: Partial<{
    readonly kind: "snapshot" | "updated";
    readonly sourceStatus: PrSourceStatus;
    readonly notice: PrSourceNotice | null;
    readonly liveness: PrLiveness;
    readonly core: Partial<PrDetailCore>;
    readonly checks: Partial<PrChecksSection>;
    readonly activity: Partial<PrActivitySection>;
    readonly reviewThreads: Partial<PrReviewThreadsSection>;
    readonly files: Partial<PrFilesSection>;
    readonly commits: Partial<PrCommitsSection>;
  }>,
): PrSubscribeDetailServerFrame {
  return {
    kind: overrides.kind ?? "snapshot",
    hasBinaryPayload: false,
    sourceStatus: overrides.sourceStatus ?? "ok",
    notice: overrides.notice ?? null,
    liveness: overrides.liveness ?? "live",
    core: buildPrDetailCore(overrides.core ?? {}),
    checks: buildPrChecksSection(overrides.checks ?? {}),
    activity: buildPrActivitySection(overrides.activity ?? {}),
    reviewThreads: buildPrReviewThreadsSection(overrides.reviewThreads ?? {}),
    files: buildPrFilesSection(overrides.files ?? {}),
    commits: buildPrCommitsSection(overrides.commits ?? {}),
  };
}

function buildPrDetailSubscriptionData(
  overrides: Partial<{
    readonly sourceStatus: PrSourceStatus;
    readonly notice: PrSourceNotice | null;
    readonly liveness: PrLiveness;
    readonly core: Partial<PrDetailCore>;
    readonly checks: Partial<PrChecksSection>;
    readonly activity: Partial<PrActivitySection>;
    readonly reviewThreads: Partial<PrReviewThreadsSection>;
    readonly files: Partial<PrFilesSection>;
    readonly commits: Partial<PrCommitsSection>;
  }>,
): PrDetailSubscriptionData {
  return {
    sourceStatus: overrides.sourceStatus ?? "ok",
    notice: overrides.notice ?? null,
    liveness: overrides.liveness ?? "live",
    core: buildPrDetailCore(overrides.core ?? {}),
    checks: buildPrChecksSection(overrides.checks ?? {}),
    activity: buildPrActivitySection(overrides.activity ?? {}),
    reviewThreads: buildPrReviewThreadsSection(overrides.reviewThreads ?? {}),
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
            viewTabId="tab-1"
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
    chatRecordsRef.value = [];
    tileNavigationMock.openTileInTab.mockClear();
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

  it("leads Overview with the attention queue and routes files, commits and comments to their own tabs, all in one reading column", async () => {
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

    // Overview leads with the attention queue, not the description: the first
    // question a PR has to answer is whether it can land.
    expect(screen.getByTestId("pr-detail-queue")).toBeTruthy();
    expect(screen.getByTestId("pr-detail-description-section")).toBeTruthy();
    // Reference material is behind its tab, so Overview stays one screen.
    expect(screen.queryByTestId("pr-detail-files")).toBeNull();
    expect(screen.queryByTestId("pr-detail-commit-item")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: /Files/ }));
    expect(screen.getByTestId("pr-detail-files")).toBeTruthy();
    expect(screen.getByText("src/app.ts")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: /Commits/ }));
    const commit = screen.getByTestId("pr-detail-commit-item");
    expect(commit.textContent).toContain("feat: first commit");
    expect(commit.textContent).toContain("abcdef1");
    // Commits carries commits only; the comment belongs to Feedback.
    expect(screen.queryByTestId("pr-detail-activity-item")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: /Feedback/ }));
    expect(screen.getByTestId("pr-detail-activity-item").textContent).toContain(
      "later comment",
    );
    expect(screen.queryByTestId("pr-detail-commit-item")).toBeNull();
  });

  it("pins the title and the tab strip, and lets the meta lines scroll away", async () => {
    // Scrolling a 300-file diff, the two things a reader keeps reaching for
    // are "which PR is this" and "which section" - and only those. The author,
    // branch flow and freshness lines are read once on open, so spending four
    // lines of every viewport on them would be the wrong trade.
    renderBody({
      epicId: "epic-sticky",
      githubHost: "github.com",
      owner: "acme",
      repo: "widgets",
      prNumber: 21,
      isActive: true,
    });
    await waitFor(() => {
      expect(mockWsStreamClient.subscribeCallCount).toBe(1);
    });
    const session = mockWsStreamClient.getSession("pr.subscribeDetail", {
      epicId: "epic-sticky",
      githubHost: "github.com",
      owner: "acme",
      repo: "widgets",
      prNumber: 21,
    });
    expect(session).toBeDefined();
    if (session === undefined) return;
    session.emitFrame(
      buildPrDetailFrame({
        core: { base: { owner: "acme", repo: "widgets", prNumber: 21 } },
      }),
    );
    await screen.findByTestId("pr-detail-body");

    const bar = screen.getByTestId("pr-detail-sticky-bar");
    expect(bar.className).toContain("sticky");
    expect(bar.className).toContain("top-0");
    // A transparent sticky bar lets content scroll visibly through it.
    expect(bar.className).toContain("bg-canvas");

    // Every pinned thing lives INSIDE the one bar, so the strip needs no
    // hard-coded offset for a title that can wrap.
    expect(bar.contains(screen.getByTestId("pr-detail-tabs"))).toBe(true);
    // The merge line stays pinned too: the base branch is what every hunk in
    // the diff below is being compared against.
    expect(bar.contains(screen.getByTestId("pr-detail-merge-line"))).toBe(true);
    // ...while the reference lines are not in the bar at all - the diffstat,
    // comment count and freshness moved into the always-visible context card,
    // because a pinned bar has to earn every line it spends and those are
    // consulted once rather than re-read while scrolling.
    expect(bar.textContent).not.toContain("comment");
    expect(screen.queryByTestId("pr-detail-header-meta")).toBeNull();
  });

  it("keeps one reading column across every tab, so switching tabs never re-lays-out the document", async () => {
    renderBody({
      epicId: "epic-4",
      githubHost: "github.com",
      owner: "acme",
      repo: "widgets",
      prNumber: 11,
      isActive: true,
    });
    await waitFor(() => {
      expect(mockWsStreamClient.subscribeCallCount).toBe(1);
    });
    const session = mockWsStreamClient.getSession("pr.subscribeDetail", {
      epicId: "epic-4",
      githubHost: "github.com",
      owner: "acme",
      repo: "widgets",
      prNumber: 11,
    });
    expect(session).toBeDefined();
    if (session === undefined) return;

    session.emitFrame(
      buildPrDetailFrame({
        core: { base: { owner: "acme", repo: "widgets", prNumber: 11 } },
      }),
    );
    await screen.findByTestId("pr-detail-body");

    // Files and Checks used to opt into a full-bleed container and shift the
    // whole document sideways on every tab switch.
    const shellClasses = (): string =>
      screen.getByTestId("pr-detail-shell").className;
    const overview = shellClasses();
    expect(overview).toContain("max-w-3xl");

    // Driven by ROLE: the switch is the user-facing interaction, so it should
    // go through the accessible name. `getByTestId` stays for the class
    // assertions below, which have no role to hang off.
    for (const tab of [/Feedback/, /Files/, /Checks/, /Commits/] as const) {
      fireEvent.click(screen.getByRole("tab", { name: tab }));
      expect(shellClasses()).toBe(overview);
    }

    // jsdom does not evaluate container queries, so the card renders here
    // whatever the threshold is. What IS checkable is the threshold itself -
    // and that is the thing that broke twice. It was derived from the column
    // width alone (1520, then 1400) and both times landed at or above the
    // ~1400px a maximised window with the PR panel open actually measures, so
    // the card never appeared once. This ceiling is not arithmetic; it is the
    // observation, and it is what the arithmetic has to come in under.
    const card = screen.getByTestId("pr-detail-card-gutter");
    const threshold = /@min-\[(\d+)px\]/.exec(card.className)?.[1] ?? null;
    expect(threshold).not.toBeNull();
    expect(Number(threshold)).toBeLessThanOrEqual(1300);

    // The card and the shell's wider cap are one switch. If the card appears
    // without the extra width the row squeezes the prose; if the width appears
    // without the card the measure just gets too long. Neither throws.
    const shellThreshold =
      /@min-\[(\d+)px\]:max-w-/.exec(overview)?.[1] ?? null;
    expect(shellThreshold).toBe(threshold);
  });

  it("caps the card's width fluidly instead of forcing a bare fixed width", async () => {
    // `shrink-0` alone made this a hard-coded 18rem regardless of how much
    // room the flex row actually had. `w-full max-w-[min(24vw,18rem)]` lets
    // the item size down to whatever space remains rather than overflowing
    // it, and pairs the rem ceiling with a viewport term so the cap is not a
    // fixed layout dimension.
    renderBody({
      epicId: "epic-width",
      githubHost: "github.com",
      owner: "acme",
      repo: "widgets",
      prNumber: 31,
      isActive: true,
    });
    await waitFor(() => {
      expect(mockWsStreamClient.subscribeCallCount).toBe(1);
    });
    const session = mockWsStreamClient.getSession("pr.subscribeDetail", {
      epicId: "epic-width",
      githubHost: "github.com",
      owner: "acme",
      repo: "widgets",
      prNumber: 31,
    });
    expect(session).toBeDefined();
    if (session === undefined) return;
    session.emitFrame(
      buildPrDetailFrame({
        core: { base: { owner: "acme", repo: "widgets", prNumber: 31 } },
      }),
    );
    await screen.findByTestId("pr-detail-body");

    const gutterClasses = screen.getByTestId("pr-detail-card-gutter").className;
    expect(gutterClasses).toContain("w-full");
    expect(gutterClasses).toContain("max-w-[min(24vw,18rem)]");
    // The ceiling must stay a MAX, never a fixed width, and must keep its
    // viewport term rather than regressing to a bare rem cap.
    expect(gutterClasses).not.toMatch(/(?<!max-)w-\[min\(24vw,18rem\)\]/);
    expect(gutterClasses).not.toContain("max-w-[18rem]");
  });

  it("gives the active tab's content a tabpanel wired back to its tab button", async () => {
    renderBody({
      epicId: "epic-tabpanel",
      githubHost: "github.com",
      owner: "acme",
      repo: "widgets",
      prNumber: 41,
      isActive: true,
    });
    await waitFor(() => {
      expect(mockWsStreamClient.subscribeCallCount).toBe(1);
    });
    const session = mockWsStreamClient.getSession("pr.subscribeDetail", {
      epicId: "epic-tabpanel",
      githubHost: "github.com",
      owner: "acme",
      repo: "widgets",
      prNumber: 41,
    });
    expect(session).toBeDefined();
    if (session === undefined) return;
    session.emitFrame(
      buildPrDetailFrame({
        core: { base: { owner: "acme", repo: "widgets", prNumber: 41 } },
      }),
    );
    await screen.findByTestId("pr-detail-body");

    const panel = screen.getByRole("tabpanel");
    expect(panel.id).toBe("pr-detail-tabpanel-overview");
    expect(panel.getAttribute("aria-labelledby")).toBe(
      "pr-detail-tab-trigger-overview",
    );

    // Regex, not an exact string: a tab's accessible name also carries its
    // count badge (e.g. "Files 324"), which is deliberately not aria-hidden.
    fireEvent.click(screen.getByRole("tab", { name: /Files/ }));
    const filesPanel = screen.getByRole("tabpanel");
    expect(filesPanel.id).toBe("pr-detail-tabpanel-files");
    expect(filesPanel.getAttribute("aria-labelledby")).toBe(
      "pr-detail-tab-trigger-files",
    );
    expect(
      document
        .getElementById("pr-detail-tab-trigger-files")
        ?.getAttribute("aria-controls"),
    ).toBe(filesPanel.id);
  });

  it("Fix in chat quotes the failing CHECK, not the generic PR overview", async () => {
    // The queue keys check rows on `prCheckContextKey(context, index)`, which
    // is the details URL when there is one. Matching on `entry.name` instead
    // never hit, so every "Fix in chat" silently pasted the overview quote and
    // the reader lost the one fact they asked for - which check failed.
    chatRecordsRef.value = [
      { id: "chat-9", title: "Technical Support Inquiry", updatedAt: 5_000 },
    ];
    renderBody({
      epicId: "epic-9",
      githubHost: "github.com",
      owner: "acme",
      repo: "widgets",
      prNumber: 21,
      isActive: true,
    });
    await waitFor(() => {
      expect(mockWsStreamClient.subscribeCallCount).toBe(1);
    });
    const session = mockWsStreamClient.getSession("pr.subscribeDetail", {
      epicId: "epic-9",
      githubHost: "github.com",
      owner: "acme",
      repo: "widgets",
      prNumber: 21,
    });
    expect(session).toBeDefined();
    if (session === undefined) return;

    session.emitFrame(
      buildPrDetailFrame({
        core: { base: { owner: "acme", repo: "widgets", prNumber: 21 } },
        checks: {
          contexts: [
            {
              name: "pre-commit",
              workflowName: "Run Pre-commit",
              event: "pull_request",
              appName: "GitHub Actions",
              appLogoUrl: null,
              description: null,
              status: "completed",
              conclusion: "failure",
              detailsUrl: "https://ci/pre-commit",
            },
          ],
        },
      }),
    );
    await screen.findByTestId("pr-detail-queue");

    fireEvent.click(screen.getByTestId("pr-detail-queue-send"));

    const draft = JSON.stringify(readComposerDraftSnapshot("chat-9").content);
    // The COMPOSED name, exactly as the Checks tab shows it. `pre-commit`
    // alone is the job name, which a reusable workflow reports identically
    // for every job it runs - the agent receiving this quote would have no
    // way to tell which of them failed.
    expect(draft).toContain("check Run Pre-commit / pre-commit (pull_request)");
    expect(draft).toContain("https://ci/pre-commit");
  });

  it("Fix in chat reveals the chat it wrote the quote into, so a correct send cannot look like a dead button", async () => {
    chatRecordsRef.value = [
      { id: "chat-7", title: "Technical Support Inquiry", updatedAt: 5_000 },
    ];
    renderBody({
      epicId: "epic-6",
      githubHost: "github.com",
      owner: "acme",
      repo: "widgets",
      prNumber: 13,
      isActive: true,
    });
    await waitFor(() => {
      expect(mockWsStreamClient.subscribeCallCount).toBe(1);
    });
    const session = mockWsStreamClient.getSession("pr.subscribeDetail", {
      epicId: "epic-6",
      githubHost: "github.com",
      owner: "acme",
      repo: "widgets",
      prNumber: 13,
    });
    expect(session).toBeDefined();
    if (session === undefined) return;

    session.emitFrame(
      buildPrDetailFrame({
        core: { base: { owner: "acme", repo: "widgets", prNumber: 13 } },
        checks: {
          contexts: [
            {
              name: "pre-commit",
              workflowName: "Run Pre-commit",
              event: "pull_request",
              appName: "GitHub Actions",
              appLogoUrl: null,
              description: null,
              status: "completed",
              conclusion: "failure",
              detailsUrl: "https://ci/pre-commit",
            },
          ],
        },
      }),
    );
    await screen.findByTestId("pr-detail-queue");

    const fix = screen.getByTestId("pr-detail-queue-send");
    // The reported symptom was "the button is disabled". It never was - it
    // wrote to a composer draft the reader could not see.
    expect(fix.hasAttribute("disabled")).toBe(false);

    fireEvent.click(fix);
    expect(tileNavigationMock.openTileInTab).toHaveBeenCalledTimes(1);
    const [tabId, node] = tileNavigationMock.openTileInTab.mock.calls[0];
    expect(tabId).toBe("tab-1");
    expect(node.id).toBe("chat-7");
    expect(node.type).toBe("chat");

    // The passive quote glyphs must NOT navigate - they are for stacking
    // context before you go, and yanking the tab away mid-collection is its
    // own bug.
    fireEvent.click(screen.getByTestId("pr-detail-description-quote"));
    expect(tileNavigationMock.openTileInTab).toHaveBeenCalledTimes(1);
  });
});
