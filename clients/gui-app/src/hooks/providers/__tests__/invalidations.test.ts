import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { PROVIDER_INVALIDATIONS } from "@/hooks/providers/invalidations";
import { commitAuthoritativeProvidersList } from "@/hooks/providers/commit-authoritative-providers-list";
import { hostQueryKeys } from "@/lib/query-keys";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * The three paths that write `providers.list` DIRECTLY - the login-completion
 * echo and the two force-refreshes - bypass `useHostScopedMutation`'s
 * `invalidateMethods`, so for a while each of them hand-rolled its own harness
 * catalog invalidation on top of `commitAuthoritativeProvidersList`.
 *
 * That was redundant, and these tests are what pin the reason down:
 * `PROVIDER_INVALIDATIONS` already names both catalogs, and the commit helper
 * already invalidates every entry in it except the list it just wrote. The
 * extra call only re-stalled queries the helper had just refetched, costing a
 * second pair of RPCs on every sign-in and every refresh.
 */
describe("providers cache invalidation", () => {
  const guiKey = hostQueryKeys.method<
    HostRpcRegistry,
    "agent.gui.listHarnesses"
  >("host-1", "agent.gui.listHarnesses", {});
  const tuiKey = hostQueryKeys.method<
    HostRpcRegistry,
    "agent.tui.listHarnesses"
  >("host-1", "agent.tui.listHarnesses", {});

  it("PROVIDER_INVALIDATIONS names both harness catalogs", () => {
    // The single source of truth for both mechanisms. Dropping either entry
    // here silently un-invalidates the catalogs on every provider mutation AND
    // on every direct write, since the commit helper derives its set from this
    // list rather than naming methods itself.
    expect(PROVIDER_INVALIDATIONS).toContain("agent.gui.listHarnesses");
    expect(PROVIDER_INVALIDATIONS).toContain("agent.tui.listHarnesses");
  });

  it("commitAuthoritativeProvidersList invalidates both harness catalogs for the written host", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(guiKey, { harnesses: [] });
    queryClient.setQueryData(tuiKey, { harnesses: [] });

    await commitAuthoritativeProvidersList({
      queryClient,
      hostId: "host-1",
      update: () => ({ providers: [], native: null }),
    });

    expect(queryClient.getQueryState(guiKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(tuiKey)?.isInvalidated).toBe(true);
  });

  it("leaves a different host's catalog entries alone", async () => {
    const queryClient = new QueryClient();
    const otherHostGuiKey = hostQueryKeys.method<
      HostRpcRegistry,
      "agent.gui.listHarnesses"
    >("host-2", "agent.gui.listHarnesses", {});
    queryClient.setQueryData(otherHostGuiKey, { harnesses: [] });

    await commitAuthoritativeProvidersList({
      queryClient,
      hostId: "host-1",
      update: () => ({ providers: [], native: null }),
    });

    expect(queryClient.getQueryState(otherHostGuiKey)?.isInvalidated).toBe(
      false,
    );
  });

  it("does NOT invalidate the providers.list entry it just wrote", async () => {
    // The whole point of the helper: it cancels the in-flight observer and
    // publishes an authoritative snapshot, so invalidating that same key would
    // immediately refetch over it. Callers whose payload cannot carry every
    // field (the frozen @2.1 login echo) add that one invalidation themselves
    // - see `use-providers-await-login-mutation`.
    const queryClient = new QueryClient();
    const listKey = hostQueryKeys.method<HostRpcRegistry, "providers.list">(
      "host-1",
      "providers.list",
      { native: null },
    );
    queryClient.setQueryData(listKey, { providers: [], native: null });

    await commitAuthoritativeProvidersList({
      queryClient,
      hostId: "host-1",
      update: () => ({ providers: [], native: null }),
    });

    expect(queryClient.getQueryState(listKey)?.isInvalidated).toBe(false);
  });
});
