import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  MentionGithubCatalogRequest,
  MentionGithubCatalogResponse,
} from "@traycer/protocol/host/mention-schemas";

import { useGithubMentionCatalog } from "@/hooks/composer/use-github-mention-catalog";
import type { GithubMentionScope } from "@/hooks/composer/use-github-mention-catalog";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * The stale follow-up is ONE `refresh: "auto"` per (host, scope, section) per
 * menu session, and the guard that enforces it has exactly one reset edge: the
 * picker closing.
 *
 * The narrower flags cannot own that lifetime. `allowStaleFollowUp` goes false
 * every time the user steps back to the picker's root, and `enabled` goes false
 * while the OTHER section is open - so resetting on either turned one sweep per
 * session into one per re-entry - against a cache the host is still answering
 * `stale: true` for.
 */

const request = vi.fn();

/**
 * Mutable so a test can swap the bound host, or flip readiness, without
 * remounting the hook.
 */
const readiness = vi.hoisted(() => ({ hostId: "host-1", isReady: true }));

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: () => ({
    hostId: readiness.hostId,
    isReady: readiness.isReady,
  }),
}));

// `HostClient` is a class with ~40 private fields, so a structural stand-in
// cannot be asserted into it. `{} as HostClient<...>` is what this suite's
// neighbours already use; grafting on the two methods `useHostQuery` and
// `useHostMutation` call is the same stand-in with behaviour attached.
const client = Object.assign({} as HostClient<HostRpcRegistry>, {
  request,
  requestWithSignal: request,
});

function wrapper(props: { readonly children: ReactNode }): ReactNode {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
}

/** Recorded at the mock, typed - `request.mock.calls` is untyped `any[]`. */
const catalogRequests: Array<MentionGithubCatalogRequest> = [];

/** Every read answers `stale: true`, so the follow-up is always warranted. */
function alwaysStale(): void {
  request.mockImplementation(
    (
      _method: string,
      params: MentionGithubCatalogRequest,
    ): Promise<MentionGithubCatalogResponse> => {
      catalogRequests.push(params);
      return Promise.resolve({
        rows: [],
        repositories: [],
        freshnessAt: 1_000,
        stale: true,
        sourceStatus: "cached",
        notice: null,
      });
    },
  );
}

function autoSweepCount(): number {
  return catalogRequests.filter((params) => params.refresh === "auto").length;
}

const SCOPE: GithubMentionScope = {
  epicId: "epic-1",
  workspacePaths: ["/repo-a"],
};

const SCOPE_B: GithubMentionScope = {
  epicId: "epic-1",
  workspacePaths: ["/repo-b"],
};

interface CatalogProps {
  readonly enabled: boolean;
  readonly allowStaleFollowUp: boolean;
  readonly pickerActive: boolean;
  readonly scope: GithubMentionScope;
}

/** Inside the section: this read is enabled and owns the follow-up. */
const IN_SECTION: CatalogProps = {
  enabled: true,
  allowStaleFollowUp: true,
  pickerActive: true,
  scope: SCOPE,
};

/** Back at root: still read cache-only, but no longer the follow-up's owner. */
const AT_ROOT: CatalogProps = { ...IN_SECTION, allowStaleFollowUp: false };

/** The other section is open: this read is disabled, the session is not over. */
const OTHER_SECTION: CatalogProps = {
  ...IN_SECTION,
  enabled: false,
  allowStaleFollowUp: false,
};

function renderCatalog(initialProps: CatalogProps) {
  return renderHook(
    (props: CatalogProps) =>
      useGithubMentionCatalog({
        client,
        scope: props.scope,
        section: "pull-requests",
        enabled: props.enabled,
        allowStaleFollowUp: props.allowStaleFollowUp,
        pickerActive: props.pickerActive,
      }),
    { wrapper, initialProps },
  );
}

afterEach(() => {
  cleanup();
  request.mockReset();
  catalogRequests.length = 0;
  readiness.hostId = "host-1";
  readiness.isReady = true;
});

