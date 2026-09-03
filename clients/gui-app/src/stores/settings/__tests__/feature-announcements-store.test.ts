import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isFeatureAnnouncementConsumed,
  useFeatureAnnouncementsStore,
} from "@/stores/settings/feature-announcements-store";

const PERSIST_KEY = "traycer-gui-app:feature-announcements";

function resetFeatureAnnouncementsStore(): void {
  window.localStorage.clear();
  useFeatureAnnouncementsStore.setState({ consumed: {} });
}

describe("useFeatureAnnouncementsStore", () => {
  beforeEach(resetFeatureAnnouncementsStore);
  afterEach(resetFeatureAnnouncementsStore);

  it("persists under the expected localStorage key", () => {
    expect(PERSIST_KEY).toBe("traycer-gui-app:feature-announcements");
  });

  it("consume() records a timestamp for the id", () => {
    useFeatureAnnouncementsStore.getState().consume("login-import");

    const consumed = useFeatureAnnouncementsStore.getState().consumed;
    expect(isFeatureAnnouncementConsumed(consumed, "login-import")).toBe(true);
    expect(typeof consumed["login-import"]).toBe("number");
  });

  it("is idempotent: a second consume() keeps the first timestamp", () => {
    useFeatureAnnouncementsStore.getState().consume("login-import");
    const firstTimestamp =
      useFeatureAnnouncementsStore.getState().consumed["login-import"];

    useFeatureAnnouncementsStore.getState().consume("login-import");

    expect(
      useFeatureAnnouncementsStore.getState().consumed["login-import"],
    ).toBe(firstTimestamp);
  });

  it("isFeatureAnnouncementConsumed answers false for an unconsumed id", () => {
    const consumed = useFeatureAnnouncementsStore.getState().consumed;
    expect(isFeatureAnnouncementConsumed(consumed, "login-import")).toBe(false);
  });

  it("persists only the consumed map (partialize)", () => {
    useFeatureAnnouncementsStore.getState().consume("login-import");

    const raw = window.localStorage.getItem(PERSIST_KEY);
    if (raw === null) {
      throw new Error("Expected a persisted blob");
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || !("state" in parsed)) {
      throw new Error("Expected a zustand-persist envelope");
    }
    const state = (parsed as { readonly state: unknown }).state;
    expect(Object.keys(state as object)).toEqual(["consumed"]);
  });

  it("merge drops an id this build does not know", async () => {
    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        state: { consumed: { "login-import": 100, "future-feature": 200 } },
        version: 1,
      }),
    );

    await useFeatureAnnouncementsStore.persist.rehydrate();

    const consumed = useFeatureAnnouncementsStore.getState().consumed;
    expect(consumed["login-import"]).toBe(100);
    expect("future-feature" in consumed).toBe(false);
  });

  it("merge drops a non-finite timestamp", async () => {
    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        state: { consumed: { "login-import": Number.NaN } },
        version: 1,
      }),
    );

    await useFeatureAnnouncementsStore.persist.rehydrate();

    expect(
      isFeatureAnnouncementConsumed(
        useFeatureAnnouncementsStore.getState().consumed,
        "login-import",
      ),
    ).toBe(false);
  });

  it("reads a corrupt blob as nothing consumed", async () => {
    window.localStorage.setItem(PERSIST_KEY, "{not json");

    await useFeatureAnnouncementsStore.persist.rehydrate();

    expect(useFeatureAnnouncementsStore.getState().consumed).toEqual({});
  });

  it("reads a blob with a non-object consumed field as nothing consumed", async () => {
    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({ state: { consumed: "nope" }, version: 1 }),
    );

    await useFeatureAnnouncementsStore.persist.rehydrate();

    expect(useFeatureAnnouncementsStore.getState().consumed).toEqual({});
  });

  it("round-trips a valid persisted blob across rehydration", async () => {
    useFeatureAnnouncementsStore.getState().consume("login-import");
    const persisted = window.localStorage.getItem(PERSIST_KEY);
    if (persisted === null) {
      throw new Error("Expected persisted blob");
    }

    useFeatureAnnouncementsStore.setState({ consumed: {} });
    window.localStorage.setItem(PERSIST_KEY, persisted);
    await useFeatureAnnouncementsStore.persist.rehydrate();

    expect(
      isFeatureAnnouncementConsumed(
        useFeatureAnnouncementsStore.getState().consumed,
        "login-import",
      ),
    ).toBe(true);
  });
});
