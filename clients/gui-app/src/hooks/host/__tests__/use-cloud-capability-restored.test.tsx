import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostReconnectEngine } from "@traycer-clients/shared/host-client/host-connection-reconnect-engine";
import { useCloudCapabilityRestored } from "@/hooks/host/use-cloud-capability-restored";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * This suite mounts hooks, and gui-app has no automatic RTL cleanup - an
 * un-unmounted hook keeps its store subscription and answers the NEXT test's
 * writes. `cleanup()` is what makes each case independent.
 */
afterEach(() => {
  cleanup();
  useAuthStore.setState({ status: "signed-out" });
});

describe("useCloudCapabilityRestored", () => {
  it("fires once on the unverified -> signed-in promotion", () => {
    const onRestored = vi.fn();
    act(() => {
      useAuthStore.setState({ status: "unverified" });
    });
    renderHook(() => useCloudCapabilityRestored(onRestored));

    expect(onRestored).not.toHaveBeenCalled();
    act(() => {
      useAuthStore.setState({ status: "signed-in" });
    });
    expect(onRestored).toHaveBeenCalledTimes(1);
  });

  /**
   * The property the pacer's backoff depends on. `clearStreak` releases a
   * streak wholesale, so a trigger that fires on every store write while the
   * session merely STAYS authorized would clear on each rebuild attempt and
   * disable pacing entirely - restoring the hot rebuild loop with a wake in
   * front of it. Only the transition may fire.
   */
  it("stays silent on writes that leave the capability already authorized", () => {
    const onRestored = vi.fn();
    act(() => {
      useAuthStore.setState({ status: "signed-in" });
    });
    renderHook(() => useCloudCapabilityRestored(onRestored));

    act(() => {
      useAuthStore.setState({
        status: "signed-in",
        subscriptionStatus: "FREE",
      });
    });
    act(() => {
      useAuthStore.setState({ status: "signed-in", subscriptionStatus: "PRO" });
    });
    expect(onRestored).not.toHaveBeenCalled();
  });

  it("stays silent on the demotion itself and on transitions that never reach authorized", () => {
    const onRestored = vi.fn();
    act(() => {
      useAuthStore.setState({ status: "signed-in" });
    });
    renderHook(() => useCloudCapabilityRestored(onRestored));

    // true -> false: the demotion is what CAUSES the streak, not what releases
    // it.
    act(() => {
      useAuthStore.setState({ status: "unverified" });
    });
    // false -> false: `unverified` and `signing-in` both admit the local plane
    // but authorize no cloud capability, so moving between them restores
    // nothing.
    act(() => {
      useAuthStore.setState({ status: "signed-out" });
    });
    act(() => {
      useAuthStore.setState({ status: "signing-in" });
    });
    expect(onRestored).not.toHaveBeenCalled();
  });

  it("fires again on a second demotion/promotion cycle", () => {
    const onRestored = vi.fn();
    act(() => {
      useAuthStore.setState({ status: "signed-in" });
    });
    renderHook(() => useCloudCapabilityRestored(onRestored));

    act(() => {
      useAuthStore.setState({ status: "unverified" });
    });
    act(() => {
      useAuthStore.setState({ status: "signed-in" });
    });
    expect(onRestored).toHaveBeenCalledTimes(1);

    act(() => {
      useAuthStore.setState({ status: "unverified" });
    });
    act(() => {
      useAuthStore.setState({ status: "signed-in" });
    });
    expect(onRestored).toHaveBeenCalledTimes(2);
  });

  it("drops its subscription on unmount", () => {
    const onRestored = vi.fn();
    act(() => {
      useAuthStore.setState({ status: "unverified" });
    });
    const hook = renderHook(() => useCloudCapabilityRestored(onRestored));
    hook.unmount();

    act(() => {
      useAuthStore.setState({ status: "signed-in" });
    });
    expect(onRestored).not.toHaveBeenCalled();
  });

  /**
   * The end-to-end of T23, with the REAL pacer rather than a spy: a demotion
   * walks the streak to its ceiling on one endpoint, and the promotion back
   * has to make the very next rebuild immediate. Asserting the delay - not
   * that a callback ran - is what makes this about the dark window a person
   * actually sees.
   */
  it("releases a real pacer's ceiling backoff so the rebuild after verification is instant", () => {
    const pacer = createHostReconnectEngine().createRebuildPacer();
    let rebuilds = 0;
    const onRestored = (): void => {
      pacer.clearStreak();
      rebuilds += 1;
    };

    act(() => {
      useAuthStore.setState({ status: "signed-in" });
    });
    renderHook(() => useCloudCapabilityRestored(onRestored));

    // The demotion force-closes the held session; every rebuild under the
    // withdrawn capability dies on the same endpoint.
    act(() => {
      useAuthStore.setState({ status: "unverified" });
    });
    let t = 0;
    pacer.markBuilt(t, "endpoint-a");
    expect(pacer.nextRebuildDelayMs(t)).toBe(0);
    for (const expected of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]) {
      t += 10;
      pacer.markBuilt(t, "endpoint-a");
      expect(pacer.nextRebuildDelayMs(t)).toBe(expected);
    }

    // Verification returns. The transport key never moved and no client ever
    // lived long enough, so without the wake this pacer still answers 30_000.
    act(() => {
      useAuthStore.setState({ status: "signed-in" });
    });
    expect(rebuilds).toBe(1);
    t += 10;
    pacer.markBuilt(t, "endpoint-a");
    expect(pacer.nextRebuildDelayMs(t)).toBe(0);
  });
});
