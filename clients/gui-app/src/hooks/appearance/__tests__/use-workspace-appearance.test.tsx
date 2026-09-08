import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  WorkspaceAppearanceRead,
  WorkspaceGetAppearanceResponse,
} from "@traycer/protocol/host/workspace/appearance-schemas";
import type { WorktreeListBindingsForEpicResponse } from "@traycer/protocol/host";
import {
  clientA,
  clientB,
  loadHooks,
  signIn,
  fullSupport,
  readOnlySupport,
  makeWrapper,
  appearanceRead,
  getAppearanceResponse,
  deferred,
  routeByMethod,
} from "./workspace-appearance-test-helpers";

describe("useWorkspaceAppearance: independent drafts and late results", () => {
  it("keeps two independently-hosted drafts from ever cross-resolving into each other's slot", async () => {
    const { hooks, authStore, manifests } = await loadHooks();
    signIn(authStore, "acct-1");
    fullSupport(manifests, "host-a");
    fullSupport(manifests, "host-b");
    const routeA = routeByMethod(clientA);
    const routeB = routeByMethod(clientB);
    const { Wrapper } = makeWrapper();
    const draftA = deferred<WorkspaceGetAppearanceResponse>();
    const draftB = deferred<WorkspaceGetAppearanceResponse>();
    routeA.getAppearance.mockReturnValue(draftA.promise);
    routeB.getAppearance.mockReturnValue(draftB.promise);

    const a = renderHook(
      () =>
        hooks.useWorkspaceAppearance({
          hostId: "host-a",
          workspacePath: "/draft-a",
        }),
      { wrapper: Wrapper },
    );
    const b = renderHook(
      () =>
        hooks.useWorkspaceAppearance({
          hostId: "host-b",
          workspacePath: "/draft-b",
        }),
      { wrapper: Wrapper },
    );

    // Resolve B first, then A - later arrival must never land in the other's slot.
    act(() => {
      draftB.resolve(
        getAppearanceResponse([
          appearanceRead({
            workspacePath: "/draft-b",
            canonicalSourceRoot: "/repo/b",
          }),
        ]),
      );
    });
    await waitFor(() => expect(b.result.current.query.isSuccess).toBe(true));
    act(() => {
      draftA.resolve(
        getAppearanceResponse([
          appearanceRead({
            workspacePath: "/draft-a",
            canonicalSourceRoot: "/repo/a",
          }),
        ]),
      );
    });
    await waitFor(() => expect(a.result.current.query.isSuccess).toBe(true));

    expect(a.result.current.appearance?.canonicalSourceRoot).toBe("/repo/a");
    expect(b.result.current.appearance?.canonicalSourceRoot).toBe("/repo/b");
  });

  it("discards a late result that resolves after the signed-in account has changed", async () => {
    // `cacheKeyIdentity: [accountId]` makes account switch spin up a
    // genuinely SEPARATE query, not just re-run the same one - so the old and
    // new account's GETs must be two independent, separately controlled
    // responses. Sharing one `mockReturnValue(...)` promise between them
    // would let the new account's own legitimate dispatch "borrow" the old
    // one's resolution, which proves nothing about isolation.
    const { hooks, authStore, manifests } = await loadHooks();
    signIn(authStore, "acct-1");
    fullSupport(manifests, "host-a");
    const route = routeByMethod(clientA);
    const { Wrapper } = makeWrapper();
    const oldReached = deferred<void>();
    const oldPending = deferred<WorkspaceGetAppearanceResponse>();
    route.getAppearance.mockImplementationOnce(() => {
      oldReached.resolve();
      return oldPending.promise;
    });
    route.getAppearance.mockResolvedValue(
      getAppearanceResponse([
        appearanceRead({
          workspacePath: "/repo",
          canonicalSourceRoot: "/repo/acct-2",
          appearance: { version: 1, color: "#aaaaaa" },
        }),
      ]),
    );

    const { result } = renderHook(
      () =>
        hooks.useWorkspaceAppearance({
          hostId: "host-a",
          workspacePath: "/repo",
        }),
      { wrapper: Wrapper },
    );

    // Proof the OLD account's GET genuinely reached dispatch before the
    // account switch, rather than assuming an interleaving.
    await oldReached.promise;
    signIn(authStore, "acct-2");

    // The new account's own query settles independently, from its own
    // separately-mocked response.
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    expect(result.current.appearance?.appearance).toEqual({
      version: 1,
      color: "#aaaaaa",
    });

    // The stale (old-account) GET resolves only now, late - it must never
    // retroactively land in the CURRENT (acct-2) slot.
    act(() => {
      oldPending.resolve(
        getAppearanceResponse([
          appearanceRead({
            workspacePath: "/repo",
            canonicalSourceRoot: "/repo/acct-1-stale",
            appearance: { version: 1, color: "#111111" },
          }),
        ]),
      );
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(result.current.appearance?.appearance).toEqual({
      version: 1,
      color: "#aaaaaa",
    });
  });
});

describe("useWorkspaceAppearance: canEdit (partial vs whole malformed)", () => {
  it("allows editing a 'malformed' read that still carries a salvageable partial appearance", async () => {
    const { hooks, authStore, manifests } = await loadHooks();
    signIn(authStore, "acct-1");
    fullSupport(manifests, "host-a");
    const route = routeByMethod(clientA);
    route.getAppearance.mockResolvedValue(
      getAppearanceResponse([
        appearanceRead({
          workspacePath: "/repo",
          status: "malformed",
          appearance: { version: 1, color: "#112233" },
          issues: ["icon"],
        }),
      ]),
    );
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(
      () =>
        hooks.useWorkspaceAppearance({
          hostId: "host-a",
          workspacePath: "/repo",
        }),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    expect(result.current.canEdit).toBe(true);
  });

  it("refuses editing a totally malformed read with no salvageable appearance, even though a cached snapshot fills the display", async () => {
    const { hooks, authStore, manifests } = await loadHooks();
    signIn(authStore, "acct-1");
    fullSupport(manifests, "host-a");
    const route = routeByMethod(clientA);
    route.getAppearance.mockResolvedValue(
      getAppearanceResponse([
        appearanceRead({
          workspacePath: "/repo",
          status: "malformed",
          appearance: null,
          issues: ["appearance.json is not valid JSON"],
        }),
      ]),
    );
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(
      () =>
        hooks.useWorkspaceAppearance({
          hostId: "host-a",
          workspacePath: "/repo",
        }),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    expect(result.current.canEdit).toBe(false);
  });

  it("refuses editing when the host never advertised the write method, regardless of read state", async () => {
    const { hooks, authStore, manifests } = await loadHooks();
    signIn(authStore, "acct-1");
    readOnlySupport(manifests, "host-a");
    const route = routeByMethod(clientA);
    route.getAppearance.mockResolvedValue(
      getAppearanceResponse([appearanceRead({ workspacePath: "/repo" })]),
    );
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(
      () =>
        hooks.useWorkspaceAppearance({
          hostId: "host-a",
          workspacePath: "/repo",
        }),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    expect(result.current.canEdit).toBe(false);
  });
});

describe("useWorkspaceAppearance: canonical-null unavailable retains the previous read", () => {
  it("falls back to the previously known canonical root and appearance when a later read goes 'unavailable' with no root of its own", async () => {
    const { hooks, authStore, manifests } = await loadHooks();
    signIn(authStore, "acct-1");
    fullSupport(manifests, "host-a");
    const route = routeByMethod(clientA);
    route.getAppearance.mockResolvedValueOnce(
      getAppearanceResponse([
        appearanceRead({
          workspacePath: "/repo",
          canonicalSourceRoot: "/repo/root",
          appearance: { version: 1, color: "#445566" },
        }),
      ]),
    );
    const { Wrapper, queryClient } = makeWrapper();

    const { result } = renderHook(
      () =>
        hooks.useWorkspaceAppearance({
          hostId: "host-a",
          workspacePath: "/repo",
        }),
      { wrapper: Wrapper },
    );
    await waitFor(() =>
      expect(result.current.appearance?.canonicalSourceRoot).toBe("/repo/root"),
    );

    route.getAppearance.mockResolvedValueOnce(
      getAppearanceResponse([
        appearanceRead({
          workspacePath: "/repo",
          canonicalSourceRoot: null,
          status: "unavailable",
          appearance: null,
        }),
      ]),
    );
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ["host"] });
    });

    await waitFor(() =>
      expect(result.current.query.data?.status).toBe("unavailable"),
    );
    expect(result.current.appearance?.canonicalSourceRoot).toBe("/repo/root");
    expect(result.current.appearance?.appearance).toEqual({
      version: 1,
      color: "#445566",
    });
  });
});

describe("useWorkspaceAppearance: assetRefreshKey (bytes can change under an unchanged revision)", () => {
  it("advances assetRefreshKey on every successful response, even a byte-for-byte identical refetch", async () => {
    const { hooks, authStore, manifests } = await loadHooks();
    signIn(authStore, "acct-1");
    fullSupport(manifests, "host-a");
    const route = routeByMethod(clientA);
    const identicalRead = appearanceRead({
      workspacePath: "/repo",
      canonicalSourceRoot: "/repo/root",
    });
    route.getAppearance.mockResolvedValue(
      getAppearanceResponse([identicalRead]),
    );
    const { Wrapper, queryClient } = makeWrapper();

    const { result } = renderHook(
      () =>
        hooks.useWorkspaceAppearance({
          hostId: "host-a",
          workspacePath: "/repo",
        }),
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    const firstKey = result.current.assetRefreshKey;

    // Same host config revision, same edited-image path - `worktree.changed`
    // can legitimately trigger this refetch for bytes alone, so the asset
    // consumer must get a fresh re-stat signal even though nothing else in
    // the read differs from last time.
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ["host"] });
    });

    await waitFor(() =>
      expect(result.current.assetRefreshKey).not.toBe(firstKey),
    );
    // The read content itself is genuinely unchanged.
    expect(result.current.appearance?.appearance).toEqual(
      identicalRead.appearance,
    );
  });
});

