import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LOCAL_SNAPSHOT_CLEAR_PERSIST_KEY,
  localSnapshotClearScopeKey,
  localSnapshotsClearedAt,
  useLocalSnapshotClearStore,
} from "@/stores/settings/local-snapshot-clear-store";

function resetLocalSnapshotClearStore(): void {
  window.localStorage.clear();
  useLocalSnapshotClearStore.setState({ clearedAtByScope: {} });
}

describe("useLocalSnapshotClearStore", () => {
  beforeEach(resetLocalSnapshotClearStore);
  afterEach(resetLocalSnapshotClearStore);

  it("scopes clear markers by user and host", () => {
    useLocalSnapshotClearStore
      .getState()
      .markCleared("owner-1", "host-1", 1200);

    const clearedAtByScope =
      useLocalSnapshotClearStore.getState().clearedAtByScope;

    expect(localSnapshotsClearedAt(clearedAtByScope, "owner-1", "host-1")).toBe(
      1200,
    );
    expect(
      localSnapshotsClearedAt(clearedAtByScope, "owner-1", "host-2"),
    ).toBeNull();
    expect(
      localSnapshotsClearedAt(clearedAtByScope, "owner-2", "host-1"),
    ).toBeNull();
  });

  it("persists clear markers across store rehydration", async () => {
    const scopeKey = localSnapshotClearScopeKey("owner-1", "host-1");
    useLocalSnapshotClearStore
      .getState()
      .markCleared("owner-1", "host-1", 1300);
    const persisted = window.localStorage.getItem(
      LOCAL_SNAPSHOT_CLEAR_PERSIST_KEY,
    );
    if (persisted === null) {
      throw new Error("Expected persisted clear marker");
    }

    useLocalSnapshotClearStore.setState({ clearedAtByScope: {} });
    window.localStorage.setItem(LOCAL_SNAPSHOT_CLEAR_PERSIST_KEY, persisted);
    await useLocalSnapshotClearStore.persist.rehydrate();

    expect(
      useLocalSnapshotClearStore.getState().clearedAtByScope[scopeKey],
    ).toBe(1300);
  });
});
