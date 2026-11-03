import { beforeEach, describe, expect, it, vi } from "vitest";

const PERSIST_KEY = "traycer-gui-app:verified-profile-cache";
const PROFILE = {
  avatarUrl: "https://example.com/ada.png",
  displayName: "Ada Lovelace",
};

function loadStore() {
  return import("@/stores/auth/verified-profile-cache-store");
}

beforeEach(() => {
  window.localStorage.clear();
  vi.resetModules();
});

describe("verified profile cache", () => {
  it("hands a relaunch what the last launch remembered", async () => {
    const lastLaunch = await loadStore();
    lastLaunch.useVerifiedProfileCacheStore
      .getState()
      .remember("user-1", PROFILE);

    vi.resetModules();
    const relaunched = await loadStore();

    expect(relaunched.readVerifiedProfile("user-1")).toEqual(PROFILE);
  });

  it("takes another window's sign-out without holding the old entry", async () => {
    const store = await loadStore();
    store.useVerifiedProfileCacheStore.getState().remember("user-1", PROFILE);

    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({ state: { profilesByUserId: {} }, version: 1 }),
    );
    window.dispatchEvent(new StorageEvent("storage", { key: PERSIST_KEY }));

    await vi.waitFor(() => {
      expect(store.readVerifiedProfile("user-1")).toBeNull();
    });
  });
});