describe("useWorkspaceAppearance: canonical fallback via a fresh disk read", () => {
  it("hydrates from a persisted snapshot under the resolved canonical root the FIRST time this workspacePath is ever seen", async () => {
    // No `writeAppearanceSource` for "/repo" has ever run for this workspace
    // path - the ONLY reason a snapshot for "/repo/root" exists on disk is a
    // different alias (or an earlier session) having written it. There is
    // therefore no in-memory `previousRead`/`fallback.data` to hand
    // `mergeAppearanceRead` - only the new disk read introduced by this fix
    // can find it.
    const { hooks, cache, authStore, manifests } = await loadHooks();
    signIn(authStore, "acct-1");
    fullSupport(manifests, "host-a");
    await cache.writeAppearanceSnapshot(
      {
        accountId: "acct-1",
        hostId: "host-a",
        canonicalSourceRoot: "/repo/root",
      },
      appearanceRead({
        workspacePath: "/some-other-alias",
        canonicalSourceRoot: "/repo/root",
        appearance: { version: 1, color: "#334455" },
      }),
    );
    const route = routeByMethod(clientA);
    route.getAppearance.mockResolvedValue(
      getAppearanceResponse([
        appearanceRead({
          workspacePath: "/repo",
          canonicalSourceRoot: "/repo/root",
          status: "malformed",
          appearance: null,
          issues: ["appearance.json is not valid JSON"],
        }),
      ]),
    );
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(
      () =>
        hooks.useWorkspaceAppearance({
          hostId: "host-a",
          workspacePath: "/repo",
        }),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    expect(result.current.appearance?.appearance).toEqual({
      version: 1,
      color: "#334455",
    });
  });

  it("keeps the disk read scoped to the exact account+host, never bleeding another account's or host's snapshot for the same root string", async () => {
    const { hooks, cache, authStore, manifests } = await loadHooks();
    // Seed the OTHER account's snapshot while THAT account is the one
    // signed in - `writeAppearanceSnapshot` rejects a write for any account
    // other than the currently-signed-in one ("no longer active"), so
    // seeding acct-2's disk state requires being acct-2 at write time. Only
    // then switch to acct-1, the account this test actually renders under.
    signIn(authStore, "acct-2");
    // Same literal canonicalSourceRoot string, but under a DIFFERENT account.
    await cache.writeAppearanceSnapshot(
      {
        accountId: "acct-2",
        hostId: "host-a",
        canonicalSourceRoot: "/repo/root",
      },
      appearanceRead({
        workspacePath: "/other-account-alias",
        canonicalSourceRoot: "/repo/root",
        appearance: { version: 1, color: "#999999" },
      }),
    );
    signIn(authStore, "acct-1");
    fullSupport(manifests, "host-a");
    const route = routeByMethod(clientA);
    route.getAppearance.mockResolvedValue(
      getAppearanceResponse([
        appearanceRead({
          workspacePath: "/repo",
          canonicalSourceRoot: "/repo/root",
          status: "unavailable",
          appearance: null,
        }),
      ]),
    );
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(
      () =>
        hooks.useWorkspaceAppearance({
          hostId: "host-a",
          workspacePath: "/repo",
        }),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    // The other account's snapshot must never surface here - nothing was ever
    // written for THIS account+host+root, so the read must come back empty.
    expect(result.current.appearance?.appearance).toBeNull();
  });

  it("discards a canonical disk read that resolves after the query was cancelled - it must never write through", async () => {
    const { hooks, cache, authStore, manifests } = await loadHooks();
    signIn(authStore, "acct-1");
    fullSupport(manifests, "host-a");
    const route = routeByMethod(clientA);
    route.getAppearance.mockResolvedValue(
      getAppearanceResponse([
        appearanceRead({
          workspacePath: "/repo",
          canonicalSourceRoot: "/repo/root",
          status: "malformed",
          appearance: null,
          issues: ["appearance.json is not valid JSON"],
        }),
      ]),
    );
    const diskRead = deferred<WorkspaceAppearanceRead | null>();
    const readSnapshotSpy = vi
      .spyOn(cache, "readAppearanceSnapshot")
      .mockReturnValue(diskRead.promise);
    const writeSnapshotSpy = vi.spyOn(cache, "writeAppearanceSnapshot");
    const { Wrapper, queryClient } = makeWrapper();

    renderHook(
      () =>
        hooks.useWorkspaceAppearance({
          hostId: "host-a",
          workspacePath: "/repo",
        }),
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(readSnapshotSpy).toHaveBeenCalled());

    await queryClient.cancelQueries({ queryKey: ["host"] });
    act(() => {
      diskRead.resolve(
        appearanceRead({
          workspacePath: "/repo",
          canonicalSourceRoot: "/repo/root",
          appearance: { version: 1, color: "#gotcha0" },
        }),
      );
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(writeSnapshotSpy).not.toHaveBeenCalled();
  });
});

describe("useWorkspaceAppearance: authoritative clears", () => {
  it("clears the appearance on 'absent', overriding a previously cached appearance for the same slot", async () => {
    const { hooks, authStore, manifests } = await loadHooks();
    signIn(authStore, "acct-1");
    fullSupport(manifests, "host-a");
    const route = routeByMethod(clientA);
    route.getAppearance.mockResolvedValueOnce(
      getAppearanceResponse([appearanceRead({ workspacePath: "/repo" })]),
    );
    const { Wrapper, queryClient } = makeWrapper();

    const { result } = renderHook(
      () =>
        hooks.useWorkspaceAppearance({
          hostId: "host-a",
          workspacePath: "/repo",
        }),
      { wrapper: Wrapper },
    );
    // `result.current.appearance` starts `null`, so `?.appearance` starts
    // `undefined` - asserting merely `.not.toBeNull()` is vacuously true
    // before the first GET ever settles. Wait for the exact seeded value
    // instead, so the refetch below only fires once the FIRST response has
    // genuinely landed (otherwise it can consume the wrong queued mock).
    await waitFor(() =>
      expect(result.current.appearance?.appearance).toEqual({
        version: 1,
        color: "#112233",
      }),
    );

    route.getAppearance.mockResolvedValueOnce(
      getAppearanceResponse([
        appearanceRead({
          workspacePath: "/repo",
          status: "absent",
          canonicalSourceRoot: null,
          appearance: null,
        }),
      ]),
    );
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ["host"] });
    });

    await waitFor(() =>
      expect(result.current.query.data?.status).toBe("absent"),
    );
    expect(result.current.appearance?.appearance).toBeNull();
  });
});

