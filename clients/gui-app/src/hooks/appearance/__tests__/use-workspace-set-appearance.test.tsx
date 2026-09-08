import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  WorkspaceGetAppearanceResponse,
  WorkspaceSetAppearanceResponse,
} from "@traycer/protocol/host/workspace/appearance-schemas";
import {
  clientA,
  loadHooks,
  signIn,
  fullSupport,
  makeWrapper,
  appearanceRead,
  getAppearanceResponse,
  requireSignal,
  deferred,
  routeByMethod,
} from "./workspace-appearance-test-helpers";

describe("useWorkspaceSetAppearance: cancellation, write-through, invalidation, conflict", () => {
  it("cancels an outstanding read for the same host, honoring the abort signal, before dispatching the write", async () => {
    const { hooks, authStore, manifests } = await loadHooks();
    signIn(authStore, "acct-1");
    fullSupport(manifests, "host-a");
    const route = routeByMethod(clientA);
    let readSignal: AbortSignal | null = null;
    route.getAppearance.mockImplementationOnce(
      (_params: unknown, signal: AbortSignal) => {
        readSignal = signal;
        return new Promise(() => {
          // never resolves on its own - only cancellation settles it.
        });
      },
    );
    // The mutation's own `onSuccess` issues an `invalidateQueries` refetch at
    // the end - a SECOND never-resolving GET here would make that await hang
    // forever. Only the FIRST (captured above) needs to stay pending.
    route.getAppearance.mockResolvedValue(
      getAppearanceResponse([appearanceRead({ workspacePath: "/repo" })]),
    );
    // Checked from INSIDE the write's own dispatch, not after the whole
    // mutation settles - the final state alone would also pass if only
    // `onSuccess`'s (separate, later) cancel fired, proving nothing about
    // `onMutate` cancelling BEFORE the write is dispatched, which is this
    // test's actual claim.
    let abortedBeforeDispatch = false;
    route.setAppearance.mockImplementation(() => {
      abortedBeforeDispatch = requireSignal(readSignal).aborted;
      return Promise.resolve({
        appearance: appearanceRead({ workspacePath: "/repo" }),
      } satisfies WorkspaceSetAppearanceResponse);
    });
    const { Wrapper } = makeWrapper();

    renderHook(
      () =>
        hooks.useWorkspaceAppearance({
          hostId: "host-a",
          workspacePath: "/repo",
        }),
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(readSignal).not.toBeNull());
    expect(requireSignal(readSignal).aborted).toBe(false);

    const mutation = renderHook(
      () => hooks.useWorkspaceSetAppearance({ hostId: "host-a" }),
      { wrapper: Wrapper },
    );
    await act(async () => {
      await mutation.result.current.mutateAsync({
        epicId: "epic-1",
        workspacePath: "/repo",
        patch: { color: "#000000" },
        upload: null,
      });
    });

    expect(abortedBeforeDispatch).toBe(true);

    expect(requireSignal(readSignal).aborted).toBe(true);
  });

  it("rejects the mutation up front when no account is signed in, without ever dispatching the RPC", async () => {
    const { hooks, manifests } = await loadHooks();
    fullSupport(manifests, "host-a");
    const route = routeByMethod(clientA);
    const { Wrapper } = makeWrapper();

    const mutation = renderHook(
      () => hooks.useWorkspaceSetAppearance({ hostId: "host-a" }),
      { wrapper: Wrapper },
    );

    await expect(
      mutation.result.current.mutateAsync({
        epicId: "epic-1",
        workspacePath: "/repo",
        patch: { color: "#000000" },
        upload: null,
      }),
    ).rejects.toThrow(/editing session has ended/);
    expect(route.setAppearance).not.toHaveBeenCalled();
  });

  it("writes the authoritative response through to the appearance cache and invalidates the read on success", async () => {
    const { hooks, cache, authStore, manifests } = await loadHooks();
    signIn(authStore, "acct-1");
    fullSupport(manifests, "host-a");
    const route = routeByMethod(clientA);
    const saved = appearanceRead({
      workspacePath: "/repo",
      canonicalSourceRoot: "/repo/root",
      appearance: { version: 1, color: "#ABCDEF" },
    });
    route.setAppearance.mockResolvedValue({
      appearance: saved,
    } satisfies WorkspaceSetAppearanceResponse);
    const writeSnapshotSpy = vi.spyOn(cache, "writeAppearanceSnapshot");
    const writeSourceSpy = vi.spyOn(cache, "writeAppearanceSource");
    const { Wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const mutation = renderHook(
      () => hooks.useWorkspaceSetAppearance({ hostId: "host-a" }),
      { wrapper: Wrapper },
    );
    await act(async () => {
      await mutation.result.current.mutateAsync({
        epicId: "epic-1",
        workspacePath: "/repo",
        patch: { color: "#ABCDEF" },
        upload: null,
      });
    });

    expect(writeSnapshotSpy).toHaveBeenCalledWith(
      {
        accountId: "acct-1",
        hostId: "host-a",
        canonicalSourceRoot: "/repo/root",
      },
      expect.objectContaining({ appearance: saved.appearance }),
    );
    expect(writeSourceSpy).toHaveBeenCalledWith(
      "acct-1",
      "host-a",
      "/repo",
      "/repo/root",
    );
    expect(invalidateSpy).toHaveBeenCalled();
  });

  it("re-cancels a GET that was launched AFTER onMutate, so its late (stale) delivery can't resurrect data over the save", async () => {
    // A second GET can start after onMutate's own cancel, while the SET is
    // still pending - onSuccess must re-cancel it too before publishing the
    // clear, or its late response could resurrect stale data. Every step is
    // proven by a barrier resolved from inside the mock that reaches it,
    // never by an assumed interleaving; every async act() below is awaited
    // immediately, never left dangling.
    const { hooks, cache, authStore, manifests } = await loadHooks();
    signIn(authStore, "acct-1");
    fullSupport(manifests, "host-a");
    const route = routeByMethod(clientA);
    route.getAppearance.mockResolvedValueOnce(
      getAppearanceResponse([
        appearanceRead({
          workspacePath: "/repo",
          canonicalSourceRoot: "/repo/root",
          appearance: { version: 1, color: "#111111" },
        }),
      ]),
    );
    // The mutation's own `onSuccess` issues an `invalidateQueries` refetch at
    // the end - simulate it landing while offline, so the only way the
    // asserted clear can be real is if it was actually persisted before this
    // point, not merely resurfaced by a convenient successful reconcile.
    route.getAppearance.mockRejectedValue(new Error("host unreachable"));
    const { Wrapper, queryClient } = makeWrapper();

    const query = renderHook(
      () =>
        hooks.useWorkspaceAppearance({
          hostId: "host-a",
          workspacePath: "/repo",
        }),
      { wrapper: Wrapper },
    );
    await waitFor(() =>
      expect(query.result.current.appearance?.appearance).toEqual({
        version: 1,
        color: "#111111",
      }),
    );

    const reached = deferred<void>();
    const setReached = deferred<WorkspaceSetAppearanceResponse>();
    route.setAppearance.mockImplementationOnce(() => {
      reached.resolve();
      return setReached.promise;
    });
    const staleGet = deferred<WorkspaceGetAppearanceResponse>();
    let staleGetSignal: AbortSignal | null = null;
    route.getAppearance.mockImplementationOnce(
      (_params: unknown, signal: AbortSignal) => {
        staleGetSignal = signal;
        return staleGet.promise;
      },
    );
    const writeReached = deferred<void>();
    const writeRelease = deferred<void>();
    const realWriteAppearanceSnapshot = cache.writeAppearanceSnapshot;
    const writeSnapshotSpy = vi
      .spyOn(cache, "writeAppearanceSnapshot")
      .mockImplementation(async (scope, read) => {
        writeReached.resolve();
        await writeRelease.promise;
        return realWriteAppearanceSnapshot(scope, read);
      });

    const mutation = renderHook(
      () => hooks.useWorkspaceSetAppearance({ hostId: "host-a" }),
      { wrapper: Wrapper },
    );
    let mutatePromise!: Promise<WorkspaceSetAppearanceResponse>;
    // Bounded, immediately-awaited: kicks the mutation off and waits only
    // for the SET's own dispatch to be reached - not the whole mutation.
    await act(async () => {
      mutatePromise = mutation.result.current.mutateAsync({
        epicId: "epic-1",
        workspacePath: "/repo",
        patch: { color: "#000000" },
        upload: null,
      });
      await reached.promise;
    });

    // Second GET starts AFTER onMutate's own cancel already ran, while the
    // save's RPC is still pending. Fire-and-forget (sync act, no thenable
    // returned): this refetch's own promise won't settle until `staleGet`
    // resolves later, so it must not be awaited here.
    act(() => {
      void queryClient.refetchQueries({ queryKey: ["host"] });
    });
    await waitFor(() => expect(staleGetSignal).not.toBeNull());
    expect(requireSignal(staleGetSignal).aborted).toBe(false);

    // Resolve the save with an authoritative CLEAR, and wait for onSuccess's
    // write-through to actually be reached - bounded and immediately awaited.
    await act(async () => {
      setReached.resolve({
        appearance: appearanceRead({
          workspacePath: "/repo",
          canonicalSourceRoot: "/repo/root",
          status: "absent",
          appearance: null,
        }),
      });
      await writeReached.promise;
    });

    expect(requireSignal(staleGetSignal).aborted).toBe(true);
    // `setQueryData` is synchronous, but TanStack's `notifyManager` delivers
    // subscriber updates asynchronously - wait for the exact visible clear
    // rather than reading `result.current` immediately after resolving.
    await waitFor(() =>
      expect(query.result.current.appearance?.appearance).toBeNull(),
    );

    // Deliver the stale GET's old (pre-save) response WHILE the write-through
    // is STILL held open (persistence stays blocked) - it must not resurrect
    // the pre-clear appearance. Bounded, immediately-awaited act.
    await act(async () => {
      staleGet.resolve(
        getAppearanceResponse([
          appearanceRead({
            workspacePath: "/repo",
            canonicalSourceRoot: "/repo/root",
            appearance: { version: 1, color: "#111111" },
          }),
        ]),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(query.result.current.appearance?.appearance).toBeNull();

    // Only now release the write-through - it runs for real against the fake
    // IndexedDB. The mutation's own reconcile refetch (mocked offline above)
    // then fails, so the only way the clear can still be provable afterward
    // is if it was genuinely persisted here, not merely re-served by a
    // convenient successful GET.
    await act(async () => {
      writeRelease.resolve();
      await mutatePromise;
    });

    expect(writeSnapshotSpy).toHaveBeenCalledWith(
      {
        accountId: "acct-1",
        hostId: "host-a",
        canonicalSourceRoot: "/repo/root",
      },
      expect.objectContaining({ appearance: null }),
    );
    const persisted = await cache.readAppearanceSnapshot({
      accountId: "acct-1",
      hostId: "host-a",
      canonicalSourceRoot: "/repo/root",
    });
    expect(persisted?.appearance).toBeNull();
    expect(query.result.current.appearance?.appearance).toBeNull();
  });

  it("caches the uploaded logo bytes under the path the host echoes back", async () => {
    const { hooks, cache, authStore, manifests } = await loadHooks();
    signIn(authStore, "acct-1");
    fullSupport(manifests, "host-a");
    const route = routeByMethod(clientA);
    const authoritative = appearanceRead({
      workspacePath: "/repo",
      canonicalSourceRoot: "/repo/root",
      appearance: {
        version: 1,
        icon: { kind: "image", path: "appearance/logo.png" },
      },
    });
    route.setAppearance.mockResolvedValue({
      appearance: authoritative,
    } satisfies WorkspaceSetAppearanceResponse);
    const writeBlobSpy = vi.spyOn(cache, "writeAppearanceBlob");
    const { Wrapper } = makeWrapper();

    const mutation = renderHook(
      () => hooks.useWorkspaceSetAppearance({ hostId: "host-a" }),
      { wrapper: Wrapper },
    );
    await act(async () => {
      await mutation.result.current.mutateAsync({
        epicId: "epic-1",
        workspacePath: "/repo",
        patch: {},
        upload: { mediaType: "image/png", dataBase64: "AAAA" },
      });
    });

    expect(writeBlobSpy).toHaveBeenCalledWith(
      {
        accountId: "acct-1",
        hostId: "host-a",
        canonicalSourceRoot: "/repo/root",
      },
      "appearance/logo.png",
      expect.any(Blob),
    );
  });
});
