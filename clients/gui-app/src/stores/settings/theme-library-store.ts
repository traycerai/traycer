import { create } from "zustand";
import { z } from "zod";
import { persistKey, STORE_KEYS } from "@/lib/persist/keys";
import {
  ensureVisibleThemeBorders,
  themeDefinitionSchema,
  type ThemeDefinition,
} from "@/lib/themes/theme-definition";
import { THEME_PRESETS } from "@/lib/theme-presets";
import { getThemeImportConflicts } from "@/lib/themes/theme-library";

const librarySchema = z.object({
  version: z.literal(2),
  themes: z.array(themeDefinitionSchema).max(500),
  selected: z.object({
    light: z.string().nullable(),
    dark: z.string().nullable(),
  }),
  glassOpacity: z.number().min(30).max(100),
  promptFontFamily: z.string().max(200).nullable().default(null),
  promptFontSize: z.number().min(10).max(24).default(14),
  fontLigatures: z.boolean().default(true),
  panelAnimations: z.boolean().default(true),
  panelAnimationDuration: z.number().min(0).max(500).default(100),
  contrast: z.number().min(70).max(130).default(100),
});
interface Library {
  version: 2;
  themes: ThemeDefinition[];
  selected: { light: string | null; dark: string | null };
  glassOpacity: number;
  promptFontFamily: string | null;
  promptFontSize: number;
  fontLigatures: boolean;
  panelAnimations: boolean;
  panelAnimationDuration: number;
  contrast: number;
}
interface ThemeLibraryState extends Library {
  draft: ThemeDefinition | null;
  error: string | null;
  setDraft: (theme: ThemeDefinition | null) => void;
  cancelDraft: () => void;
  saveTheme: (theme: ThemeDefinition) => boolean;
  saveThemes: (themes: ThemeDefinition[]) => boolean;
  installThemes: (
    themes: ThemeDefinition[],
    replaceCollectionIds: string[],
    expectedBaseline: string | null,
  ) => boolean;
  deleteTheme: (id: string) => boolean;
  selectTheme: (appearance: "light" | "dark", id: string | null) => boolean;
  setGlassOpacity: (opacity: number) => boolean;
  clearSelection: () => boolean;
  resetLibrary: () => boolean;
  setAppearancePreference: (
    preference: Partial<
      Pick<
        Library,
        | "promptFontFamily"
        | "promptFontSize"
        | "fontLigatures"
        | "panelAnimations"
        | "panelAnimationDuration"
        | "contrast"
      >
    >,
  ) => boolean;
}
const key = persistKey(STORE_KEYS.themeLibrary);
const emptyLibrary: Library = {
  version: 2,
  themes: [],
  selected: { light: null, dark: null },
  glassOpacity: 100,
  promptFontFamily: null,
  promptFontSize: 14,
  fontLigatures: true,
  panelAnimations: true,
  panelAnimationDuration: 100,
  contrast: 100,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * v1 -> v2: a VS Code theme imported before `theme-import.ts` started
 * repairing collapsed borders at import time (`ensureVisibleThemeBorders`)
 * is already sitting in `themes` with invisible canvas-border/border/input
 * tokens, and nothing else will ever repair it now that the applier no
 * longer does a second, apply-time pass. Runs once per rehydrate, gated on
 * the stored `version` below - a theme whose borders are already visible
 * comes back byte-identical (`ensureVisibleThemeBorders` returns no
 * overrides for it), so this is safe to run every time a v1 blob is read,
 * not just the first.
 */
function migrateLibraryBorders(themes: unknown): unknown {
  if (!Array.isArray(themes)) return themes;
  return themes.map((entry: unknown) => {
    const parsed = themeDefinitionSchema.safeParse(entry);
    if (!parsed.success) return entry;
    // Only a theme with a non-null `syntax` was ever imported from VS Code -
    // that is the provenance marker `createThemeFromPreset` hardcodes to
    // `null`. The repair targets imported themes whose borders collapsed
    // against Traycer's surfaces; Traycer's own presets sit intentionally
    // below the 1.3 floor for those tokens, so they must never be "repaired".
    if (parsed.data.syntax === null) return entry;
    const overrides = ensureVisibleThemeBorders(parsed.data.colors);
    if (Object.keys(overrides).length === 0) return entry;
    return {
      ...parsed.data,
      colors: { ...parsed.data.colors, ...overrides },
    } satisfies ThemeDefinition;
  });
}

function migrateLibraryToV2(value: unknown): unknown {
  if (!isRecord(value) || value.version !== 1) return value;
  return {
    ...value,
    version: 2,
    themes: migrateLibraryBorders(value.themes),
  };
}

function readLibrary(): Library {
  if (typeof localStorage === "undefined") return emptyLibrary;
  const raw = localStorage.getItem(key);
  if (raw === null) return emptyLibrary;
  try {
    return librarySchema.parse(migrateLibraryToV2(JSON.parse(raw)));
  } catch {
    throw new Error(
      "Your saved theme library could not be read. Reset the library to start again, or recover the stored data before resetting.",
    );
  }
}
let initial: Library = emptyLibrary;
let initialError: string | null = null;
try {
  initial = readLibrary();
} catch (error) {
  initialError =
    error instanceof Error ? error.message : "Theme storage is unavailable.";
}

/** Durable writes precede state changes: quota failures never masquerade as a saved theme. */
export const useThemeLibraryStore = create<ThemeLibraryState>((set, get) => {
  const update = (change: (library: Library) => Library): boolean => {
    try {
      const next = librarySchema.parse(change(readLibrary()));
      localStorage.setItem(key, JSON.stringify(next));
      set({ ...next, error: null });
      return true;
    } catch (error) {
      set({
        error:
          error instanceof Error
            ? error.message
            : "Theme changes could not be saved.",
      });
      return false;
    }
  };
  return {
    ...initial,
    draft: null,
    error: initialError,
    resetLibrary: () => {
      try {
        localStorage.setItem(key, JSON.stringify(emptyLibrary));
        set({ ...emptyLibrary, draft: null, error: null });
        return true;
      } catch {
        set({
          error:
            "The theme library could not be reset. Storage is unavailable.",
        });
        return false;
      }
    },
    setDraft: (draft) => set({ draft }),
    cancelDraft: () => set({ draft: null }),
    saveTheme: (theme) => get().saveThemes([theme]),
    saveThemes: (themes) => {
      const saved = update((library) => {
        const selected = { ...library.selected };
        for (const theme of themes) selected[theme.appearance] = theme.id;
        return {
          ...library,
          themes: [
            ...library.themes.filter(
              (entry) => !themes.some((theme) => entry.id === theme.id),
            ),
            ...themes,
          ],
          selected,
        };
      });
      if (saved) set({ draft: null });
      return saved;
    },
    installThemes: (themes, replaceCollectionIds, expectedBaseline) =>
      update((library) => {
        if (
          expectedBaseline !== null &&
          JSON.stringify(
            getThemeImportConflicts(
              library.themes,
              themes,
              replaceCollectionIds,
            ),
          ) !== expectedBaseline
        ) {
          throw new Error(
            "These themes changed while you were reviewing them. Review the import again or save copies to keep those changes.",
          );
        }
        const ids = new Set(themes.map((theme) => theme.id));
        if (ids.size !== themes.length)
          throw new Error("Import one version of each theme at a time.");
        const collections = new Set(replaceCollectionIds);
        if (
          replaceCollectionIds.some(
            (id) => !themes.some((theme) => theme.collection?.id === id),
          )
        ) {
          throw new Error(
            "A replacement theme pack is missing from this import.",
          );
        }
        const nextThemes = [
          ...library.themes.filter(
            (theme) =>
              !ids.has(theme.id) &&
              !(theme.collection && collections.has(theme.collection.id)),
          ),
          ...themes,
        ];
        const selected = { ...library.selected };
        for (const appearance of ["light", "dark"] as const) {
          const id = selected[appearance];
          if (
            id &&
            library.themes.some((theme) => theme.id === id) &&
            !nextThemes.some(
              (theme) => theme.id === id && theme.appearance === appearance,
            )
          )
            selected[appearance] = null;
        }
        return { ...library, selected, themes: nextThemes };
      }),
    deleteTheme: (id) =>
      update((library) => ({
        ...library,
        themes: library.themes.filter((theme) => theme.id !== id),
        selected: {
          light: library.selected.light === id ? null : library.selected.light,
          dark: library.selected.dark === id ? null : library.selected.dark,
        },
      })),
    selectTheme: (appearance, id) =>
      update((library) => {
        if (
          id !== null &&
          !THEME_PRESETS.some((preset) => preset.id === id) &&
          !library.themes.some(
            (theme) => theme.id === id && theme.appearance === appearance,
          )
        )
          throw new Error("This theme does not have that appearance.");
        return {
          ...library,
          selected: { ...library.selected, [appearance]: id },
        };
      }),
    setGlassOpacity: (glassOpacity) =>
      update((library) => ({ ...library, glassOpacity })),
    setAppearancePreference: (preference) =>
      update((library) => ({ ...library, ...preference })),
    clearSelection: () =>
      update((library) => ({
        ...library,
        selected: { light: null, dark: null },
      })),
  };
});
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== key && event.key !== null) return;
    try {
      useThemeLibraryStore.setState({ ...readLibrary(), error: null });
    } catch {
      useThemeLibraryStore.setState({
        error:
          "The theme library changed in another window but could not be read.",
      });
    }
  });
}
