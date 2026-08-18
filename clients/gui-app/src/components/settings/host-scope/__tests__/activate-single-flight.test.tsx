import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ActivateResult } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import {
  hostOptionsFixture,
  hostScopeOptionFixture,
} from "../host-scope-fixture";

/**
 * Activate is SINGLE-FLIGHT.
 *
 * `makeActive` is fire-and-forget by shape and the button behind it carried no
 * pending state, so a double-click issued two `authority.activate` calls. That
 * write is not cheap and not idempotent by accident: each one validates,
 * persists and re-derives the window's host, and each success fires the app's
 * only `HostSelected` analytics event. Two clicks meant two persists racing to
 * decide the same question and a duplicate event for a preference that landed
 * once.
 *
 * The assertion is the number of WRITES, not whether a button carries a
 * `disabled` attribute. A disabled attribute is what the fix happens to render;
 * the write is what the defect was about, and a future refactor that keeps the
 * attribute while dropping the guard would still be the bug.
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

vi.mock("@/components/settings/host-scope/use-host-options", () => ({
  useHostOptions: () =>
    hostOptionsFixture({
      hosts: [
        hostScopeOptionFixture({ hostId: "host-a" }),
        hostScopeOptionFixture({ hostId: "host-b", isActive: false }),
      ],
    }),
}));

// The scope reads an ambient client only to decide `hasRequestAuthority`; this
// suite is about the WRITE, so the stub answers "signed in" and nothing else.
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

import { useHostScopeFor } from "@/components/settings/host-scope/use-host-scope";

function renderScope() {
  return renderHook(() =>
    useHostScopeFor({ scopedHostId: null, setScopedHostId: () => undefined }),
  );
}

afterEach(() => {
  cleanup();
  activateCalls.length = 0;
  resolveActivate = null;
});

describe("Activate is single-flight", () => {
  it("issues ONE activate for a double-click, and reports itself busy meanwhile", () => {
    const { result } = renderScope();

    // Precondition: nothing in flight, or "one call" below would be vacuous.
    expect(result.current.isActivating).toBe(false);

    act(() => {
      result.current.makeActive("host-b");
      result.current.makeActive("host-b");
    });

    expect(activateCalls).toEqual(["host-b"]);
    expect(result.current.isActivating).toBe(true);
  });

  it("refuses a SECOND host while the first is still settling", () => {
    // The sharper arm: a guard that only de-duplicated the same id would let
    // two different hosts race to decide the same window's host, and the
    // loser would be whichever persisted last rather than whichever was
    // clicked last.
    const { result } = renderScope();

    act(() => {
      result.current.makeActive("host-b");
      result.current.makeActive("host-a");
    });

    expect(activateCalls).toEqual(["host-b"]);
  });

  it("accepts the next activate once the first settles", async () => {
    // The latch must CLEAR, or the fix trades a double-write for a button
    // that never works again - and an assertion that only ever proves
    // "exactly one call" would pass for that build too.
    const { result } = renderScope();

    act(() => {
      result.current.makeActive("host-b");
    });
    await act(async () => {
      resolveActivate?.({ ok: true });
      await Promise.resolve();
    });

    expect(result.current.isActivating).toBe(false);

    act(() => {
      result.current.makeActive("host-a");
    });
    expect(activateCalls).toEqual(["host-b", "host-a"]);
  });
});
