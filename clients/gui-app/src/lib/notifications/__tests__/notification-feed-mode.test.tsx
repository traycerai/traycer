import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { SchemaVersion } from "@traycer/protocol/framework/index";
import type { StreamMethodSupport } from "@traycer-clients/shared/host-transport/ws-stream-client";
import { useNotificationFeedModeFor } from "@/lib/notifications/notification-feed-mode";
import { useAuthStore } from "@/stores/auth/auth-store";

const HOST_ID = "host-1";

const cloudFeedSupport = vi.hoisted<{ value: StreamMethodSupport | null }>(
  () => ({ value: null }),
);
const feedVersions = vi.hoisted(() => ({
  cloud: { major: 1, minor: 2 },
  local: { major: 1, minor: 2 },
}));

/**
 * The UNARY half of the negotiation, which is a separate transport from the two
 * stream minors above and is why it needs its own fixture.
 *
 * Annotated rather than asserted: `--fix` runs with
 * `no-unnecessary-type-assertion` and would delete an `as SchemaVersion | false
 * | null`, narrowing these to `SchemaVersion` and breaking the `false` / `null`
 * writes the fail-closed cases below depend on.
 */
interface UnaryVersions {
  list: SchemaVersion | false | null;
  markAllRead: SchemaVersion | false | null;
  indicatorState: SchemaVersion | false | null;
}
const unaryVersions = vi.hoisted((): UnaryVersions => ({
  list: { major: 2, minor: 2 },
  markAllRead: { major: 1, minor: 1 },
  indicatorState: { major: 1, minor: 1 },
}));

vi.mock("@/lib/host/stream-runtime-context", () => ({
  useStreamMethodSupport: () => cloudFeedSupport.value,
  useStreamMethodSchemaVersion: (method: string) =>
    method === "host.notifications.cloudFeed.subscribe"
      ? feedVersions.cloud
      : feedVersions.local,
  useStreamMethodSupportFor: () => cloudFeedSupport.value,
  useStreamMethodSchemaVersionFor: (_client: unknown, method: string) =>
    method === "host.notifications.cloudFeed.subscribe"
      ? feedVersions.cloud
      : feedVersions.local,
}));

/**
 * Deliberately HOOK-SHAPED. The real `useHostNegotiatedMethodVersions` consumes
 * `useSyncExternalStore` and friends; a mock that consumes no hooks is
 * invisible to React's hook counter, so a call site that later became
 * conditional would reorder nothing and these tests would pass against the
 * defect. The `useState` is the point, not incidental.
 *
 * It answers per requested host id, so passing NO host ids yields an empty map -
 * which is exactly what the production hook does with `hostId: null`, and what
 * the fail-closed case below relies on.
 */
vi.mock("@/hooks/host/use-host-negotiated-method-version", async () => {
  const { useState } = await import("react");
  return {
    useHostNegotiatedMethodVersions: (
      hostIds: readonly string[],
      method: string,
    ): ReadonlyMap<string, SchemaVersion | false | null> => {
      useState(0);
      const versions = new Map<string, SchemaVersion | false | null>();
      // Every gated method answers from its OWN slot, and an unrecognized one
      // answers `null` rather than borrowing a neighbour's. A two-way branch
      // here would hand a newly added floor whichever version happened to sit
      // on the fallback arm, so the floor would read as met before its fixture
      // existed - the gate's own regression test passing on a value nobody
      // wrote for it.
      const slots = new Map<string, SchemaVersion | false | null>([
        ["host.notifications.list", unaryVersions.list],
        ["host.notifications.markAllRead", unaryVersions.markAllRead],
        ["host.notifications.indicatorState", unaryVersions.indicatorState],
      ]);
      const answer = slots.get(method) ?? null;
      for (const hostId of hostIds) {
        versions.set(hostId, answer);
      }
      return versions;
    },
  };
});

