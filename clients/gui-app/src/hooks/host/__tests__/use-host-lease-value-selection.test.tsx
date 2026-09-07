import { useEffect } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  HostLeaseDeadState,
  HostLeaseSnapshot,
  SelectionIncompatibility,
} from "@traycer-clients/shared/host-selection/selection-authority-contract";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { useHostLease } from "../use-host-lease";

// Reset in `beforeEach`; asserted on DELTAS across a publish, never on absolute totals, because React may render a mounted tree more than once for reasons unrelated to the selection claim under test.
let renderCount = 0;
let lastLease: HostLeaseSnapshot | null = null;

/**
 * Record re-renders in a deps-less effect (react-compiler forbids module-scope writes during render). Safe here because these arms only ask whether a re-render happened.
 */
function HostALeaseProbe(): null {
  const lease = useHostLease("host-a");
  useEffect(() => {
    renderCount += 1;
    lastLease = lease;
  });
  return null;
}

/** Every store write goes through the real writer, wrapped in `act`. */
function publish(leases: readonly HostLeaseSnapshot[]): void {
  act(() => {
    useSelectionAuthorityStore.getState().applyKernelSnapshot({
      attached: true,
      preferredHostId: "host-a",
      targetHostId: "host-a",
      effectiveHostId: "host-a",
      leases,
      selectionRevision: 1,
    });
  });
}

beforeEach(() => {
  renderCount = 0;
  lastLease = null;
});

afterEach(() => {
  cleanup();
  useSelectionAuthorityStore.getState().reset();
});

describe("useHostLease selects by value, not by lease-object identity", () => {
  /** Without it, arm 2 ("no re-render when only host B moved") would ALSO pass for a hook that returned a constant or never subscribed to the store at all - this arm is what proves the consumer genuinely tracks host A's own verdict. */
  it("re-renders host A's consumer when host A's own verdict moves (connecting -> ready), reading the new value", () => {
    publish([{ hostId: "host-a", status: "connecting", dead: null }]);
    render(<HostALeaseProbe />);
    expect(lastLease).toEqual({
      hostId: "host-a",
      status: "connecting",
      dead: null,
    });
    const afterMount = renderCount;

    publish([{ hostId: "host-a", status: "ready", dead: null }]);

    const hostAOwnVerdictMoveDelta = renderCount - afterMount;
    expect(hostAOwnVerdictMoveDelta).toBeGreaterThan(0);
    expect(lastLease).toEqual({
      hostId: "host-a",
      status: "ready",
      dead: null,
    });
  });

  /** A reference-compare selector would re-render host A's consumer anyway; `leaseEquals` must not. */
  it("does NOT re-render host A's consumer when only host B's lease changed", () => {
    const first: readonly HostLeaseSnapshot[] = [
      { hostId: "host-a", status: "ready", dead: null },
      { hostId: "host-b", status: "connecting", dead: null },
    ];
    publish(first);
    render(<HostALeaseProbe />);
    const beforeSecondPublish = renderCount;

    const second: readonly HostLeaseSnapshot[] = [
      { hostId: "host-a", status: "ready", dead: null }, // fresh object, equal value
      { hostId: "host-b", status: "ready", dead: null }, // genuinely changed
    ];
    publish(second);

    // Guard against a fixture bug: if this fixture accidentally reused the
    // same host-A object across publishes, the assertion below would pass
    // trivially without the comparator ever being exercised.
    expect(second[0]).not.toBe(first[0]);

    const hostAUnrelatedPublishRerenderDelta =
      renderCount - beforeSecondPublish;
    expect(hostAUnrelatedPublishRerenderDelta).toBe(0);
  });

  /** Proves the comparator walks INTO `dead` and `dead.detail` rather than doing a shallow compare of the lease object's own top-level fields. */
  it("compares dead.detail by value, distinguishing leaseEquals from a shallow compare", () => {
    const detail1: SelectionIncompatibility = {
      code: "protocol-major-behind",
      hostVersion: "1.2.3",
      minSupportedVersion: "1.3.0",
      clientCompatibility: null,
    };
    const dead1: HostLeaseDeadState = {
      reason: "incompatible",
      detail: detail1,
    };
    const first: HostLeaseSnapshot = {
      hostId: "host-a",
      status: "dead",
      dead: dead1,
    };
    publish([first]);
    render(<HostALeaseProbe />);
    const beforeEqualRepublish = renderCount;

    // (a) Republish an EQUAL-valued lease whose `dead` and `dead.detail` are FRESH objects.
    const detail2: SelectionIncompatibility = {
      code: "protocol-major-behind",
      hostVersion: "1.2.3",
      minSupportedVersion: "1.3.0",
      clientCompatibility: null,
    };
    const dead2: HostLeaseDeadState = {
      reason: "incompatible",
      detail: detail2,
    };
    const second: HostLeaseSnapshot = {
      hostId: "host-a",
      status: "dead",
      dead: dead2,
    };
    expect(dead2).not.toBe(dead1);
    expect(detail2).not.toBe(detail1);
    publish([second]);

    const equalValuedDeadDetailRerenderDelta =
      renderCount - beforeEqualRepublish;
    expect(equalValuedDeadDetailRerenderDelta).toBe(0);

    // (b) Positive control for (a): an ACTUAL field change inside
    // `dead.detail` does re-render.
    const beforeChangedRepublish = renderCount;
    const detail3: SelectionIncompatibility = {
      code: "protocol-major-behind",
      hostVersion: "1.9.9",
      minSupportedVersion: "1.3.0",
      clientCompatibility: null,
    };
    const third: HostLeaseSnapshot = {
      hostId: "host-a",
      status: "dead",
      dead: { reason: "incompatible", detail: detail3 },
    };
    publish([third]);

    const changedDeadDetailRerenderDelta = renderCount - beforeChangedRepublish;
    expect(changedDeadDetailRerenderDelta).toBeGreaterThan(0);
    expect(lastLease).toEqual(third);
  });
});