describe("useWorkspaceAppearance: older host fallback", () => {
  it("serves the locally cached snapshot when the host does not support getAppearance", async () => {
    const { hooks, cache, authStore, manifests } = await loadHooks();
    signIn(authStore, "acct-1");
    // No `recordNegotiatedHostMethods` call at all - readSupport stays `null`
    // (unknown), which the host-query's `enabled` still permits, but for this
    // test we force the KNOWN-absent case (an older host that answered and
    // proved it lacks the method).
    manifests.recordNegotiatedHostMethods("host-a", []);
    const cachedSnapshot = appearanceRead({
      workspacePath: "/repo",
      canonicalSourceRoot: "/repo/root",
      appearance: { version: 1, color: "#998877" },
    });
    await cache.writeAppearanceSource(
      "acct-1",
      "host-a",
      "/repo",
      "/repo/root",
    );
    await cache.writeAppearanceSnapshot(
      {
        accountId: "acct-1",
        hostId: "host-a",
        canonicalSourceRoot: "/repo/root",
      },
      cachedSnapshot,
    );
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(
      () =>
        hooks.useWorkspaceAppearance({
          hostId: "host-a",
          workspacePath: "/repo",
        }),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(result.current.appearance).not.toBeNull());
    expect(result.current.appearance?.appearance).toEqual({
      version: 1,
      color: "#998877",
    });
    expect(result.current.canEdit).toBe(false);
    expect(clientA.requestWithSignal).not.toHaveBeenCalledWith(
      "workspace.getAppearance",
      expect.anything(),
      expect.anything(),
    );
  });
});

