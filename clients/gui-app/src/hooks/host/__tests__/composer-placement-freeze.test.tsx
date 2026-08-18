import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useComposerPlacement } from "@/hooks/host/use-composer-placement";
import {
  composerSurfaceKey,
  useSurfaceHostSelectionStore,
} from "@/stores/host/surface-host-selection-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

/**
 * F4: a composer's SUBMIT client must be frozen to the resolved host, while
 * its READ client stays mutable.
 *
 * The bug this guards is invisible to any single-RPC test. A following
 * composer's read client is the app-wide one, which rebinds IN PLACE - the
 * object identity never changes - so a terminal-agent submit
 * (`epic.create` → `agent.tui.prepareLaunch` → `epic.createTuiAgent`, awaiting
 * between each) can create the epic on host A and then run every later step on
 * host B, with nothing in the chain able to notice. Freezing is what makes the
 * chain provably single-host; these assert the two clients are resolved from
 * DIFFERENT sources, which is the whole mechanism.
 */

// The composer key is now the BROWSER TAB's identity, not the literal
// `"browser"` every tab used to share. Pinned to a known id here so the key
// this suite asserts against is the one the hook actually builds.
vi.mock("@/lib/browser-tab-identity", () => ({
  browserTabId: () => "tab-test",
  // See `composer-surface-pin.test.tsx` - the hook subscribes, so a wholesale
  // mock must carry this export even when the id never moves.
  subscribeBrowserTabId: () => () => {},
}));

const COMPOSER_KEY = composerSurfaceKey("tab-test");

const mocks = vi.hoisted(() => ({
  effectiveHostId: { current: "host-effective" },
  /** Every host id `useHostClientForHostId` was asked to resolve, in order. */
  resolvedFor: [] as (string | null)[],
}));

// Tagged per requested id so a test can tell WHICH id each client came from -
// the distinction the whole finding turns on.
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) => {
    mocks.resolvedFor.push(hostId);
    return { getActiveHostId: () => hostId ?? "app-wide-mutable" };
  },
}));

vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => mocks.effectiveHostId.current,
}));

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({
    data: [
      {
        hostId: "host-effective",
        label: "Studio Mac",
        kind: "local",
        websocketUrl: "ws://127.0.0.1:4917/rpc",
        version: "0.0.0-test",
        transportDialability: "dialable",
      },
    ],
  }),
}));

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => ({
    status: "reachable",
    hostLabel: "Studio Mac",
    unavailability: null,
  }),
  useRemoteSessionPollReadiness: () => true,
}));

beforeEach(() => {
  useSurfaceHostSelectionStore.getState().resetForTests();
  // Back to DETACHED (the store's own default) so a fleet published by one
  // test can't leak into the next - most existing cases here rely on an
  // unattached/empty fleet to keep `isSurfacePinDeposed` a no-op.
  useSelectionAuthorityStore.getState().reset();
  mocks.effectiveHostId.current = "host-effective";
  mocks.resolvedFor = [];
});

afterEach(() => {
  // This suite never captures `unmount`, so a still-mounted tree from an
  // earlier test would otherwise keep observing later store writes below and
  // re-render, adding unrelated `useHostClientForHostId` calls to the shared
  // `mocks.resolvedFor` this file uses as an oracle.
  cleanup();
  useSurfaceHostSelectionStore.getState().resetForTests();
  useSelectionAuthorityStore.getState().reset();
});

