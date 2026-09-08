import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { persistKey, STORE_KEYS } from "@/lib/persist";
import { useThemeLibraryStore } from "@/stores/settings/theme-library-store";
import type { ThemeDefinition } from "@/lib/themes/theme-definition";

const PERSIST_KEY = persistKey(STORE_KEYS.themeLibrary);

function theme(id: string, appearance: "light" | "dark"): ThemeDefinition {
  return {
    version: 1,
    id,
    name: id,
    appearance,
    base: "neutral",
    colors: { primary: "#123456ff" },
    syntax: null,
  };
}

function resetStore(): void {
  window.localStorage.clear();
  useThemeLibraryStore.setState({
    version: 1,
    themes: [],
    selected: { light: null, dark: null },
    glassOpacity: 100,
    draft: null,
    error: null,
  });
}

describe("useThemeLibraryStore", () => {
  beforeEach(resetStore);
  afterEach(resetStore);

  it("saves a draft, selects it for its appearance, and cancels drafts", () => {
    const light = theme("light-theme", "light");
    const store = useThemeLibraryStore.getState();
    store.setDraft(light);
    expect(useThemeLibraryStore.getState().draft).toBe(light);

    expect(store.saveTheme(light)).toBe(true);
    expect(useThemeLibraryStore.getState().draft).toBeNull();
    expect(useThemeLibraryStore.getState().selected.light).toBe(light.id);

    useThemeLibraryStore.getState().setDraft(light);
    useThemeLibraryStore.getState().cancelDraft();
    expect(useThemeLibraryStore.getState().draft).toBeNull();
  });

  it("keeps state unchanged when durable storage reports quota failure", () => {
    const originalWindowStorage = window.localStorage;
    const originalGlobalStorage = globalThis.localStorage;
    const storage: Storage = {
      get length() {
        return originalWindowStorage.length;
      },
      clear: originalWindowStorage.clear.bind(originalWindowStorage),
      getItem: originalWindowStorage.getItem.bind(originalWindowStorage),
      key: originalWindowStorage.key.bind(originalWindowStorage),
      removeItem: originalWindowStorage.removeItem.bind(originalWindowStorage),
      setItem: () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
    };
    vi.stubGlobal("localStorage", storage);
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      writable: true,
      value: storage,
    });

    try {
      expect(
        useThemeLibraryStore.getState().saveTheme(theme("quota", "dark")),
      ).toBe(false);
      expect(useThemeLibraryStore.getState().themes).toEqual([]);
      expect(useThemeLibraryStore.getState().error).toBe(
        "Theme changes could not be saved.",
      );
      expect(window.localStorage.getItem(PERSIST_KEY)).toBeNull();
    } finally {
      vi.stubGlobal("localStorage", originalGlobalStorage);
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        writable: true,
        value: originalWindowStorage,
      });
    }
  });

  it("reports invalid storage when another window reloads the library", () => {
    window.localStorage.setItem(PERSIST_KEY, "not-json");
    window.dispatchEvent(new StorageEvent("storage", { key: PERSIST_KEY }));
    expect(useThemeLibraryStore.getState().error).toContain(
      "could not be read",
    );
  });

  it("blocks writes until corrupt storage is explicitly reset", () => {
    const saved = theme("saved", "light");
    expect(useThemeLibraryStore.getState().saveTheme(saved)).toBe(true);
    window.localStorage.setItem(PERSIST_KEY, "not-json");

    expect(
      useThemeLibraryStore.getState().saveTheme(theme("blocked", "dark")),
    ).toBe(false);
    expect(useThemeLibraryStore.getState().themes).toEqual([saved]);
    expect(window.localStorage.getItem(PERSIST_KEY)).toBe("not-json");

    expect(useThemeLibraryStore.getState().resetLibrary()).toBe(true);
    expect(useThemeLibraryStore.getState().themes).toEqual([]);
    expect(useThemeLibraryStore.getState().selected).toEqual({
      light: null,
      dark: null,
    });
    expect(window.localStorage.getItem(PERSIST_KEY)).not.toBe("not-json");
  });

  it("preserves corrupt storage and state when reset cannot write", () => {
    const saved = theme("saved", "light");
    expect(useThemeLibraryStore.getState().saveTheme(saved)).toBe(true);
    window.localStorage.setItem(PERSIST_KEY, "not-json");
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("quota", "QuotaExceededError");
      });

    try {
      expect(useThemeLibraryStore.getState().resetLibrary()).toBe(false);
      expect(useThemeLibraryStore.getState().themes).toEqual([saved]);
      expect(useThemeLibraryStore.getState().selected).toEqual({
        light: saved.id,
        dark: null,
      });
      expect(window.localStorage.getItem(PERSIST_KEY)).toBe("not-json");
    } finally {
      setItem.mockRestore();
    }
  });

  it("tracks independent light and dark selections and rejects a mismatched mode", () => {
    const light = theme("light-theme", "light");
    const dark = theme("dark-theme", "dark");
    expect(useThemeLibraryStore.getState().saveThemes([light, dark])).toBe(
      true,
    );
    expect(useThemeLibraryStore.getState().selected).toEqual({
      light: light.id,
      dark: dark.id,
    });

    expect(useThemeLibraryStore.getState().selectTheme("light", dark.id)).toBe(
      false,
    );
    expect(useThemeLibraryStore.getState().selected.light).toBe(light.id);
    expect(useThemeLibraryStore.getState().selectTheme("dark", dark.id)).toBe(
      true,
    );
  });

  it("replaces every variant in an imported collection and clears obsolete selections", () => {
    const collection = { id: "vsix:fixture.pack", name: "Fixture pack" };
    const oldLight = { ...theme("old-light", "light"), collection };
    const oldDark = { ...theme("old-dark", "dark"), collection };
    const oldDarkAlternate = {
      ...theme("old-dark-alternate", "dark"),
      collection,
    };
    const replacementLight = { ...theme("new-light", "light"), collection };
    const replacementDark = { ...theme("new-dark", "dark"), collection };
    useThemeLibraryStore.setState({
      themes: [oldLight, oldDark, oldDarkAlternate],
      selected: { light: oldLight.id, dark: oldDarkAlternate.id },
    });
    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        version: 1,
        themes: [oldLight, oldDark, oldDarkAlternate],
        selected: { light: oldLight.id, dark: oldDarkAlternate.id },
        glassOpacity: 100,
      }),
    );

    expect(
      useThemeLibraryStore
        .getState()
        .installThemes(
          [replacementLight, replacementDark],
          [collection.id],
          null,
        ),
    ).toBe(true);
    expect(useThemeLibraryStore.getState().themes).toEqual([
      replacementLight,
      replacementDark,
    ]);
    expect(useThemeLibraryStore.getState().selected).toEqual({
      light: null,
      dark: null,
    });
  });

  it("keeps a sibling when a single JSON variant updates by ID", () => {
    const collection = { id: "json:pair", name: "JSON pair" };
    const light = { ...theme("json-light", "light"), collection };
    const dark = { ...theme("json-dark", "dark"), collection };
    expect(useThemeLibraryStore.getState().saveThemes([light, dark])).toBe(
      true,
    );

    const updatedLight = {
      ...light,
      colors: { primary: "#abcdefff" },
    };
    expect(
      useThemeLibraryStore.getState().installThemes([updatedLight], [], null),
    ).toBe(true);

    expect(useThemeLibraryStore.getState().themes).toEqual([
      dark,
      updatedLight,
    ]);
  });

  it("replaces only listed VSIX collections in a mixed import", () => {
    const collectionA = { id: "vsix:a", name: "A" };
    const collectionB = { id: "vsix:b", name: "B" };
    const oldA = { ...theme("old-a", "dark"), collection: collectionA };
    const oldAOther = {
      ...theme("old-a-other", "light"),
      collection: collectionA,
    };
    const oldB = { ...theme("old-b", "dark"), collection: collectionB };
    const oldBOther = {
      ...theme("old-b-other", "light"),
      collection: collectionB,
    };
    const json = theme("plain-json", "light");
    expect(
      useThemeLibraryStore
        .getState()
        .saveThemes([oldA, oldAOther, oldB, oldBOther, json]),
    ).toBe(true);

    const updatedJson = { ...json, colors: { primary: "#abcdefff" } };
    const replacementA = {
      ...theme("replacement-a", "dark"),
      collection: collectionA,
    };
    expect(
      useThemeLibraryStore
        .getState()
        .installThemes([updatedJson, replacementA], [collectionA.id], null),
    ).toBe(true);

    const themes = useThemeLibraryStore.getState().themes;
    expect(themes).toHaveLength(4);
    expect(themes).toContainEqual(replacementA);
    expect(themes).not.toContainEqual(oldA);
    expect(themes).not.toContainEqual(oldAOther);
    expect(themes).toContainEqual(oldB);
    expect(themes).toContainEqual(oldBOther);
    expect(themes).toContainEqual(updatedJson);
  });

  it("rejects an import when durable storage changed without a storage event", () => {
    const collection = { id: "vsix:stale", name: "Stale" };
    const original = { ...theme("stale", "dark"), collection };
    expect(useThemeLibraryStore.getState().saveTheme(original)).toBe(true);
    const incoming = {
      ...original,
      colors: { primary: "#abcdefff" },
    };
    const baseline = JSON.stringify([original]);
    const durable = {
      ...original,
      colors: { primary: "#fedcbaff" },
    };
    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        version: 1,
        themes: [durable],
        selected: { light: null, dark: durable.id },
        glassOpacity: 100,
      }),
    );

    expect(
      useThemeLibraryStore
        .getState()
        .installThemes([incoming], [collection.id], baseline),
    ).toBe(false);
    expect(useThemeLibraryStore.getState().themes).toEqual([original]);
    expect(useThemeLibraryStore.getState().error).toContain(
      "changed while you were reviewing",
    );
  });
});
