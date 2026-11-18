import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { StoreApi } from "zustand/vanilla";
import { ActivityGroupOpenStoreProvider } from "@/stores/chats/activity-group-open-store";
import { createActivityGroupOpenStore } from "@/stores/chats/activity-group-open-store-core";
import {
  useActivityGroupOpen,
  type ActivityGroupOpenState,
} from "@/stores/chats/activity-group-open-store-context";

afterEach(() => {
  cleanup();
});

/** Renders `useActivityGroupOpen(groupId, defaultOpen)` under `store` and
 * hands back what it returned. */
function readOpen(
  store: StoreApi<ActivityGroupOpenState>,
  groupId: string,
  defaultOpen: boolean,
): boolean {
  const seen: boolean[] = [];
  function Probe(): null {
    seen.push(useActivityGroupOpen(groupId, defaultOpen));
    return null;
  }
  render(
    <ActivityGroupOpenStoreProvider store={store}>
      <Probe />
    </ActivityGroupOpenStoreProvider>,
  );
  const value = seen.at(-1);
  if (value === undefined) throw new Error("the probe did not render");
  return value;
}

describe("createActivityGroupOpenStore", () => {
  it("moves an id from openIds to closedIds when setOpen(true) is followed by setOpen(false)", () => {
    const store = createActivityGroupOpenStore(null);

    store.getState().setOpen("group-1", true);
    expect(store.getState().openIds.has("group-1")).toBe(true);
    expect(store.getState().closedIds.has("group-1")).toBe(false);

    store.getState().setOpen("group-1", false);
    expect(store.getState().openIds.has("group-1")).toBe(false);
    expect(store.getState().closedIds.has("group-1")).toBe(true);
  });
});

describe("useActivityGroupOpen", () => {
  it("returns false for an explicitly closed id and true for an untouched one", () => {
    const store = createActivityGroupOpenStore(null);
    store.getState().setOpen("closed-group", false);

    expect(readOpen(store, "closed-group", true)).toBe(false);
    expect(readOpen(store, "untouched-group", true)).toBe(true);
  });

  it("returns true for an explicitly opened id even when the default is closed", () => {
    const store = createActivityGroupOpenStore(null);
    store.getState().setOpen("opened-group", true);

    expect(readOpen(store, "opened-group", false)).toBe(true);
  });
});
