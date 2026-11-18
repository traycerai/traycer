import { beforeEach, describe, expect, it } from "vitest";
import { adoptLegacyPersistedKey } from "@/lib/persist/zustand-persist-lifecycle";

const NEW_KEY = "traycer-gui-app:composer-run-settings:user-alice";
const LEGACY_KEY = "traycer-gui-app:composer-run-settings:alice@example.com";

describe("adoptLegacyPersistedKey", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("moves the legacy value onto the new key and removes the legacy key when the new key is absent", () => {
    window.localStorage.setItem(LEGACY_KEY, "legacy-blob");

    adoptLegacyPersistedKey(NEW_KEY, LEGACY_KEY);

    expect(window.localStorage.getItem(NEW_KEY)).toBe("legacy-blob");
    expect(window.localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it("leaves the new key's own value in place, and the legacy key untouched, when both are present", () => {
    // Newer state wins outright: the guard returns as soon as it sees the new
    // key already written, before it ever reads or removes the legacy key.
    window.localStorage.setItem(NEW_KEY, "new-blob");
    window.localStorage.setItem(LEGACY_KEY, "legacy-blob");

    adoptLegacyPersistedKey(NEW_KEY, LEGACY_KEY);

    expect(window.localStorage.getItem(NEW_KEY)).toBe("new-blob");
    expect(window.localStorage.getItem(LEGACY_KEY)).toBe("legacy-blob");
  });

  it("is a no-op when legacyName is null", () => {
    window.localStorage.setItem(NEW_KEY, "new-blob");

    adoptLegacyPersistedKey(NEW_KEY, null);

    expect(window.localStorage.getItem(NEW_KEY)).toBe("new-blob");
    expect(window.localStorage.length).toBe(1);
  });

  it("is a no-op when legacyName equals name", () => {
    window.localStorage.setItem(NEW_KEY, "new-blob");

    adoptLegacyPersistedKey(NEW_KEY, NEW_KEY);

    expect(window.localStorage.getItem(NEW_KEY)).toBe("new-blob");
    expect(window.localStorage.length).toBe(1);
  });
});
