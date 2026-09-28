import { describe, expect, it, vi } from "vitest";
import { installCrossWindowRehydrate } from "@/lib/persist/cross-window-rehydrate";

function fakeStore(): {
  readonly persist: { rehydrate: () => void };
  readonly calls: () => number;
} {
  const rehydrate = vi.fn();
  return { persist: { rehydrate }, calls: () => rehydrate.mock.calls.length };
}

describe("installCrossWindowRehydrate", () => {
  it("rehydrates on a storage event for its own key", () => {
    const store = fakeStore();
    installCrossWindowRehydrate(store, "test:own-key");

    window.dispatchEvent(new StorageEvent("storage", { key: "test:own-key" }));

    expect(store.calls()).toBe(1);
  });

  it("ignores a storage event for another key", () => {
    const store = fakeStore();
    installCrossWindowRehydrate(store, "test:mine");

    window.dispatchEvent(new StorageEvent("storage", { key: "test:theirs" }));

    expect(store.calls()).toBe(0);
  });

  it("treats a null key (localStorage.clear()) as its own", () => {
    // Otherwise the store keeps values whose storage is gone - what "sign out
    // in the other window" looks like from here.
    const store = fakeStore();
    installCrossWindowRehydrate(store, "test:cleared");

    window.dispatchEvent(new StorageEvent("storage", { key: null }));

    expect(store.calls()).toBe(1);
  });

  it("installs once per key, however many callers ask", () => {
    // Module-load call sites cannot coordinate, so a second import must not
    // leave two listeners rehydrating the store twice per event.
    const first = fakeStore();
    const second = fakeStore();
    installCrossWindowRehydrate(first, "test:once");
    installCrossWindowRehydrate(second, "test:once");

    window.dispatchEvent(new StorageEvent("storage", { key: "test:once" }));

    expect(first.calls()).toBe(1);
    expect(second.calls()).toBe(0);
  });
});
