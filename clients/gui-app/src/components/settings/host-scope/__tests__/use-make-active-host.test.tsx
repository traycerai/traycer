import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import type { ActivateResult } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import { hostScopeOptionFixture } from "../host-scope-fixture";

/**
 * `useMakeActiveHost` directly (F5): the seam `useHostScopeFor` now delegates
 * to and the account menu's Host section calls straight. `activate-single-flight.test.tsx`
 * already pins the single-flight guard through `useHostScopeFor`; this suite
 * proves the extracted hook carries the same behaviour on its own, with no
 * `useHostScopeFor` in between - including the R1-A2 module-level latch,
 * which must survive a surface unmounting and must be shared by two mounted
 * at once.
 */
const activateCalls: string[] = [];
let resolveActivate: ((result: ActivateResult) => void) | null = null;

const authority = {
  activate: (hostId: string): Promise<ActivateResult> => {
    activateCalls.push(hostId);
    return new Promise<ActivateResult>((resolve) => {
      resolveActivate = resolve;
    });
  },
};

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ selectionAuthority: authority }),
}));

vi.mock("@/lib/host", () => ({
  useHostClient: () => ({
    getRequestContext: () => ({}),
    getRequestContextUserId: () => "user-1",
  }),
}));

vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: () => null,
}));

vi.mock("@/lib/analytics", () => ({
  Analytics: { getInstance: () => ({ track: () => undefined }) },
  AnalyticsEvent: { HostSelected: "HostSelected" },
}));

import { useMakeActiveHost } from "@/components/settings/host-scope/use-host-scope";

const hosts = [
  hostScopeOptionFixture({ hostId: "host-a" }),
  hostScopeOptionFixture({ hostId: "host-b", isActive: false }),
];

afterEach(async () => {
  // The latch lives on a module-level `WeakMap` keyed by `authority`, which
  // this whole file shares - an unresolved `activate` from one test is still
  // the authority's pending entry when the next test's hook mounts. Settle it
  // first, or "nothing in flight" (every test's own precondition) is false
  // before that test even runs.
  const resolve = resolveActivate;
  if (resolve !== null) {
    await act(async () => {
      resolve({ ok: true });
      await Promise.resolve();
    });
  }
  cleanup();
  activateCalls.length = 0;
  resolveActivate = null;
});

describe("useMakeActiveHost", () => {
  it("issues ONE activate when two calls land in the same batch", () => {
    const { result } = renderHook(() => useMakeActiveHost(hosts));

    expect(result.current.isActivating).toBe(false);

    act(() => {
      result.current.makeActive("host-b");
      result.current.makeActive("host-b");
    });

    expect(activateCalls).toEqual(["host-b"]);
    expect(result.current.isActivating).toBe(true);
    expect(result.current.activatingHostId).toBe("host-b");
  });

  it("keeps the latch across a close-and-reopen of the surface (R1-A2)", async () => {
    // The account menu's Host section unmounts the instant a pick closes the
    // menu. The pending write it started must still gate the NEXT mount of
    // the hook - Settings, or the menu reopened - not reset just because no
    // component happened to be watching it.
    const first = renderHook(() => useMakeActiveHost(hosts));

    act(() => {
      first.result.current.makeActive("host-b");
    });
    expect(activateCalls).toEqual(["host-b"]);

    first.unmount();

    const second = renderHook(() => useMakeActiveHost(hosts));
    expect(second.result.current.isActivating).toBe(true);
    expect(second.result.current.activatingHostId).toBe("host-b");

    // A pick on the reopened surface must not fire a second write while the
    // first is still the authority's outstanding one.
    act(() => {
      second.result.current.makeActive("host-a");
    });
    expect(activateCalls).toEqual(["host-b"]);

    await act(async () => {
      resolveActivate?.({ ok: true });
      await Promise.resolve();
    });

    expect(second.result.current.isActivating).toBe(false);
    expect(second.result.current.activatingHostId).toBeNull();

    act(() => {
      second.result.current.makeActive("host-a");
    });
    expect(activateCalls).toEqual(["host-b", "host-a"]);
  });

  it("shares the latch between two instances mounted at once (Settings + the menu)", () => {
    const settings = renderHook(() => useMakeActiveHost(hosts));
    const menu = renderHook(() => useMakeActiveHost(hosts));

    expect(settings.result.current.isActivating).toBe(false);
    expect(menu.result.current.isActivating).toBe(false);

    act(() => {
      settings.result.current.makeActive("host-a");
    });

    expect(activateCalls).toEqual(["host-a"]);
    // The write came from `settings`, and `menu` sees it too - one window,
    // one in-flight activation, whichever surface asked.
    expect(menu.result.current.isActivating).toBe(true);
    expect(menu.result.current.activatingHostId).toBe("host-a");

    // The OTHER instance's pick must not slip a second write past the guard.
    act(() => {
      menu.result.current.makeActive("host-b");
    });
    expect(activateCalls).toEqual(["host-a"]);
    expect(settings.result.current.isActivating).toBe(true);
  });

  describe("a management-only row", () => {
    const withSummary = (hostId: string, summary: SandboxSummary | null) =>
      hostScopeOptionFixture({
        hostId,
        kind: "sandbox",
        isActive: false,
        sandbox: { state: "awake", frozen: false, summary },
      });
    const rows = [
      hostScopeOptionFixture({ hostId: "host-a" }),
      withSummary(
        "host-burst",
        sandboxSummaryFixture({ hostId: "host-burst", burst: true }),
      ),
      withSummary(
        "host-pod",
        sandboxSummaryFixture({ hostId: "host-pod", kind: "automation" }),
      ),
      withSummary("host-unconfirmed", null),
      withSummary(
        "host-sandbox",
        sandboxSummaryFixture({ hostId: "host-sandbox", burst: false }),
      ),
    ];

    it.each(["host-burst", "host-pod", "host-unconfirmed"])(
      "writes nothing when %s is made active, and holds no latch",
      (hostId) => {
        const { result } = renderHook(() => useMakeActiveHost(rows));

        act(() => {
          result.current.makeActive(hostId);
        });

        expect(activateCalls).toEqual([]);
        expect(result.current.isActivating).toBe(false);
        expect(result.current.activatingHostId).toBeNull();
      },
    );

    it("does not let a refused pick block the next legal one", () => {
      const { result } = renderHook(() => useMakeActiveHost(rows));

      act(() => {
        result.current.makeActive("host-burst");
        result.current.makeActive("host-a");
      });

      expect(activateCalls).toEqual(["host-a"]);
    });

    it("still writes for a personal host and for an ordinary confirmed sandbox", async () => {
      const { result } = renderHook(() => useMakeActiveHost(rows));

      act(() => {
        result.current.makeActive("host-sandbox");
      });
      expect(activateCalls).toEqual(["host-sandbox"]);

      await act(async () => {
        resolveActivate?.({ ok: true });
        await Promise.resolve();
      });
      act(() => {
        result.current.makeActive("host-a");
      });
      expect(activateCalls).toEqual(["host-sandbox", "host-a"]);
    });
  });
});