describe("useGithubMentionCatalog stale follow-up guard", () => {
  it("sweeps once when a section opens on a stale cache", async () => {
    alwaysStale();

    renderCatalog(IN_SECTION);

    await waitFor(() => expect(autoSweepCount()).toBe(1));
  });

  it("does not sweep again when the same session re-enters the section from root", async () => {
    alwaysStale();

    const { rerender } = renderCatalog(IN_SECTION);
    await waitFor(() => expect(autoSweepCount()).toBe(1));

    rerender(AT_ROOT);
    rerender(IN_SECTION);
    rerender(AT_ROOT);
    rerender(IN_SECTION);
    await waitFor(() => expect(request).toHaveBeenCalled());

    expect(autoSweepCount()).toBe(1);
  });

  it("does not sweep again after a detour through the other section", async () => {
    alwaysStale();

    const { rerender } = renderCatalog(IN_SECTION);
    await waitFor(() => expect(autoSweepCount()).toBe(1));

    rerender(OTHER_SECTION);
    rerender(IN_SECTION);
    await waitFor(() => expect(request).toHaveBeenCalled());

    expect(autoSweepCount()).toBe(1);
  });

  it("sweeps again for a NEW picker session", async () => {
    alwaysStale();

    const { rerender } = renderCatalog(IN_SECTION);
    await waitFor(() => expect(autoSweepCount()).toBe(1));

    // The picker closes, then opens again - a new session, and the cache is
    // still stale, so it gets its own follow-up.
    rerender({ ...IN_SECTION, enabled: false, pickerActive: false });
    rerender(IN_SECTION);

    await waitFor(() => expect(autoSweepCount()).toBe(2));
  });

  it("sweeps again for a different scope within one session", async () => {
    alwaysStale();

    const { rerender } = renderCatalog(IN_SECTION);
    await waitFor(() => expect(autoSweepCount()).toBe(1));

    rerender({
      ...IN_SECTION,
      scope: { epicId: "epic-1", workspacePaths: ["/repo-b"] },
    });

    await waitFor(() => expect(autoSweepCount()).toBe(2));
  });

  it("sweeps again for a different HOST at the same scope and section", async () => {
    alwaysStale();

    const { rerender } = renderCatalog(IN_SECTION);
    await waitFor(() => expect(autoSweepCount()).toBe(1));

    // An app-wide composer rebinds to another host that advertises the same
    // epic and the same workspace paths, so every other term in the guard key
    // is unchanged. Keyed without the host, the second host's `stale: true`
    // catalog reads as a sweep that already ran.
    readiness.hostId = "host-2";
    rerender(IN_SECTION);

    await waitFor(() => expect(autoSweepCount()).toBe(2));
  });

  it("pays each scope's follow-up once across an A-B-A walk", async () => {
    // A single-value ref (rather than a set of every followed key) forgets A
    // the moment B follows: coming back to A then re-spends the sweep A
    // already paid for on the way out.
    alwaysStale();

    const { rerender } = renderCatalog(IN_SECTION);
    await waitFor(() => expect(autoSweepCount()).toBe(1));

    rerender({ ...IN_SECTION, scope: SCOPE_B });
    await waitFor(() => expect(autoSweepCount()).toBe(2));

    rerender(IN_SECTION);
    await waitFor(() => expect(request).toHaveBeenCalled());

    // Still 2, not 3: A's follow-up was already paid on the way out.
    expect(autoSweepCount()).toBe(2);
  });

  /**
   * READY, not merely bound. The query cache can still serve a `stale: true`
   * answer while the host has no authenticated request context - the window
   * a transient auth hiccup, or an app-wide host swap, can open. The mark
   * used to be written before this check, so a mutation issued into that
   * window died at preflight with the session's ONE follow-up already spent,
   * and readiness becoming ready afterward found the guard already marked and
   * never retried - leaving the scope unrefreshed for the rest of the picker
   * session.
   */
  it("does not spend the follow-up while readiness is not ready, then issues it once readiness becomes ready", async () => {
    alwaysStale();

    // Root pre-fetch: the catalog is asked cache-only, but `allowStaleFollowUp`
    // is off, so this alone must not be the trigger for what follows. Also
    // warms the cache the disabled window below reads from.
    const { result, rerender } = renderCatalog(AT_ROOT);
    await waitFor(() => expect(result.current.freshnessAt).toBe(1_000));
    expect(autoSweepCount()).toBe(0);

    // Step into the section while the host is not ready.
    readiness.isReady = false;
    rerender(IN_SECTION);

    // The cached `stale: true` answer is still visible - the read is merely
    // disabled, not cleared - but the follow-up must not spend itself on it.
    // The zero is asserted only AFTER draining async work: the spend this
    // pins is an async mutation, and a synchronous read of the counter
    // stayed 0 even with the guard deleted, because the doomed request had
    // not reached the mock yet.
    expect(result.current.freshnessAt).toBe(1_000);
    await act(async () => {
      await Promise.resolve();
    });
    expect(autoSweepCount()).toBe(0);

    // Readiness recovers with nothing else about the session changed. The
    // follow-up was never marked, so it fires now instead of having been
    // silently spent on a request that never reached the host.
    readiness.isReady = true;
    rerender(IN_SECTION);

    await waitFor(() => expect(autoSweepCount()).toBe(1));
  });
});
