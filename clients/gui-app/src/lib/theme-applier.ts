import { formatHex8, parse, rgb, wcagContrast, type Rgb } from "culori";
import {
  buildFontFamilyValue,
  DEFAULT_UI_FONT_STACK,
} from "@/lib/default-font-stacks";
import {
  useSettingsStore,
  type ThemeMode,
} from "@/stores/settings/settings-store";
import {
  DEFAULT_THEME_PRESET,
  THEME_PRESETS,
  type ThemePreset,
} from "@/lib/theme-presets";
import { useThemeLibraryStore } from "@/stores/settings/theme-library-store";
import { getBuiltinThemeColors } from "@/lib/themes/builtin-palettes";
import {
  themeTokenNames,
  type ThemeDefinition,
} from "@/lib/themes/theme-definition";

/**
 * Imperative owner of the document-element theme attributes (`class`,
 * `data-theme`, `color-scheme`). Subscribes to the settings store and the
 * `matchMedia` listener at module load - outside React - so DOM mutations
 * land **before** React re-renders the component tree.
 *
 * Why this can't be a `useEffect` in `ThemeProvider`: React fires effects
 * during commit, and child effects fire before parent effects. xterm.js
 * captures its palette as a JS object via `getComputedStyle` inside a
 * `useMemo` during render. If `applyVariant` runs in `ThemeProvider`'s
 * effect (parent, last to fire), the child has already read the stale
 * cascade and pushed a stale `ITheme` into `term.options.theme`. The
 * surrounding Tailwind UI never showed this race because Tailwind utilities
 * resolve `var(...)` at paint time against the live cascade - they don't
 * snapshot the value into JS.
 *
 * The applier sidesteps the entire React commit cycle: store update
 * triggers the applier listener synchronously (Zustand calls listeners in
 * subscription order, all before returning from `setState`), DOM is
 * mutated, React's own subscriber then schedules the re-render, children
 * re-render, and `getComputedStyle` reads the freshly-classed DOM.
 */

export type ResolvedTheme = "light" | "dark";

function readSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "light";
  if (typeof window.matchMedia !== "function") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function resolve(theme: ThemeMode, system: ResolvedTheme): ResolvedTheme {
  if (theme === "dark" || theme === "light") return theme;
  return system;
}

function applyVariant(resolved: ResolvedTheme, preset: ThemePreset): void {
  const root = window.document.documentElement;
  root.classList.remove("light", "dark");
  root.classList.add(resolved);
  root.style.colorScheme = resolved;
  root.setAttribute("data-theme", preset);
}

let systemTheme: ResolvedTheme = readSystemTheme();
const resolvedListeners = new Set<() => void>();
let themeRevision = 0;
export function getThemeRevision(): number {
  return themeRevision;
}
export function getActiveThemeDefinition(): ThemeDefinition | null {
  const library = useThemeLibraryStore.getState();
  if (library.draft) return library.draft;
  const mode = resolve(useSettingsStore.getState().theme, systemTheme);
  return (
    library.themes.find(
      (theme) =>
        theme.id === library.selected[mode] && theme.appearance === mode,
    ) ?? null
  );
}
export function getActiveThemePreset(): ThemePreset {
  const custom = getActiveThemeDefinition();
  if (custom) return custom.base;
  const selected = useThemeLibraryStore.getState().selected[getResolvedTheme()];
  return (
    THEME_PRESETS.find(
      (preset) =>
        preset.id === (selected ?? useSettingsStore.getState().themePreset),
    )?.id ?? DEFAULT_THEME_PRESET
  );
}

function applyFromState(): void {
  if (typeof window === "undefined") return;
  const library = useThemeLibraryStore.getState();
  const custom = getActiveThemeDefinition();
  const mode = getResolvedTheme();
  const preset = getActiveThemePreset();
  applyVariant(mode, preset);
  const root = window.document.documentElement;
  for (const token of themeTokenNames) root.style.removeProperty(`--${token}`);
  const colors = { ...getBuiltinThemeColors(preset, mode), ...custom?.colors };
  for (const [token, color] of Object.entries(colors)) {
    root.style.setProperty(`--${token}`, color);
  }
  root.style.setProperty("--glass-opacity", String(library.glassOpacity / 100));
  root.toggleAttribute("data-glass-enabled", library.glassOpacity < 100);
  root.style.setProperty(
    "--traycer-font-prompt",
    library.promptFontFamily === null
      ? "var(--traycer-font-ui)"
      : buildFontFamilyValue(library.promptFontFamily, DEFAULT_UI_FONT_STACK),
  );
  root.style.setProperty("--prompt-font-size", `${library.promptFontSize}px`);
  root.style.setProperty(
    "--appearance-ligatures",
    library.fontLigatures ? "normal" : "none",
  );
  root.toggleAttribute("data-reduce-panel-motion", !library.panelAnimations);
  root.style.setProperty(
    "--panel-animation-duration",
    `${library.panelAnimationDuration}ms`,
  );
  applyContrast(root, library.contrast, library.glassOpacity / 100);
  root.setAttribute("data-theme-id", custom?.id ?? preset);
  root.toggleAttribute(
    "data-theme-sidebar-artwork",
    custom?.sidebarArtwork === true,
  );
  themeRevision += 1;
}

