import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";

import type { HostRpcRegistry } from "@/lib/host";
import type {
  MentionFlowStep,
  MentionStepChrome,
} from "@/lib/composer/mentions";
import { useGithubMentionFilterStore } from "@/stores/composer/github-mention-filter-store";

/**
 * The section's refresh button drives BOTH reads behind the list.
 *
 * The visible rows are the catalog's merged with the live search's, and the
 * chrome's notice and banner can come from either. Wired to the catalog alone,
 * "Refresh pull requests" completed without touching a typed query's rows or
 * the search's own `gh-unavailable` status - so pressing Refresh *because* the
 * section reported GitHub was unreachable left that report standing.
 */

// Every array and callback here is HOISTED and stable. A fresh `[]` per render
// re-arms the row-publication effect, whose store write re-renders, which mints
// another `[]` - an update loop authored entirely by the harness. Same for the
// two refresh callbacks, which feed the `useCallback` the button hangs off.
const stable = vi.hoisted(() => {
  const counts = { catalog: 0, search: 0 };
  return {
    counts,
    rows: [] as ReadonlyArray<never>,
    repositories: [] as ReadonlyArray<never>,
    refreshCatalog: (): Promise<void> => {
      counts.catalog += 1;
      return Promise.resolve();
    },
    refreshSearch: (): Promise<void> => {
      counts.search += 1;
      return Promise.resolve();
    },
  };
});
const refreshes = stable.counts;

vi.mock("@/hooks/composer/use-github-mention-catalog", () => ({
  useGithubMentionCatalog: () => ({
    rows: stable.rows,
    repositories: stable.repositories,
    scopeResolved: true,
    freshnessAt: null,
    sourceStatus: "ok",
    notice: null,
    isLoading: false,
    isChecking: false,
    isPlaceholder: false,
    refreshManually: stable.refreshCatalog,
  }),
}));

vi.mock("@/hooks/composer/use-github-mention-search", () => ({
  useGithubMentionSearch: () => ({
    rows: stable.rows,
    sourceStatus: null,
    notice: null,
    isSearching: false,
    refresh: stable.refreshSearch,
  }),
}));

vi.mock("@/lib/relative-time", () => ({ useSampledNow: () => 0 }));

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: () => ({ hostId: "host-1" }),
}));

/** Mutable: method support is reactive, and that is the point of one test. */
const support = vi.hoisted(() => ({ github: true }));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: () => support.github,
}));

import { useGithubMentionSections } from "../use-github-mention-sections";

const PR_STEP: MentionFlowStep = {
  kind: "provider",
  providerId: "pull-requests",
  stepId: "pull-requests",
  workspacePath: null,
};

function renderWithRoots(query: string, mentionRoots: ReadonlyArray<string>) {
  return renderHook(() =>
    useGithubMentionSections({
      client: {} as HostClient<HostRpcRegistry>,
      active: true,
      step: PR_STEP,
      currentEpicId: "epic-1",
      mentionRoots,
      query,
      debouncedQuery: query,
      limit: 20,
    }),
  );
}

function renderSections(query: string) {
  return renderWithRoots(query, ["/repo"]);
}

beforeEach(() => {
  refreshes.catalog = 0;
  refreshes.search = 0;
  support.github = true;
  useGithubMentionFilterStore.setState(
    useGithubMentionFilterStore.getInitialState(),
    true,
  );
});

afterEach(() => {
  cleanup();
});

/** The chrome and its refresh block are both nullable; a missing one is a bug. */
function refreshOf(chrome: MentionStepChrome | null): () => Promise<void> {
  const refresh = chrome?.refresh;
  if (refresh === undefined || refresh === null) {
    throw new Error("expected the section to publish a refresh control");
  }
  return refresh.onRefresh;
}

describe("useGithubMentionSections refresh", () => {
  it("refreshes the live search as well as the catalog", async () => {
    const { result } = renderSections("auth");

    await refreshOf(result.current.chrome)();

    expect(refreshes.catalog).toBe(1);
    // The half that was missing: without it a typed query's rows and the
    // search's own status survive the refresh untouched.
    expect(refreshes.search).toBe(1);
  });

  it("still refreshes both with no query typed", async () => {
    // The search observer is disabled here and no-ops internally, so the
    // section does not need to know which reads are live - it asks both, and
    // each decides. Pinning that keeps the button from growing a condition
    // that silently skips the search in the case it is most needed.
    const { result } = renderSections("");

    await refreshOf(result.current.chrome)();

    expect(refreshes.catalog).toBe(1);
    expect(refreshes.search).toBe(1);
  });

  it("publishes no chrome once the host stops supporting the methods", () => {
    // Method support is reactive: an app-wide composer can rebind to an older
    // host, or the bound host can re-handshake after an in-place downgrade,
    // while a GitHub step is still open. The reads go quiet on their own, but
    // the chrome carries a refresh button that calls `mention.githubCatalog`
    // directly - it has to go with them.
    support.github = false;

    const { result } = renderSections("auth");

    expect(result.current.chrome).toBeNull();
  });

  it("publishes no chrome once the last folder is detached", () => {
    // An empty scope is a WIRE error rather than a quiet no-op: the request
    // schema requires `workspacePaths.min(1)`, so a surviving refresh button
    // fails validation instead of returning nothing.
    const { result } = renderWithRoots("auth", []);

    expect(result.current.chrome).toBeNull();
  });
});
