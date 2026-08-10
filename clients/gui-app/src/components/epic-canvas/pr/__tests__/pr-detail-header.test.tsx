import { describe, it, expect, afterEach, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type {
  PrDetailCore,
  PrSourceNotice,
} from "@traycer/protocol/host/pr-schemas";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PrDetailHeader } from "@/components/epic-canvas/pr/pr-detail-header";
import { RunnerHostContext } from "@/providers/runner-host-context";

/**
 * `PrDetailHeader`'s "Open on GitHub" action - a mutation-backed `<a>` behind
 * `useRunnerOpenExternalLink`, not a plain link, since the desktop shell opens
 * it through the RunnerHost bridge rather than letting the browser navigate.
 * Regression coverage for the duplicate-request guard: a click while the
 * bridge call is still in flight must not fire a second RunnerHost request.
 */

function buildPrDetailCore(overrides: Partial<PrDetailCore>): PrDetailCore {
  return {
    observedAt: 1_000,
    githubHost: "github.com",
    base: { owner: "acme", repo: "widgets", prNumber: 7 },
    prUrl: "https://github.com/acme/widgets/pull/7",
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
    linkGroupKey: null,
    owners: [],
    ...overrides,
  };
}

function createRunnerHost(): MockRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://auth.traycer.test/sign-in",
    authnBaseUrl: "https://auth.traycer.test",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
}

function renderHeader(
  host: MockRunnerHost | null,
  notice: PrSourceNotice | null,
  observedAt: number | null,
) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostContext.Provider value={host}>
        <TooltipProvider>
          <PrDetailHeader
            core={buildPrDetailCore({})}
            epicId="epic-1"
            notLive={false}
            observedAt={observedAt}
            notice={notice}
            refreshing={false}
            onRefresh={() => undefined}
          />
        </TooltipProvider>
      </RunnerHostContext.Provider>
    </QueryClientProvider>,
  );
}

describe("PrDetailHeader source notice", () => {
  afterEach(() => {
    cleanup();
  });

  it("says nothing when the fetch layer is running normally", () => {
    // The absence of a notice is the common case, and an always-present ⓘ
    // would train the eye to ignore the one that means something.
    renderHeader(createRunnerHost(), null, 1_000);
    expect(screen.queryByTestId("pr-source-notice")).toBeNull();
  });

  it("shows the pause on the tile header, not just in the panel", () => {
    // A PR opened straight from a deep link never renders the panel, so the
    // tile has to carry the explanation itself.
    renderHeader(
      createRunnerHost(),
      {
        kind: "rate-limited",
        retryAt: null,
      },
      1_000,
    );
    expect(
      screen.getByTestId("pr-source-notice").getAttribute("data-notice-kind"),
    ).toBe("rate-limited");
  });
});

describe("PrDetailHeader staleness", () => {
  afterEach(() => {
    cleanup();
  });

  it("says 'Not yet fetched' when no PR has ever been observed - the card's own gauge is gone, this is the only freshness stamp on screen", () => {
    renderHeader(createRunnerHost(), null, null);
    expect(screen.getByTestId("pr-detail-staleness").textContent).toBe(
      "Not yet fetched",
    );
  });

  it("says 'Updated …' once a real observedAt is known", () => {
    renderHeader(createRunnerHost(), null, 1_000);
    const staleness = screen.getByTestId("pr-detail-staleness");
    expect(staleness.textContent).not.toBe("Not yet fetched");
    expect(staleness.textContent).toMatch(/^Updated /);
  });
});

describe("PrDetailHeader GitHub link", () => {
  afterEach(() => {
    cleanup();
  });

  it("does not fire a second RunnerHost request while the first open is still pending", async () => {
    const host = createRunnerHost();
    let resolveBridge: () => void = () => undefined;
    const bridge = new Promise<void>((resolve) => {
      resolveBridge = resolve;
    });
    const openExternalLink = vi
      .spyOn(host, "openExternalLink")
      .mockImplementation(() => bridge);

    renderHeader(host, null, 1_000);

    // By role + accessible name: this also pins the anchor semantics the
    // action depends on, which a test-id query would silently let regress.
    const link = screen.getByRole("link", { name: /GitHub/i });
    fireEvent.click(link);
    await screen.findByTestId("pr-detail-github-link-dots");
    expect(openExternalLink).toHaveBeenCalledTimes(1);
    expect(link.getAttribute("aria-disabled")).toBe("true");

    // A second click while the mutation is still in flight must be a no-op.
    // Flush pending microtasks/macrotasks so an (erroneous) second `mutate()`
    // call would have reached the mock by the time we assert.
    fireEvent.click(link);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(openExternalLink.mock.calls.length).toBe(1);

    await act(async () => {
      resolveBridge();
      await bridge;
    });

    await screen.findByTestId("pr-detail-github-link");
    expect(link.getAttribute("aria-disabled")).toBe("false");
  });
});
