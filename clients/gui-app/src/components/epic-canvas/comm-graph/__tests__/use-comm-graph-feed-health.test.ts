/**
 * `deriveCommGraphFeedHealth` (pure) and `useCommGraphFeedHealth` (the
 * registry-backed hook) for the Epic header's feed-health dot - see
 * `use-comm-graph-feed-health.ts` for why this rolls up per-host socket
 * status instead of captioning it onto every agent node.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  deriveCommGraphFeedHealth,
  useCommGraphFeedHealth,
} from "@/components/epic-canvas/comm-graph/use-comm-graph-feed-health";
import type {
  CommGraphHostState,
  CommGraphHostStatus,
} from "@/lib/comm-graph/comm-graph-events";
import {
  __resetCommGraphRegistryForTests,
  acquireCommGraphSubscription,
  getCommGraphSubscriptionManager,
  releaseCommGraphSubscription,
} from "@/lib/comm-graph/comm-graph-registry";
import { __resetCommGraphCloudRegistryForTests } from "@/lib/comm-graph/comm-graph-cloud-registry";
import type {
  CommGraphSubscriptionHandlers,
  CommGraphSubscriptionOpener,
} from "@/lib/comm-graph/comm-graph-subscription";

function host(hostId: string, status: CommGraphHostStatus): CommGraphHostState {
  return { hostId, status, cursor: null, snapshotBoundary: null };
}

describe("deriveCommGraphFeedHealth", () => {
  it("returns null when detached, even with degraded hosts", () => {
    expect(
      deriveCommGraphFeedHealth(false, [host("host-a", "unreachable")]),
    ).toBeNull();
  });

  it("returns null when every host is live or connecting", () => {
    expect(
      deriveCommGraphFeedHealth(true, [
        host("host-a", "live"),
        host("host-b", "connecting"),
      ]),
    ).toBeNull();
  });

  it("reports the exact single-host reconnecting tooltip, with ariaLabel matching", () => {
    const health = deriveCommGraphFeedHealth(true, [
      host("host-a", "reconnecting"),
    ]);
    expect(health).not.toBeNull();
    expect(health?.tooltip).toBe("Communication graph feed: reconnecting…");
    expect(health?.ariaLabel).toBe(health?.tooltip);
  });

  it("tallies a degraded host against the total when hosts disagree", () => {
    const health = deriveCommGraphFeedHealth(true, [
      host("host-a", "unreachable"),
      host("host-b", "live"),
    ]);
    expect(health?.tooltip).toBe(
      "Communication graph feed: host unreachable (1 of 2 hosts)",
    );
  });

  it("omits the tally when every host shares the same degraded status", () => {
    const health = deriveCommGraphFeedHealth(true, [
      host("host-a", "reconnecting"),
      host("host-b", "reconnecting"),
    ]);
    expect(health?.tooltip).toBe("Communication graph feed: reconnecting…");
  });

  it("orders mixed statuses reconnecting -> unreachable -> failed -> unsupported, joined by '; '", () => {
    // Deliberately inserted out of order, so the fixed order is proven rather
    // than coincidentally matching insertion order.
    const health = deriveCommGraphFeedHealth(true, [
      host("host-a", "unsupported"),
      host("host-b", "failed"),
      host("host-c", "unreachable"),
      host("host-d", "reconnecting"),
    ]);
    expect(health?.tooltip).toBe(
      "Communication graph feed: reconnecting… (1 of 4 hosts); " +
        "host unreachable (1 of 4 hosts); connection failed (1 of 4 hosts); " +
        "host has no edge data (update the host) (1 of 4 hosts)",
    );
    expect(health?.ariaLabel).toBe(health?.tooltip);
  });
});

/**
 * Integrated against the REAL registries: only the stream boundary is faked,
 * exactly as `comm-graph-tile.test.tsx` and `comm-graph-registry.test.ts` do
 * for the subscription manager itself.
 *
 * The cloud manager is never acquired here, so `getAvailability()` stays at
 * its `"pending"` default (never `"available"`) and
 * `selectCommGraphAuthoritativeSnapshot` reads the LOCAL manager throughout -
 * the same authority rule `useCommGraphSnapshot` applies.
 */
describe("useCommGraphFeedHealth", () => {
  afterEach(() => {
    __resetCommGraphRegistryForTests();
    __resetCommGraphCloudRegistryForTests();
  });

  it("reports null before any claim, reflects a degraded status while attached, and reports null again once detached even though the last status was degraded", () => {
    const epicId = "epic-feed-health";
    let handlers: CommGraphSubscriptionHandlers | null = null;
    const opener: CommGraphSubscriptionOpener = (request) => {
      handlers = request.handlers;
      return { close: () => undefined };
    };
    const claim = {};

    const { result } = renderHook(() => useCommGraphFeedHealth(epicId));

    // No surface holds the feed open yet.
    expect(result.current).toBeNull();

    act(() => {
      acquireCommGraphSubscription(epicId, claim, opener, ["host-a"]);
    });
    // Freshly attached and still dialing ("connecting") - nothing to report.
    expect(result.current).toBeNull();

    act(() => {
      handlers?.onStatus("reconnecting");
    });
    expect(result.current).toEqual({
      severity: "warning",
      tooltip: "Communication graph feed: reconnecting…",
      ariaLabel: "Communication graph feed: reconnecting…",
    });

    act(() => {
      handlers?.onStatus("live");
    });
    expect(result.current).toBeNull();

    // Degrade again, then release while still degraded: the detach gate must
    // win over the retained (stale) status the manager still carries.
    act(() => {
      handlers?.onStatus("reconnecting");
    });
    expect(result.current).not.toBeNull();

    act(() => {
      releaseCommGraphSubscription(epicId, claim);
    });
    expect(result.current).toBeNull();
  });

  it("leaves no registry entry for an epic whose graph was never opened, once the hook unmounts", () => {
    // The hook is claim-free (see the module doc) - it registers as an
    // OBSERVER, not a claimant, so it must not strand a registry entry for
    // every epic a header was ever rendered for. Proof by identity: a
    // manager fetched after unmount for the same epic id must be a
    // DIFFERENT instance, and the original must report itself disposed.
    const epicId = "epic-feed-health-unmount-only";
    const before = getCommGraphSubscriptionManager(epicId);

    const { unmount } = renderHook(() => useCommGraphFeedHealth(epicId));
    act(() => {
      unmount();
    });

    const after = getCommGraphSubscriptionManager(epicId);
    expect(after).not.toBe(before);
    expect(before.isDisposed()).toBe(true);
  });
});