/**
 * Surfaces whose solid token never reaches the screen on its own: the glass
 * rules in `styles/theme-surfaces.css` tint them at `--glass-opacity` over the
 * page, so a foreground optimized against the solid value is optimized against
 * a colour that never ships. The raw (unfloored) opacity is used deliberately -
 * dialogs floor theirs at 0.8, so the most translucent case is the
 * conservative one for every surface sharing the token.
 */
const GLASS_BACKGROUNDS = new Set(["card", "popover"]);

function mixRgb(from: Rgb, to: Rgb, amount: number): Rgb {
  return {
    mode: "rgb",
    r: from.r + (to.r - from.r) * amount,
    g: from.g + (to.g - from.g) * amount,
    b: from.b + (to.b - from.b) * amount,
    alpha: from.alpha,
  };
}

function applyContrast(
  root: HTMLElement,
  contrast: number,
  glassOpacity: number,
): void {
  if (contrast !== 100) {
    const computed = getComputedStyle(root);
    const page = parse(computed.getPropertyValue("--background").trim());
    for (const [foreground, background] of [
      ["foreground", "background"],
      ["muted-foreground", "background"],
      ["canvas-foreground", "canvas"],
      ["card-foreground", "card"],
      ["popover-foreground", "popover"],
      ["border", "background"],
      ["canvas-border", "canvas"],
    ]) {
      const fg = parse(computed.getPropertyValue(`--${foreground}`).trim());
      const bg = parse(computed.getPropertyValue(`--${background}`).trim());
      if (!fg || !bg) continue;
      const source = rgb(fg);
      const surface =
        glassOpacity < 1 && page && GLASS_BACKGROUNDS.has(background)
          ? mixRgb(rgb(page), rgb(bg), glassOpacity)
          : rgb(bg);
      const destination =
        contrast < 100
          ? surface
          : rgb(
              wcagContrast(surface, "#fff") > wcagContrast(surface, "#000")
                ? { mode: "rgb", r: 1, g: 1, b: 1 }
                : { mode: "rgb", r: 0, g: 0, b: 0 },
            );
      root.style.setProperty(
        `--${foreground}`,
        formatHex8(mixRgb(source, destination, Math.abs(contrast - 100) / 100)),
      );
    }
  }
}

function notify(): void {
  for (const listener of resolvedListeners) listener();
}

let installed = false;

function install(): void {
  if (installed) return;
  installed = true;
  if (typeof window === "undefined") return;

  // Initial sync. Zustand's `persist` middleware rehydrates from
  // localStorage synchronously during store creation, which runs before
  // this module's import side effects, so `getState()` is already
  // populated with the user's persisted preference.
  applyFromState();

  useSettingsStore.subscribe((state, prev) => {
    if (state.theme === prev.theme && state.themePreset === prev.themePreset) {
      return;
    }
    applyFromState();
    notify();
  });

  useThemeLibraryStore.subscribe((state, prev) => {
    if (
      state.themes === prev.themes &&
      state.selected === prev.selected &&
      state.draft === prev.draft &&
      state.glassOpacity === prev.glassOpacity &&
      state.promptFontFamily === prev.promptFontFamily &&
      state.promptFontSize === prev.promptFontSize &&
      state.fontLigatures === prev.fontLigatures &&
      state.panelAnimations === prev.panelAnimations &&
      state.panelAnimationDuration === prev.panelAnimationDuration &&
      state.contrast === prev.contrast
    )
      return;
    applyFromState();
    notify();
  });

  if (typeof window.matchMedia === "function") {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", () => {
      const next = readSystemTheme();
      if (next === systemTheme) return;
      systemTheme = next;
      // OS pref only affects the resolved value when the user picked
      // "system"; otherwise the cascade is already correct and a re-emit
      // would be a no-op for downstream consumers.
      if (useSettingsStore.getState().theme !== "system") return;
      applyFromState();
      notify();
    });
  }
}

install();

/**
 * `useSyncExternalStore` snapshot. Returns the current resolved
 * light/dark mode without touching the DOM. Stable identity across
 * renders for the same logical state - primitives compare by value.
 */
export function getResolvedTheme(): ResolvedTheme {
  return (
    useThemeLibraryStore.getState().draft?.appearance ??
    resolve(useSettingsStore.getState().theme, systemTheme)
  );
}

/**
 * `useSyncExternalStore` subscribe. Listener fires after DOM has been
 * mutated, so any consumer that re-reads `getComputedStyle` in response
 * sees the new cascade.
 */
export function subscribeResolvedTheme(listener: () => void): () => void {
  resolvedListeners.add(listener);
  return () => {
    resolvedListeners.delete(listener);
  };
}
