import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  mockLocalHostEntry,
  mockRemoteHostEntry,
} from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  LEGACY_HOST_RESOLVED_AT,
  type WorktreeWorkspaceSummaryV15,
} from "@traycer/protocol/host/worktree-schemas";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { queryKeys } from "@/lib/query-keys";
import {
  useWorktreeListByWorkspacePathsForClient,
  worktreeListByWorkspacePathsParams,
} from "@/hooks/worktree/use-worktree-list-by-workspace-paths-query";
import {
  useWorktreeWorkspacesRefresh,
  type WorktreeWorkspacesRefresh,
} from "@/hooks/worktree/use-worktree-workspaces-refresh";

const { toastSpy } = vi.hoisted(() => ({ toastSpy: vi.fn() }));
vi.mock("@/lib/host-error-toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host-error-toast")>()),
  toastFromHostError: (...args: ReadonlyArray<unknown>) => {
    toastSpy(...args);
  },
}));

const REPO = "/repos/app";
const OTHER_REPO = "/repos/tools";
const PATHS: ReadonlyArray<string> = [REPO];

describe("useWorktreeWorkspacesRefresh", () => {
  afterEach(() => {
    cleanup();
    toastSpy.mockClear();
  });

  it("lands the forced read in the cache entry the picker already renders from", async () => {
    const fixture = createFixture();
    const rendered = renderHook(() => usePicker(fixture.client, PATHS, true), {
      wrapper: fixture.Wrapper,
    });

    await waitFor(() => {
      expect(rendered.result.current.branch).toBe("feature/login");
    });
    // The background read is cache-only. That is the whole bug: the host's
    // GUI-facing mode answers it from its last-known view, so no amount of
    // refetching moves the label after an external checkout.
    expect(fixture.calls()).toEqual([
      { workspacePaths: [REPO], scriptRefs: [], forceRefresh: false },
    ]);
    const keysBefore = fixture.hostQueryKeys();

    // The external `git checkout main` + `git branch -D feature/login` that
    // the host never observes.
    fixture.setNext({ branch: "main", resolvedAt: 7_000 });
    await act(async () => {
      await rendered.result.current.refresh.refresh();
    });

    expect(fixture.calls().at(-1)).toEqual({
      workspacePaths: [REPO],
      scriptRefs: [],
      forceRefresh: true,
    });
    // The forced response reaches the SCREEN. `forceRefresh` is part of the
    // request params and therefore part of the query key, so reissuing the
    // query with it flipped would write a second cache entry that no observer
    // reads - the host would re-derive and the row would never move. Asserting
    // the key set is unchanged is what catches that: same keys, new data.
    await waitFor(() => {
      expect(rendered.result.current.branch).toBe("main");
    });
    expect(fixture.hostQueryKeys()).toEqual(keysBefore);
    expect(rendered.result.current.refresh.checkedAt).toBe(7_000);
  });

  it("drops a deleted branch from the source picker by invalidating the branch list", async () => {
    // The summary and the branch LIST are separate host reads in separate
    // cache entries. Refreshing only the summary fixes the row's label and
    // leaves the deleted branch selectable as a new worktree's source.
    const fixture = createFixture();
    const rendered = renderHook(() => usePicker(fixture.client, PATHS, true), {
      wrapper: fixture.Wrapper,
    });

    await waitFor(() => {
      expect(rendered.result.current.branches).toEqual([
        "main",
        "feature/login",
      ]);
    });

    fixture.setNext({ branch: "main", resolvedAt: 7_000 });
    fixture.setBranches(["main"]);
    await act(async () => {
      await rendered.result.current.refresh.refresh();
    });

    await waitFor(() => {
      expect(rendered.result.current.branches).toEqual(["main"]);
    });
  });

  it("reports no check time rather than a 1970 age for a legacy host's rows", async () => {
    const fixture = createFixture();
    fixture.setNext({
      branch: "feature/login",
      resolvedAt: LEGACY_HOST_RESOLVED_AT,
    });
    const rendered = renderHook(() => usePicker(fixture.client, PATHS, true), {
      wrapper: fixture.Wrapper,
    });

    await waitFor(() => {
      expect(rendered.result.current.branch).toBe("feature/login");
    });
    expect(rendered.result.current.refresh.checkedAt).toBeNull();
  });

  it("survives a slower cache-only read settling after the forced one", async () => {
    // The stacked rows arm (fork-chat, terminal-agent fork, add-node) forces on
    // MOUNT, so the ordinary `forceRefresh: false` query and the forced read
    // start together and are separate jobs. If the older, cache-only response
    // is allowed to settle last it overwrites the same key back to the stale
    // view - leaving the label worse than if nothing had refreshed at all.
    const fixture = createFixture();
    fixture.holdCacheOnlyReads();
    const rendered = renderHook(() => usePicker(fixture.client, PATHS, true), {
      wrapper: fixture.Wrapper,
    });

    await fixture.waitForHeldRequest("cacheOnly", 1);
    expect(fixture.calls().length).toBe(1);
    fixture.setNext({ branch: "main", resolvedAt: 7_000 });
    await act(async () => {
      await rendered.result.current.refresh.refresh();
    });
    await waitFor(() => {
      expect(rendered.result.current.branch).toBe("main");
    });

    // The held read now settles, carrying the pre-checkout branch. Wait until
    // that reconciliation has finished before asserting the forced value holds.
    act(() => {
      fixture.releaseHeldReads();
    });
    await waitFor(() => {
      expect(fixture.isFetching()).toBe(0);
    });

    expect(rendered.result.current.branch).toBe("main");
  });

  it("waits for the VISIBLE branch list before reporting done", async () => {
    // Supersedes "settles without awaiting the branch-list fan-out (D3
    // reversal)", which pinned fire-and-forget outright.
    //
    // D3's concern was awaiting INACTIVE branch queries - the list usually
    // lives in an unmounted nested form - which wedged "Checking…" on relay
    // round-trips nobody was watching. That concern survives and is still
    // pinned, one test below. What did not survive is the conclusion: an
    // active-only invalidation never fetches an inactive entry, so dropping
    // the await bought nothing against it and cost the visible list. Refresh
    // reported done while the mounted picker still showed cached branches, so
    // a branch deleted outside Traycer - the reason someone presses Refresh -
    // stayed selectable exactly when the spinner said it was safe to look.
    //
    // This fixture holds an ACTIVE read (the picker is mounted and
    // observing), so it now pins the opposite of what it used to.
    const fixture = createFixture();
    const rendered = renderHook(() => usePicker(fixture.client, PATHS, true), {
      wrapper: fixture.Wrapper,
    });

    await waitFor(() => {
      expect(rendered.result.current.branches).toEqual([
        "main",
        "feature/login",
      ]);
    });

    fixture.setNext({ branch: "main", resolvedAt: 7_000 });
    fixture.setBranches(["main"]);
    fixture.holdBranchReads();
    let settled = false;
    let inFlight!: Promise<void>;
    act(() => {
      inFlight = rendered.result.current.refresh.refresh().then(() => {
        settled = true;
      });
    });
    // Summary force lands, branch list still held: refresh must NOT report
    // done yet. The held read is the one the user is looking at.
    //
    // The `waitForHeldRequest` line is load-bearing and is not decoration on
    // the `waitFor` below it. `expect(settled).toBe(false)` is a NEGATIVE
    // assertion, so it only means anything once the thing that must block the
    // settle is provably in flight - and `isRefreshing` does not establish
    // that: it goes true the moment refresh starts, before the branch read is
    // even issued. Gating on it alone left `settled` racing the very request
    // it is about, and it failed under parallel-shard CI load while passing in
    // isolation. Every other hold in this file already gates on
    // `waitForHeldRequest`; this was the one that did not.
    //
    // Added as an EXTRA line rather than as a replacement, deliberately: the
    // assertions after the release are themselves timing-sensitive, and
    // reordering these two moved the failure down to line ~226 instead of
    // removing it.
    await fixture.waitForHeldRequest("branch", 1);
    await waitFor(() => {
      expect(rendered.result.current.refresh.isRefreshing).toBe(true);
    });
    expect(settled).toBe(false);

    await act(async () => {
      fixture.releaseHeldReads();
      await inFlight;
    });

    expect(settled).toBe(true);
    // `waitFor`, not a bare read: the promise settling and React committing
    // the cleared flag are two different events, and asserting the flag
    // synchronously off the promise raced them. It stayed green only because
    // nothing awaited in between - adding the `waitForHeldRequest` gate above
    // was enough to flip it, which is precisely how little it took.
    await waitFor(() => {
      expect(rendered.result.current.refresh.isRefreshing).toBe(false);
    });
    // The spinner cleared and the deleted branch is already gone - the two
    // facts that were allowed to disagree before. This one stays a BARE read
    // on purpose: it is the simultaneity claim the test exists for, so it must
    // hold at the moment the spinner clears, not merely converge later.
    expect(rendered.result.current.branches).toEqual(["main"]);
  });

  it("does NOT wait for an unobserved branch list (the half of D3 that stands)", async () => {
    // The other side of the test above, and the reason the await is
    // `refetchType: "active"` rather than a plain await.
    //
    // The branch list usually lives in an unmounted nested form. Awaiting THAT
    // is what D3 correctly refused: it wedged "Checking…" on serial relay
    // round-trips for a list nobody had on screen. An active-only invalidation
    // never fetches an inactive entry, so this must settle even with branch
    // reads held.
    const fixture = createFixture();
    const rendered = renderHook(
      ({ observe }: { observe: boolean }) =>
        usePicker(fixture.client, PATHS, observe),
      { wrapper: fixture.Wrapper, initialProps: { observe: true } },
    );

    await waitFor(() => {
      expect(rendered.result.current.branches).toEqual([
        "main",
        "feature/login",
      ]);
    });

    // The nested form closes: the entry stays in cache, with no observer.
    rendered.rerender({ observe: false });
    await waitFor(() => {
      expect(fixture.isFetching()).toBe(0);
    });

    fixture.setNext({ branch: "main", resolvedAt: 7_000 });
    fixture.setBranches(["main"]);
    fixture.holdBranchReads();
    let settled = false;
    let inFlight!: Promise<void>;
    act(() => {
      inFlight = rendered.result.current.refresh.refresh().then(() => {
        settled = true;
      });
    });

    // Held branch reads, and refresh still reports done - because the
    // active-only invalidation never asked for them.
    await waitFor(() => {
      expect(settled).toBe(true);
    });
    expect(rendered.result.current.refresh.isRefreshing).toBe(false);

    await act(async () => {
      fixture.releaseHeldReads();
      await inFlight;
    });
  });

  it("refreshes the scope on screen when the folder set changed mid-flight", async () => {
    // The captured-key write protects the NEW key from being corrupted, but it
    // does not refresh it: the new scope issued its own cache-only read, which
    // cold-only mode can answer stale. The forced derive did install fresh
    // per-path host entries, so the current key only needs re-reading.
    const fixture = createFixture();
    const rendered = renderHook(
      (paths: ReadonlyArray<string>) => usePicker(fixture.client, paths, true),
      { wrapper: fixture.Wrapper, initialProps: PATHS },
    );

    await waitFor(() => {
      expect(rendered.result.current.branch).toBe("feature/login");
    });

    // Disk moves; the host has NOT observed it, so cache-only reads keep
    // answering `feature/login` - which is what the new scope's own read gets.
    fixture.setDiskOnly({ branch: "main", resolvedAt: 7_000 });
    fixture.holdForcedReads();
    let inFlight!: Promise<void>;
    act(() => {
      inFlight = rendered.result.current.refresh.refresh();
      // The user adds a folder while the forced read is in flight. The new key
      // issues its own cache-only read and settles STALE.
      rendered.rerender([REPO, OTHER_REPO]);
    });
    await fixture.waitForHeldRequest("forced", 1);
    await waitFor(() => {
      expect(fixture.branchInCacheFor([REPO, OTHER_REPO])).toBe(
        "feature/login",
      );
    });
    await act(async () => {
      fixture.releaseHeldReads();
      await inFlight;
    });

    // The forced response landed in the OLD key. Only re-reading the key now on
    // screen pulls through the fresh per-path entries it installed.
    await waitFor(() => {
      expect(rendered.result.current.branch).toBe("main");
    });
  });

  it("forces again against the host the user switched to, and stops there", async () => {
    // The compact landing surface follows the ACTIVE host, so a rebind can land
    // while a forced read is in flight. Invalidating cannot heal that: workspace
    // views are host-local, so the force that just succeeded taught host A
    // nothing about host B, and B's own cache-only read is answered from ITS
    // cold-only cache - stale, and refetching re-serves the same stale value.
    // Only a force against B moves it.
    //
    // The swap happens explicitly here, in the test body between awaits, not
    // from inside the mock's RPC handler (redesign P4.2): under the requester
    // contract an in-flight request has already captured its entry, so a
    // handler-interior move is both inexpressible and irrelevant now - "the
    // host moved" is a NEW pinned requester the picker only sees once it
    // re-renders. Exactly two forced calls is what proves the follow-up is
    // bounded to one hop.
    const fixture = createFixture();
    const rendered = renderHook(() => usePicker(fixture.client, PATHS, true), {
      wrapper: fixture.Wrapper,
    });

    await waitFor(() => {
      expect(rendered.result.current.branch).toBe("feature/login");
    });

    fixture.setDiskOnly({ branch: "main", resolvedAt: 7_000 });
    fixture.holdForcedReads();
    let inFlight!: Promise<void>;
    act(() => {
      inFlight = rendered.result.current.refresh.refresh();
    });
    await fixture.waitForHeldRequest("forced", 1);

    act(() => {
      fixture.swapHost();
      rendered.rerender();
    });

    await act(async () => {
      fixture.releaseHeldReads();
      await inFlight;
    });

    expect(fixture.forcedCalls().length).toBe(2);
  });

  it("stays silent on a cancellation that is NOT a host move, and starts no chase", async () => {
    // The `onError` CancelledError arm, on the trigger that still produces it.
    //
    // This case used to drive a HOST SWAP, because `HostClient.bind` snapshotted
    // the outgoing host's in-flight jobs and settled them `authority-superseded`.
    // Redesign P2.1 deleted that: a host becoming effective is no longer a
    // lifecycle event for the host that left, so a swap mid-refresh now lets the
    // in-flight read finish and lands in `onSuccess` - which carries the SAME
    // `forceAgainstLiveHost` call, so the follow-up survives and is covered by
    // "forces again against the host the user switched to, and stops there".
    //
    // What P2.1 did NOT delete is the cancellation class itself, and this arm is
    // its only cover. `setRequestContext` still aborts the bound host's in-flight
    // work on an identity transition - deliberately, because a credential change
    // must not let work issued under the old identity keep running - so an auth
    // change mid-refresh is now the plainest live producer. It is also the one
    // the fixture already speaks: `client` is exposed and the context fixture is
    // already imported, so nothing here reaches for new fixture surface. (A
    // same-host TRANSPORT move reaches the same arm, but pinning it would couple
    // this test to whichever fields `sameHostTransport` happens to compare -
    // machinery P4.1/P4.2 will move.)
    //
    // The claim, and it is a different one than before: a cancellation with the
    // host UNMOVED is silent AND spawns nothing. `forceAgainstLiveHost` returns
    // early when the live host still equals the one the request started under,
    // so there is no second force to find - the toast must not fire and the
    // chase must not start.
    const fixture = createFixture();
    const rendered = renderHook(() => usePicker(fixture.client, PATHS, true), {
      wrapper: fixture.Wrapper,
    });

    await waitFor(() => {
      expect(rendered.result.current.branch).toBe("feature/login");
    });

    fixture.setDiskOnly({ branch: "main", resolvedAt: 7_000 });
    fixture.holdForcedReads();
    let inFlight!: Promise<void>;
    act(() => {
      inFlight = rendered.result.current.refresh.refresh();
    });
    await fixture.waitForHeldRequest("forced", 1);

    // The identity transition. A DIFFERENT context reference is what makes this
    // a transition rather than a same-user rotation (which mutates the lease in
    // place and deliberately does not abort anything).
    act(() => {
      fixture.client.setRequestContext(
        createRequestContextFixture({
          origin: "renderer",
          bearerToken: "tok-2",
        }),
      );
    });

    // NOT released first, and that ordering IS the discriminator. The abort is
    // ASYNCHRONOUS - `cancelThenAbortAll` waits on the invalidator's
    // `cancelHostScope` before aborting the coordinator job - so releasing here
    // would let the held read settle normally and win the race, and the test
    // would pass without a cancellation ever occurring. Awaiting the in-flight
    // refresh FIRST means only the abort can settle it: if the cancellation
    // stops firing, this await never returns and the case times out rather
    // than quietly passing.
    await act(async () => {
      await inFlight;
    });
    fixture.releaseHeldReads();

    // THE DISCRIMINATOR, and it is the only assertion here that can tell the
    // subject apart from its own null hypothesis. `onSuccess` is what writes
    // the forced response into the entry the picker renders from, so a read
    // that was CANCELLED leaves the pre-refresh branch on screen while a read
    // that merely settled would have moved it to the disk value. Written down
    // because the silence assertions below are true of BOTH outcomes: a
    // successful held read also makes exactly one forced call and also raises
    // no toast, so on their own they pass whether or not the cancellation this
    // test is named for ever happened. Measured, not assumed - without this
    // line the trigger can be deleted outright and the test still passes.
    expect(rendered.result.current.branch).toBe("feature/login");
    // Exactly the one force that was cancelled: the host never moved, so no
    // follow-up is owed and none is made.
    expect(fixture.forcedCalls().length).toBe(1);
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it("reports completion only once the moved scope is current, not merely marked", async () => {
    // `refresh()` resolving is what the spinner and every caller treat as
    // "done". If the current-key invalidation is fired and discarded, the
    // promise settles while that refetch is still in flight and the label the
    // user is looking at is still the pre-checkout one.
    const fixture = createFixture();
    const rendered = renderHook(
      (paths: ReadonlyArray<string>) => usePicker(fixture.client, paths, true),
      { wrapper: fixture.Wrapper, initialProps: PATHS },
    );

    await waitFor(() => {
      expect(rendered.result.current.branch).toBe("feature/login");
    });

    fixture.setDiskOnly({ branch: "main", resolvedAt: 7_000 });
    fixture.holdForcedReads();
    let inFlight!: Promise<void>;
    act(() => {
      inFlight = rendered.result.current.refresh.refresh();
      rendered.rerender([REPO, OTHER_REPO]);
    });
    await fixture.waitForHeldRequest("forced", 1);
    // New scope's own cache-only read must settle STALE before we arm holds on
    // the post-force re-read; otherwise that mount read would be held too.
    await waitFor(() => {
      expect(fixture.branchInCacheFor([REPO, OTHER_REPO])).toBe(
        "feature/login",
      );
    });
    // Hold the moved scope's re-read so it settles only when we release it -
    // later than the branch list, whose invalidation is awaited either way.
    // Otherwise awaiting branches alone would mask a discarded current-key
    // invalidation.
    fixture.holdCacheOnlyReads();
    act(() => {
      fixture.releaseHeldOfKind("forced");
    });
    await fixture.waitForHeldRequest("cacheOnly", 1);
    await act(async () => {
      fixture.releaseHeldOfKind("cacheOnly");
      await inFlight;
    });

    // Read straight out of the cache, with no `waitFor`: the contract is that
    // completion MEANS current, not that current arrives shortly after.
    expect(fixture.branchInCacheFor([REPO, OTHER_REPO])).toBe("main");
  });

  it("issues no request at all with no folders in scope", async () => {
    const fixture = createFixture();
    const rendered = renderHook(
      () =>
        useWorktreeWorkspacesRefresh({
          client: fixture.client,
          workspacePaths: [],
          summaries: [],
        }),
      { wrapper: fixture.Wrapper },
    );

    // The affordance reports itself inert rather than firing an empty read
    // that the host would answer with an empty list.
    expect(rendered.result.current.canRefresh).toBe(false);
    await act(async () => {
      await rendered.result.current.refresh();
    });
    expect(fixture.calls()).toEqual([]);
  });

  it("sets verifyFailed on a real (non-cancelled) forced-read error, and clears it on a successful retry", async () => {
    const fixture = createFixture();
    fixture.failNextForcedRead(new Error("relay unreachable"));
    const rendered = renderHook(() => usePicker(fixture.client, PATHS, true), {
      wrapper: fixture.Wrapper,
    });

    await waitFor(() => {
      expect(rendered.result.current.branch).toBe("feature/login");
    });
    expect(rendered.result.current.refresh.verifyFailed).toBe(false);

    await act(async () => {
      await rendered.result.current.refresh.refresh().catch(() => undefined);
    });
    expect(rendered.result.current.refresh.verifyFailed).toBe(true);
    // A real failure still toasts - distinct from the silent coordinator
    // cancellation path exercised elsewhere in this file.
    expect(toastSpy).toHaveBeenCalledTimes(1);

    // The next user-driven attempt clears the footer failure state up front,
    // not only once the retry itself succeeds.
    fixture.setNext({ branch: "main", resolvedAt: 7_000 });
    await act(async () => {
      await rendered.result.current.refresh.refresh();
    });
    expect(rendered.result.current.refresh.verifyFailed).toBe(false);
    await waitFor(() => {
      expect(rendered.result.current.branch).toBe("main");
    });
  });

  it("sets verifyFailed when the one-hop post-host-change force fails", async () => {
    // A→B path: A's held read settles normally (redesign P4.2 deleted the
    // active-slot cancellation `HostClient.bind` used to trigger, so there is
    // no CancelledError here - `onSuccess` is what notices the host moved),
    // then forceAgainstLiveHost fires against B. If THAT hop fails, the
    // footer must still show the failure state — toast alone left it
    // silently idle.
    //
    // Arm order matters: failNextForced is checked BEFORE holdForced in the
    // fixture. Arming fail before A's request starts makes A reject
    // immediately and waitForHeldRequest never sees a hold.
    const fixture = createFixture();
    const rendered = renderHook(() => usePicker(fixture.client, PATHS, true), {
      wrapper: fixture.Wrapper,
    });

    await waitFor(() => {
      expect(rendered.result.current.branch).toBe("feature/login");
    });

    fixture.holdForcedReads();
    let inFlight!: Promise<void>;
    act(() => {
      inFlight = rendered.result.current.refresh
        .refresh()
        .catch(() => undefined);
    });
    // A is held. NOW arm B to fail so the one-hop follow-up rejects.
    await fixture.waitForHeldRequest("forced", 1);
    fixture.failNextForcedRead(new Error("host B unreachable"));
    // Swap to a NEW pinned requester for B and re-render so the picker (and
    // `forceAgainstLiveHost`'s `client` closure) observes it before A's held
    // read is released - the requester swap itself does not touch A's
    // already-dispatched request (failNext is checked before hold, so B's
    // follow-up fails immediately once it fires).
    act(() => {
      fixture.swapHost();
      rendered.rerender();
    });
    await act(async () => {
      fixture.releaseHeldReads();
      await inFlight;
    });

    expect(rendered.result.current.refresh.verifyFailed).toBe(true);
    expect(toastSpy).toHaveBeenCalled();
  });
});

/**
 * The picker's two reads as one hook: the summary query the rows render from,
 * and the forced refresh that has to land in that query's own cache entry.
 * Kept together because the path list is part of the key - splitting them into
 * two independently-built path arrays is exactly the drift the hook's contract
 * forbids.
 */
function usePicker(
  client: HostClient<HostRpcRegistry>,
  workspacePaths: ReadonlyArray<string>,
  // `false` leaves the branch cache entry populated but UNOBSERVED, which is
  // the "unmounted nested form" case D3 was actually about.
  observeBranches: boolean,
): {
  readonly branch: string | null;
  readonly branches: ReadonlyArray<string>;
  readonly refresh: WorktreeWorkspacesRefresh;
} {
  const summariesQuery = useWorktreeListByWorkspacePathsForClient(client, {
    workspacePaths,
    enabled: true,
  });
  const summaries = summariesQuery.data?.workspaces ?? [];
  const branchesQuery = useHostQuery<HostRpcRegistry, "worktree.listBranches">({
    cacheKeyIdentity: undefined,
    client,
    method: "worktree.listBranches",
    params: { workspacePath: REPO, includeRemote: true },
    options: { enabled: observeBranches },
  });
  return {
    branch: summaries[0]?.worktrees[0]?.branch ?? null,
    branches: (branchesQuery.data?.branches ?? []).map((entry) => entry.name),
    refresh: useWorktreeWorkspacesRefresh({
      client,
      workspacePaths,
      summaries,
    }),
  };
}

function summariesFor(
  workspacePaths: ReadonlyArray<string>,
  branch: string,
  resolvedAt: number | null,
): {
  readonly workspaces: WorktreeWorkspaceSummaryV15[];
  readonly scriptsAtRefs: never[];
} {
  return {
    // Each summary answers for the path it was asked about. The host has no
    // other way to answer, and a fixture that reports one path twice would let
    // a wrong-path write pass as long as nothing read past `workspaces[0]`.
    workspaces: workspacePaths.map((workspacePath) =>
      workspaceSummary({ workspacePath, branch, resolvedAt }),
    ),
    scriptsAtRefs: [],
  };
}

function workspaceSummary(args: {
  readonly workspacePath: string;
  readonly branch: string;
  readonly resolvedAt: number | null;
}): WorktreeWorkspaceSummaryV15 {
  return {
    workspacePath: args.workspacePath,
    isGitRepo: true,
    repoIdentifier: { owner: "acme", repo: "app" },
    mainBranch: "main",
    // The folder's own checked-out branch lives HERE, on the main disk row -
    // the summary itself has no `branch` field.
    worktrees: [
      {
        worktreePath: args.workspacePath,
        branch: args.branch,
        head: null,
        isMain: true,
        isLocked: false,
      },
    ],
    scripts: null,
    repoBranchPrefix: { status: "absent" },
    resolvedAt: args.resolvedAt,
    presence: "present",
  };
}

/** Held host-read kinds this fixture can arm, await, and release. */
type HeldRequestKind = "cacheOnly" | "forced" | "branch";

function createFixture(): {
  readonly client: HostClient<HostRpcRegistry>;
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
  readonly calls: () => ReadonlyArray<unknown>;
  readonly forcedCalls: () => ReadonlyArray<unknown>;
  readonly hostQueryKeys: () => ReadonlyArray<string>;
  /** Switches the active host once, exactly as the host picker does. */
  readonly swapHost: () => void;
  /**
   * The branch sitting in the cache entry a scope renders from, read without
   * waiting - so a test can assert what is TRUE the moment a refresh reports
   * itself finished, rather than what becomes true shortly after.
   */
  readonly branchInCacheFor: (paths: ReadonlyArray<string>) => string | null;
  /** In-flight TanStack queries+mutations; 0 means reconciliation settled. */
  readonly isFetching: () => number;
  readonly setNext: (next: {
    readonly branch: string;
    readonly resolvedAt: number | null;
  }) => void;
  readonly setBranches: (names: ReadonlyArray<string>) => void;
  readonly setDiskOnly: (next: {
    readonly branch: string;
    readonly resolvedAt: number | null;
  }) => void;
  /** Holds reads of one kind open, so a test can settle them LAST. */
  readonly holdCacheOnlyReads: () => void;
  readonly holdForcedReads: () => void;
  readonly holdBranchReads: () => void;
  /**
   * Resolves when `count` held requests of `kind` arrive in its current hold
   * window. Re-arming a kind starts a new window, so this stays relative to the
   * request race the test is controlling rather than earlier holds.
   */
  readonly waitForHeldRequest: (
    kind: HeldRequestKind,
    count: number,
  ) => Promise<void>;
  /** Releases every held kind and stops holding. */
  readonly releaseHeldReads: () => void;
  /**
   * Releases only one held kind (and stops holding it). Other kinds stay
   * held so a test can order settlement deterministically.
   */
  readonly releaseHeldOfKind: (kind: HeldRequestKind) => void;
  /** The next forced read rejects with `error` instead of settling. */
  readonly failNextForcedRead: (error: Error) => void;
} {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const calls: unknown[] = [];
  let branch = "feature/login";
  let resolvedAt: number | null = 1_000;
  let branchNames: ReadonlyArray<string> = ["main", "feature/login"];
  // What the host has INSTALLED, as distinct from what is on disk above. They
  // diverge exactly when an external checkout happens and nothing has forced a
  // re-derive yet - the whole subject of #711.
  let cachedBranch = branch;
  let cachedResolvedAt: number | null = resolvedAt;
  let holdCacheOnly = false;
  let holdForced = false;
  let holdBranches = false;
  let failNextForced: Error | null = null;
  const heldByKind: Record<HeldRequestKind, Array<() => void>> = {
    cacheOnly: [],
    forced: [],
    branch: [],
  };
  const arrivalCount: Record<HeldRequestKind, number> = {
    cacheOnly: 0,
    forced: 0,
    branch: 0,
  };
  const arrivalWaiters: Record<
    HeldRequestKind,
    Array<{ readonly target: number; readonly resolve: () => void }>
  > = {
    cacheOnly: [],
    forced: [],
    branch: [],
  };

  const noteArrival = (kind: HeldRequestKind): void => {
    arrivalCount[kind] += 1;
    const count = arrivalCount[kind];
    const remaining: Array<{
      readonly target: number;
      readonly resolve: () => void;
    }> = [];
    for (const waiter of arrivalWaiters[kind]) {
      if (count >= waiter.target) {
        waiter.resolve();
      } else {
        remaining.push(waiter);
      }
    }
    arrivalWaiters[kind] = remaining;
  };

  const hold = (kind: HeldRequestKind, release: () => void): void => {
    heldByKind[kind].push(release);
    noteArrival(kind);
  };

  const armHold = (kind: HeldRequestKind): void => {
    // Counts are scoped to the active hold window. A test can release a kind,
    // re-arm it later, and wait for the next request without an earlier arrival
    // immediately satisfying the new wait.
    arrivalCount[kind] = 0;
  };

  const releaseKind = (kind: HeldRequestKind): void => {
    if (kind === "cacheOnly") holdCacheOnly = false;
    if (kind === "forced") holdForced = false;
    if (kind === "branch") holdBranches = false;
    const pending = [...heldByKind[kind]];
    heldByKind[kind].length = 0;
    for (const release of pending) release();
  };

  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "req-workspaces-refresh",
    handlers: {
      // Models the host's cold-only mode: a `forceRefresh: false` read is
      // answered from the last-known view whatever disk says, and only a forced
      // read re-touches disk AND installs what it found.
      "worktree.listByWorkspacePaths": (params) => {
        calls.push(params);
        const paths = params.workspacePaths;
        if (params.forceRefresh) {
          if (failNextForced !== null) {
            const error = failNextForced;
            failNextForced = null;
            return Promise.reject(error);
          }
          const settle = (): {
            readonly workspaces: WorktreeWorkspaceSummaryV15[];
            readonly scriptsAtRefs: never[];
          } => {
            cachedBranch = branch;
            cachedResolvedAt = resolvedAt;
            return summariesFor(paths, branch, resolvedAt);
          };
          if (holdForced) {
            return new Promise((resolve) => {
              hold("forced", () => {
                resolve(settle());
              });
            });
          }
          return Promise.resolve(settle());
        }
        // Snapshotted at CALL time, so a held read carries the view it was
        // always going to return - not whatever landed meanwhile.
        const payload = summariesFor(paths, cachedBranch, cachedResolvedAt);
        if (holdCacheOnly) {
          return new Promise((resolve) => {
            hold("cacheOnly", () => {
              resolve(payload);
            });
          });
        }
        return Promise.resolve(payload);
      },
      "worktree.listBranches": () => {
        const payload = {
          branches: branchNames.map((name) => ({
            name,
            isCurrent: name === branch,
            isRemoteOnly: false,
          })),
          uncommittedFileCount: 0,
        };
        if (holdBranches) {
          return new Promise((resolve) => {
            hold("branch", () => {
              resolve(payload);
            });
          });
        }
        return Promise.resolve(payload);
      },
    },
  });
  // A requester pinned to a known row (migration recipe, redesign P4.2):
  // `findHostById` is what both `createRequester` calls below re-resolve the
  // live entry through, and it is REQUIRED - without it every request on a
  // pinned client rejects as a stale binding, surfacing as absent data rather
  // than an error naming a client.
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    messenger,
    findHostById: (hostId) => {
      if (hostId === mockLocalHostEntry.hostId) return mockLocalHostEntry;
      if (hostId === mockRemoteHostEntry.hostId) return mockRemoteHostEntry;
      return null;
    },
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  // Reassigned by `swapHost` rather than rebound in place - the active slot
  // `HostClient.bind` used to mutate is gone (redesign P4.2), so "the host
  // moved" is now expressed as a NEW pinned requester, and the picker only
  // observes it once the test explicitly re-renders with the new reference.
  let client = spine.createRequester(mockLocalHostEntry);
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  return {
    get client() {
      return client;
    },
    Wrapper,
    calls: () => calls,
    forcedCalls: () =>
      calls.filter(
        (params) =>
          typeof params === "object" &&
          params !== null &&
          "forceRefresh" in params &&
          params.forceRefresh === true,
      ),
    swapHost: () => {
      client =
        client.getActiveHostId() === mockLocalHostEntry.hostId
          ? spine.createRequester(mockRemoteHostEntry)
          : spine.createRequester(mockLocalHostEntry);
    },
    branchInCacheFor: (paths) => {
      // Built with the hook's own key builders, so the assertion cannot drift
      // from the entry the rows actually render out of.
      const data = queryClient.getQueryData<{
        readonly workspaces: ReadonlyArray<WorktreeWorkspaceSummaryV15>;
      }>(
        queryKeys.hostMethod<HostRpcRegistry, "worktree.listByWorkspacePaths">(
          client.getActiveHostId(),
          "worktree.listByWorkspacePaths",
          worktreeListByWorkspacePathsParams(paths),
        ),
      );
      return data?.workspaces[0]?.worktrees[0]?.branch ?? null;
    },
    isFetching: () => queryClient.isFetching() + queryClient.isMutating(),
    hostQueryKeys: () =>
      queryClient
        .getQueryCache()
        .getAll()
        .map((query) => JSON.stringify(query.queryKey))
        .sort(),
    setNext: (next) => {
      branch = next.branch;
      resolvedAt = next.resolvedAt;
      cachedBranch = next.branch;
      cachedResolvedAt = next.resolvedAt;
    },
    // An external checkout the host has NOT observed: disk moves, the installed
    // view does not, so cache-only reads keep answering with the old branch.
    setDiskOnly: (next) => {
      branch = next.branch;
      resolvedAt = next.resolvedAt;
    },
    holdForcedReads: () => {
      armHold("forced");
      holdForced = true;
    },
    holdBranchReads: () => {
      armHold("branch");
      holdBranches = true;
    },
    setBranches: (names) => {
      branchNames = names;
    },
    holdCacheOnlyReads: () => {
      armHold("cacheOnly");
      holdCacheOnly = true;
    },
    waitForHeldRequest: (kind, count) => {
      if (arrivalCount[kind] >= count) {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        arrivalWaiters[kind].push({ target: count, resolve });
      });
    },
    releaseHeldReads: () => {
      // Stops holding too, or the refetch a release provokes would be captured
      // by the same hold and never settle.
      releaseKind("cacheOnly");
      releaseKind("forced");
      releaseKind("branch");
    },
    releaseHeldOfKind: (kind) => {
      releaseKind(kind);
    },
    failNextForcedRead: (error) => {
      failNextForced = error;
    },
  };
}
