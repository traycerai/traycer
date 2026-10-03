import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { useCommandPaletteStore } from "../command-palette-store";

const STORAGE_KEY = "traycer-gui-app:command-palette";

function resetStore(): void {
  useCommandPaletteStore.setState({
    open: false,
    query: "",
    recentIds: [],
    pinnedIds: [],
  });
}

// Some environments run the jsdom setup's `installMockLocalStorage()`
// fallback (own-property methods on the `window.localStorage` instance
// itself, not inherited from `Storage.prototype` - see
// `__tests__/test-browser-apis.ts`), so a spy must target whichever one is
// actually live rather than assuming the prototype.
function storageSpyTarget(): Storage {
  return Object.hasOwn(window.localStorage, "setItem")
    ? window.localStorage
    : Storage.prototype;
}

describe("command palette store: shallow-gated localStorage writes", () => {
  let setItemSpy: MockInstance<typeof Storage.prototype.setItem>;

  function storeWrites(): number {
    return setItemSpy.mock.calls.filter(([key]) => key === STORAGE_KEY).length;
  }

  beforeEach(() => {
    window.localStorage.clear();
    resetStore();
    setItemSpy = vi.spyOn(storageSpyTarget(), "setItem");
  });

  afterEach(() => {
    setItemSpy.mockRestore();
    resetStore();
    window.localStorage.clear();
  });

  it("opening the palette and typing a query never touches localStorage", () => {
    useCommandPaletteStore.getState().setOpen(true);
    useCommandPaletteStore.getState().setQuery("h");
    useCommandPaletteStore.getState().setQuery("he");
    useCommandPaletteStore.getState().setQuery("hel");
    useCommandPaletteStore.getState().setOpen(false);
    expect(storeWrites()).toBe(0);
  });

  it("a redundant recordUse that reproduces the same persisted array by value is skipped, not just deduped by reference", () => {
    useCommandPaletteStore.getState().recordUse("a");
    expect(storeWrites()).toBe(1);

    // "a" is already at the front: the action still builds a brand-new array
    // ([id, ...without]), but its VALUES are unchanged - this is exactly the
    // case a naive "did the reference change" check would miss.
    useCommandPaletteStore.getState().recordUse("a");
    expect(useCommandPaletteStore.getState().recentIds).toEqual(["a"]);
    expect(storeWrites()).toBe(1);

    useCommandPaletteStore.getState().recordUse("b");
    expect(storeWrites()).toBe(2);
  });

  it("hydration seeds the shallow baseline so a same-value write right after reload is skipped", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        state: { recentIds: ["z"], pinnedIds: ["p"] },
      }),
    );
    await useCommandPaletteStore.persist.rehydrate();
    setItemSpy.mockClear();

    // "z" is already at the front of the just-hydrated recentIds.
    useCommandPaletteStore.getState().recordUse("z");
    expect(storeWrites()).toBe(0);
  });
});