describe("useNotificationFeedMode", () => {
  afterEach(() => {
    useAuthStore.setState({ subscriptionStatus: null });
    cloudFeedSupport.value = null;
    feedVersions.cloud = { major: 1, minor: 2 };
    feedVersions.local = { major: 1, minor: 2 };
    unaryVersions.list = { major: 2, minor: 2 };
    unaryVersions.markAllRead = { major: 1, minor: 1 };
    unaryVersions.indicatorState = { major: 1, minor: 1 };
  });

  it("selects cloud for a free-tier user when the host confirms support", () => {
    useAuthStore.setState({ subscriptionStatus: "FREE" });
    cloudFeedSupport.value = "supported";

    expect(
      renderHook(() => useNotificationFeedModeFor(null, HOST_ID)).result
        .current,
    ).toBe("cloud");
  });

  it("keeps methodless and pending capability local and upgrades only after confirmed support", () => {
    cloudFeedSupport.value = null;
    const hook = renderHook(() => useNotificationFeedModeFor(null, HOST_ID));

    expect(hook.result.current).toBe("local");
    cloudFeedSupport.value = "unknown";
    hook.rerender();
    expect(hook.result.current).toBe("local");
    cloudFeedSupport.value = "supported";
    hook.rerender();
    expect(hook.result.current).toBe("cloud");
    cloudFeedSupport.value = "unsupported";
    hook.rerender();
    expect(hook.result.current).toBe("local");
  });

  it("stays local until both partitioned feed schema versions negotiate", () => {
    cloudFeedSupport.value = "supported";

    // Cloud method present but still whole-relay (pre-1.2) — mixed mode would
    // double-count origin replicas, so local remains the single safe view.
    // The local half is held at its floor so only the cloud minor can move the
    // answer; a case short on BOTH would pass for either reason and prove
    // neither.
    feedVersions.cloud = { major: 1, minor: 0 };
    feedVersions.local = { major: 1, minor: 2 };
    expect(
      renderHook(() => useNotificationFeedModeFor(null, HOST_ID)).result
        .current,
    ).toBe("local");

    // Local feed present but pre-partition (pre-1.2), cloud at its floor.
    feedVersions.cloud = { major: 1, minor: 2 };
    feedVersions.local = { major: 1, minor: 1 };
    expect(
      renderHook(() => useNotificationFeedModeFor(null, HOST_ID)).result
        .current,
    ).toBe("local");

    // Both projection minors present → mixed (named "cloud" feed mode).
    feedVersions.cloud = { major: 1, minor: 2 };
    feedVersions.local = { major: 1, minor: 2 };
    expect(
      renderHook(() => useNotificationFeedModeFor(null, HOST_ID)).result
        .current,
    ).toBe("cloud");
  });

  /**
   * The boundary the cloud feed's re-mint CREATED, and the one case the minor
   * floors above cannot express on their own.
   *
   * `partitionSnapshot` was authored as `@1.1` and re-minted to `@1.2` when
   * mainline shipped its own `@1.1` (the widened `entry` union). So `@1.1` is a
   * real, negotiable, whole-origin feed rather than a gap in the line — and it
   * is the dangerous one, because its whole-origin `snapshot` still PARSES
   * against the `@1.2` frame union and `cloud-notifications-store` applies it
   * through the same `applySnapshot` case as a partition. Admitting it would
   * put every local-homed row in both lanes with no parse error to catch it.
   *
   * Held one minor apart across the boundary with all three other floors met,
   * so the cloud minor is the only thing that moves the answer.
   */
  it("withholds mixed mode from a whole-origin @1.1 cloud feed, and admits @1.2", () => {
    cloudFeedSupport.value = "supported";

    feedVersions.cloud = { major: 1, minor: 1 };
    expect(
      renderHook(() => useNotificationFeedModeFor(null, HOST_ID)).result
        .current,
    ).toBe("local");

    feedVersions.cloud = { major: 1, minor: 2 };
    expect(
      renderHook(() => useNotificationFeedModeFor(null, HOST_ID)).result
        .current,
    ).toBe("cloud");
  });

  /**
   * The QUIETEST of the three partition selectors, and the reason it is gated
   * here rather than left to the wire.
   *
   * `list@2.2` refuses its own downgrade outright
   * (`hostNotificationsListDowngradeV22ToV10`), so a peer below that floor
   * fails loudly. `home` is merely an OPTIONAL field on the `@1.1` indicator
   * request, so an `@1.0` peer drops it and answers plausibly — whole-origin
   * flags, indistinguishable in shape from an exact local partition.
   *
   * Mixed mode then ORs them into the cloud projection, and that per-flag OR is
   * licensed ONLY by the two partitions being disjoint. Against a whole-origin
   * answer they are not, so stale cloud-home read/action state keeps tabs and
   * sidebar rows lit with nothing anywhere to catch it.
   *
   * Every other floor is held met, so the indicator minor is the only thing
   * that can move the answer.
   */
  it("withholds mixed mode until indicatorState@1.1 carries the home selector", () => {
    cloudFeedSupport.value = "supported";

    unaryVersions.indicatorState = { major: 1, minor: 0 };
    expect(
      renderHook(() => useNotificationFeedModeFor(null, HOST_ID)).result
        .current,
    ).toBe("local");

    unaryVersions.indicatorState = { major: 1, minor: 1 };
    expect(
      renderHook(() => useNotificationFeedModeFor(null, HOST_ID)).result
        .current,
    ).toBe("cloud");
  });

  /**
   * The stream minors alone must NOT select mixed mode. Mixed mode makes
   * `useMergedNotificationsActions` send `home: "local"` as a partition
   * selector on two UNARY methods, and a host below their minors parses that
   * against its frozen schema and strips it - so pagination merges
   * whole-origin cloud replicas into the cloud lane and mark-all reaches
   * cloud-home rows. Every case here holds both stream minors at their
   * negotiated floor, so only the unary half can move the answer.
   */
  it("stays local until the unary partition minors negotiate too", () => {
    cloudFeedSupport.value = "supported";

    // `host.notifications.list` one minor short of the partition selector.
    unaryVersions.list = { major: 2, minor: 1 };
    expect(
      renderHook(() => useNotificationFeedModeFor(null, HOST_ID)).result
        .current,
    ).toBe("local");

    // ...and on the wrong major line entirely, which is not a scale.
    unaryVersions.list = { major: 1, minor: 9 };
    expect(
      renderHook(() => useNotificationFeedModeFor(null, HOST_ID)).result
        .current,
    ).toBe("local");

    // `markAllRead` short instead, with `list` at its floor.
    unaryVersions.list = { major: 2, minor: 2 };
    unaryVersions.markAllRead = { major: 1, minor: 0 };
    expect(
      renderHook(() => useNotificationFeedModeFor(null, HOST_ID)).result
        .current,
    ).toBe("local");

    // Both unary floors met, with the stream minors already there → mixed.
    unaryVersions.markAllRead = { major: 1, minor: 1 };
    expect(
      renderHook(() => useNotificationFeedModeFor(null, HOST_ID)).result
        .current,
    ).toBe("cloud");
  });

  it("fails closed on an unknown or absent unary negotiation, and with no host", () => {
    cloudFeedSupport.value = "supported";

    // `null` is "no handshake recorded yet", NOT evidence of absence - but it
    // is still not evidence of PRESENCE, and mixed mode needs presence. This
    // is safe to collapse only because the registry self-corrects on the next
    // unary ack.
    unaryVersions.list = null;
    expect(
      renderHook(() => useNotificationFeedModeFor(null, HOST_ID)).result
        .current,
    ).toBe("local");

    // `false` is a completed handshake that did not advertise the method.
    unaryVersions.list = false;
    expect(
      renderHook(() => useNotificationFeedModeFor(null, HOST_ID)).result
        .current,
    ).toBe("local");

    // No host to read a manifest from at all - the provider passes `null` when
    // there is no serving host ENTRY. There is nothing to ask, so mixed mode is
    // withheld rather than assumed.
    unaryVersions.list = { major: 2, minor: 2 };
    expect(
      renderHook(() => useNotificationFeedModeFor(null, null)).result.current,
    ).toBe("local");
  });
});
