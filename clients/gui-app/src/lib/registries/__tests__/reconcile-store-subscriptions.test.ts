import { describe, expect, it, vi } from "vitest";
import { reconcileStoreSubscriptions } from "@/lib/registries/reconcile-store-subscriptions";

describe("reconcileStoreSubscriptions", () => {
  it("subscribes each new handle once and skips survivors", () => {
    const subs = new Map<string, () => void>();
    const subscribeOne = vi.fn(() => vi.fn());

    reconcileStoreSubscriptions(["a", "b"], subs, subscribeOne);
    expect(subscribeOne).toHaveBeenCalledTimes(2);
    expect([...subs.keys()]).toEqual(["a", "b"]);

    subscribeOne.mockClear();
    reconcileStoreSubscriptions(["a", "b", "c"], subs, subscribeOne);
    expect(subscribeOne).toHaveBeenCalledTimes(1);
    expect(subscribeOne).toHaveBeenCalledWith("c");
    expect([...subs.keys()]).toEqual(["a", "b", "c"]);
  });

  it("unsubscribes and drops handles that disappeared", () => {
    const subs = new Map<string, () => void>();
    const unsubA = vi.fn();
    const unsubB = vi.fn();
    const subscribeOne = (handle: string): (() => void) =>
      handle === "a" ? unsubA : unsubB;

    reconcileStoreSubscriptions(["a", "b"], subs, subscribeOne);

    reconcileStoreSubscriptions(["b"], subs, subscribeOne);
    expect(unsubA).toHaveBeenCalledTimes(1);
    expect(unsubB).not.toHaveBeenCalled();
    expect([...subs.keys()]).toEqual(["b"]);

    reconcileStoreSubscriptions([], subs, subscribeOne);
    expect(unsubB).toHaveBeenCalledTimes(1);
    expect(subs.size).toBe(0);
  });
});
