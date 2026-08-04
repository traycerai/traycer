import "../../../../__tests__/test-browser-apis";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProvidersPluginsList } from "@/hooks/providers/use-providers-plugins-list-query";

/**
 * Captures the options the hook hands the host-query layer. `poll` is the only
 * thing under test here and it is invisible from the plugins tab, which mocks
 * this hook wholesale.
 */
const queryMocks = vi.hoisted(() => ({
  options: [] as Array<{ poll?: boolean; staleTime?: number }>,
}));

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQueryWithResponseMap: (args: {
    options: { poll?: boolean; staleTime?: number };
  }) => {
    queryMocks.options.push(args.options);
    return { data: undefined, isPending: true, isError: false, error: null };
  },
}));

vi.mock("@/lib/host", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/host")>("@/lib/host");
  return { ...actual, useHostClient: () => null };
});

describe("useProvidersPluginsList", () => {
  beforeEach(() => {
    queryMocks.options = [];
  });

  /**
   * `providers.list` is a CONDITION-POLLED method, and condition queries join
   * the table-owned poll by default - `refetchInterval` fires regardless of
   * `staleTime`, so the 30s stale window below is not a substitute and cannot
   * stand in for this. On Codex each list spawns `codex plugin list --json` for
   * the enabled flags, so an inherited ~800ms cadence launches a CLI process
   * per tick for as long as the tab is open.
   *
   * Asserted as `toBe(false)` rather than `toBeFalsy()`: the default is
   * `undefined`, which is falsy, so the loose form would pass on exactly the
   * omission this pins.
   */
  it("opts out of the table-owned condition poll", () => {
    renderHook(() =>
      useProvidersPluginsList({
        providerId: "codex",
        scope: "global",
        workspaceRoot: null,
        enabled: true,
      }),
    );

    expect(queryMocks.options.at(0)?.poll).toBe(false);
    expect(queryMocks.options.at(0)?.staleTime).toBe(30_000);
  });
});