describe("composer placement freezes its submit client", () => {
  it("resolves the READ client from the pin and the SUBMIT client from the resolution", () => {
    const { result } = renderHook(() => useComposerPlacement(null));

    // Following: `selection` is null, so the read client is the mutable
    // app-wide one - correct, because reads SHOULD re-point on a failover.
    expect(result.current.target.client?.getActiveHostId()).toBe(
      "app-wide-mutable",
    );
    // ...while the submit client names the resolved host explicitly, which is
    // what `useHostClientForHostId` turns into a pinned, non-rebinding
    // requester in production.
    expect(result.current.submitTarget.client?.getActiveHostId()).toBe(
      "host-effective",
    );
    expect(mocks.resolvedFor).toEqual([null, "host-effective"]);
  });

  it("keeps both clients on the pin's host once pinned", () => {
    useSurfaceHostSelectionStore
      .getState()
      .setSelection(COMPOSER_KEY, "host-pinned");
    const { result } = renderHook(() => useComposerPlacement(null));

    expect(result.current.target.client?.getActiveHostId()).toBe("host-pinned");
    expect(result.current.submitTarget.client?.getActiveHostId()).toBe(
      "host-pinned",
    );
  });

  it("lets an override host outrank the pin for both clients", () => {
    useSurfaceHostSelectionStore
      .getState()
      .setSelection(COMPOSER_KEY, "host-pinned");
    const { result } = renderHook(() => useComposerPlacement("host-row"));

    expect(result.current.target.resolvedHostId).toBe("host-row");
    expect(result.current.submitTarget.client?.getActiveHostId()).toBe(
      "host-row",
    );
    // §55: a caller-supplied host is a pin for D6 purposes, so a dead one is
    // refusable rather than silently substituted.
    expect(result.current.target.isPinned).toBe(true);
  });

  it("carries every other placement field through to the submit target", () => {
    const { result } = renderHook(() => useComposerPlacement(null));
    const { client: _readClient, ...readRest } = result.current.target;
    const { client: _submitClient, ...submitRest } =
      result.current.submitTarget;

    // The two targets must differ in EXACTLY one field. If they drift apart on
    // `hostLabel` or `namedHostDead`, a refusal would name a different device
    // than the one it refused for.
    expect(submitRest).toEqual(readRest);
  });

  it("a deposed pin's read client follows the resolved host, not the pin", () => {
    // The defect this pins: the hook must read `pin.honoredSelection` for the
    // READ client, never `pin.selection`. While the pin is deposed,
    // `selection` still NAMES THE DEAD HOST ("host-a"), so reverting the hook
    // to read `selection` would resolve the read client against "host-a"
    // instead of following the live host - this case must fail if that
    // happens.
    useSurfaceHostSelectionStore
      .getState()
      .setSelection(COMPOSER_KEY, "host-a");
    useSelectionAuthorityStore.getState().applyKernelSnapshot({
      attached: true,
      preferredHostId: "host-a",
      targetHostId: "host-a",
      effectiveHostId: "host-b",
      leases: [
        { hostId: "host-a", status: "dead", dead: { reason: "offline" } },
        { hostId: "host-b", status: "ready", dead: null },
      ],
      selectionRevision: 1,
    });
    mocks.effectiveHostId.current = "host-b";

    const { result } = renderHook(() => useComposerPlacement(null));

    // Confirms the deposed setup actually landed: the raw pin still names the
    // dead host, while the honored one has fallen through to `null`.
    expect(result.current.pin.selection).toBe("host-a");
    expect(result.current.pin.honoredSelection).toBeNull();

    // READ client: resolved via `honoredSelection` (`null` while deposed), so
    // it lands on the mutable app-wide client - the same tag a following
    // composer gets - rather than one pinned explicitly to "host-a".
    expect(result.current.target.client?.getActiveHostId()).toBe(
      "app-wide-mutable",
    );
    // SUBMIT client: resolved via `resolvedHostId`, which is "host-b" while
    // deposed, so the two clients agree on the live host even though the pin
    // still names the dead one.
    expect(result.current.submitTarget.client?.getActiveHostId()).toBe(
      "host-b",
    );
    // The literal ids requested from `useHostClientForHostId`, in call order:
    // `null` for the read client (never "host-a"), then "host-b" for submit.
    // Reverting the hook to `pin.selection` would push "host-a" first here,
    // which is exactly what turns the two assertions above into failures.
    expect(mocks.resolvedFor).toEqual([null, "host-b"]);
  });
});
