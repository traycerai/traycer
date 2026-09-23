/**
 * `deriveCommGraphFeedHealth` (pure) and `useCommGraphFeedHealth` (the
 * cloud-registry-backed hook) for the Epic header's feed-health dot - see
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
  __resetCommGraphCloudRegistryForTests,
  acquireCommGraphCloudSubscription,
  getCommGraphCloudSubscriptionManager,
  releaseCommGraphCloudSubscription,
} from "@/lib/comm-graph/comm-graph-cloud-registry";
import type {
  CommGraphCloudSubscriptionHandlers,
  CommGraphCloudSubscriptionOpener,
} from "@/lib/comm-graph/comm-graph-cloud-subscription";

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
        "cloud communication feed unsupported (1 of 4 hosts)",
    );
    expect(health?.ariaLabel).toBe(health?.tooltip);
  });
});

/**
 * Integrated against the REAL cloud registry: only the relay boundary is
 * faked, exactly as `comm-graph-tile.test.tsx` does for the cloud
 * subscription manager itself.
 *
 * The hook never acquires a claim of its own - it only observes - so every
 * case here drives the manager through a separately acquired claim, the same
 * way a mounted `useCommGraphSnapshot` caller would.
 */
describe("useCommGraphFeedHealth", () => {
  afterEach(() => {
    __resetCommGraphCloudRegistryForTests();
  });

  it("reports null before any claim, reflects a degraded status while attached, and reports null again once detached even though the last status was degraded", () => {
    const epicId = "epic-feed-health";
    let handlers: CommGraphCloudSubscriptionHandlers | null = null;
    const opener: CommGraphCloudSubscriptionOpener = (request) => {
      handlers = request.handlers;
      return { close: () => undefined };
    };
    const claim = {};

    const { result } = renderHook(() => useCommGraphFeedHealth(epicId));

    // No claim holds the relay open yet.
    expect(result.current).toBeNull();

    act(() => {
      acquireCommGraphCloudSubscription(epicId, claim, opener, ["host-a"]);
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
      releaseCommGraphCloudSubscription(epicId, claim);
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
    const before = getCommGraphCloudSubscriptionManager(epicId);

    const { unmount } = renderHook(() => useCommGraphFeedHealth(epicId));
    act(() => {
      unmount();
    });

    const after = getCommGraphCloudSubscriptionManager(epicId);
    expect(after).not.toBe(before);
    expect(before.isDisposed()).toBe(true);
  });
});