describe("useEpicAppearanceSource: primary binding selection and the optimistic seed gate", () => {
  it("never queries bindings (or appearance) while the epic's create seed is pending", async () => {
    const { hooks, authStore, manifests, pendingSeeds } = await loadHooks();
    signIn(authStore, "acct-1");
    fullSupport(manifests, "host-a");
    const route = routeByMethod(clientA);
    pendingSeeds.markEpicCreateSeedPending("epic-pending");
    const { Wrapper } = makeWrapper();

    renderHook(
      () =>
        hooks.useWorkspaceAppearance(
          hooks.useEpicAppearanceSource({
            hostId: "host-a",
            epicId: "epic-pending",
          }),
        ),
      { wrapper: Wrapper },
    );
    await Promise.resolve();

    expect(route.listBindings).not.toHaveBeenCalled();
    expect(route.getAppearance).not.toHaveBeenCalled();
  });

  it("resolves through the primary binding row's host+workspacePath once bindings settle", async () => {
    const { hooks, authStore, manifests } = await loadHooks();
    signIn(authStore, "acct-1");
    fullSupport(manifests, "host-a");
    fullSupport(manifests, "host-b");
    const routeA = routeByMethod(clientA);
    const routeB = routeByMethod(clientB);
    const bindingsResponse: WorktreeListBindingsForEpicResponse = {
      rows: [
        {
          hostId: "host-a",
          runningDir: "/secondary",
          workspacePath: "/secondary",
          worktreePath: null,
          mode: "local",
          isGitRepo: true,
          repoIdentifier: null,
          branch: null,
          isPrimary: false,
          isImported: false,
          setupState: "not_required",
          disabledReason: null,
          sources: [],
        },
        {
          hostId: "host-b",
          runningDir: "/primary",
          workspacePath: "/primary",
          worktreePath: null,
          mode: "local",
          isGitRepo: true,
          repoIdentifier: null,
          branch: null,
          isPrimary: true,
          isImported: false,
          setupState: "not_required",
          disabledReason: null,
          sources: [],
        },
      ],
    };
    routeA.listBindings.mockResolvedValue(bindingsResponse);
    routeB.getAppearance.mockResolvedValue(
      getAppearanceResponse([
        appearanceRead({
          workspacePath: "/primary",
          canonicalSourceRoot: "/primary",
        }),
      ]),
    );
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(
      () =>
        hooks.useWorkspaceAppearance(
          hooks.useEpicAppearanceSource({
            hostId: "host-a",
            epicId: "epic-resolved",
          }),
        ),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(result.current.appearance).not.toBeNull());
    // The appearance RPC went to the PRIMARY row's host ("host-b"), not the
    // caller's own `hostId` arg ("host-a") - `useEpicAppearanceSource` must resolve
    // through the primary row, never default to the caller's host once a
    // primary is known.
    expect(routeB.getAppearance).toHaveBeenCalledWith(
      { workspacePaths: ["/primary"] },
      expect.anything(),
    );
    expect(routeA.getAppearance).not.toHaveBeenCalled();
  });
});
