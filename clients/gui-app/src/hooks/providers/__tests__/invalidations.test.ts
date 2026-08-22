import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  invalidateHarnessCatalogsForHost,
  PROVIDER_INVALIDATIONS,
} from "@/hooks/providers/invalidations";
import { hostQueryKeys } from "@/lib/query-keys";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * `invalidateHarnessCatalogsForHost` is the shared piece behind three
 * call sites (`use-providers-await-login-mutation.ts`,
 * `use-refresh-providers.ts`, `use-tab-refresh-providers.ts`), each of which
 * writes `providers.list` directly and therefore bypasses
 * `useHostScopedMutation`'s `invalidateMethods`. Unit-testing the shared
 * helper once covers what all three now do; the per-hook suites only need to
 * assert they call it with the right host id.
 */
describe("invalidateHarnessCatalogsForHost", () => {
  it("invalidates both agent.gui.listHarnesses and agent.tui.listHarnesses for the given host", async () => {
    const queryClient = new QueryClient();
    const guiKey = hostQueryKeys.method<
      HostRpcRegistry,
      "agent.gui.listHarnesses"
    >("host-1", "agent.gui.listHarnesses", {});
    const tuiKey = hostQueryKeys.method<
      HostRpcRegistry,
      "agent.tui.listHarnesses"
    >("host-1", "agent.tui.listHarnesses", {});
    queryClient.setQueryData(guiKey, { harnesses: [] });
    queryClient.setQueryData(tuiKey, { harnesses: [] });

    invalidateHarnessCatalogsForHost(queryClient, "host-1");
    await queryClient.getQueryCache().find({ queryKey: guiKey, exact: true })
      ?.promise;

    expect(queryClient.getQueryState(guiKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(tuiKey)?.isInvalidated).toBe(true);
  });

  it("does not touch a different host's catalog entries", () => {
    const queryClient = new QueryClient();
    const otherHostGuiKey = hostQueryKeys.method<
      HostRpcRegistry,
      "agent.gui.listHarnesses"
    >("host-2", "agent.gui.listHarnesses", {});
    queryClient.setQueryData(otherHostGuiKey, { harnesses: [] });

    invalidateHarnessCatalogsForHost(queryClient, "host-1");

    expect(queryClient.getQueryState(otherHostGuiKey)?.isInvalidated).toBe(
      false,
    );
  });

  it("PROVIDER_INVALIDATIONS (the useHostScopedMutation path) still names both harness catalogs too", () => {
    // Not the same mechanism - PROVIDER_INVALIDATIONS drives
    // `invalidateMethods` on mutations that go through the shared wrapper -
    // but the set of methods it names must stay a superset of what the
    // direct-write paths invalidate by hand, or the two mechanisms disagree
    // about what a provider change affects.
    expect(PROVIDER_INVALIDATIONS).toContain("agent.gui.listHarnesses");
    expect(PROVIDER_INVALIDATIONS).toContain("agent.tui.listHarnesses");
  });
});
