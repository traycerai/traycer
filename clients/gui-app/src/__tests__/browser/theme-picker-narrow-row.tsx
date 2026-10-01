import { useEffect, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { ThemeGallery } from "@/components/settings/themes/theme-gallery";
import { createThemeFromPreset } from "@/lib/themes/theme-library";
import type { ThemeDefinition } from "@/lib/themes/theme-definition";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useThemeLibraryStore } from "@/stores/settings/theme-library-store";
import "@/lib/theme-applier";
import "@/components/settings/settings-touch-targets.css";
import "@/index.css";

/**
 * THE LIGHT/DARK THEME ROWS AT EVERY WIDTH: the real `ThemeGallery` inside the
 * markup the Appearance panel wraps it in - the coarse-pointer settings scope,
 * the panel shell, and the `@container` the picker's `cqw` width is a share of.
 *
 * What the rows do at phone width is a question about flex line-breaking, a
 * container query, and where a line box falls - none of which jsdom has. So
 * `scripts/theme-picker-narrow-row-browser.mjs` drives this fixture and reads
 * geometry: whether the control wrapped, how wide it then is against the row it
 * wrapped inside, and whether any word of the theme's name was split across
 * lines.
 *
 * `window.__probeApply` puts the rows into one case at a time: a built-in
 * selection (the longest preset label), a personal theme whose name is several
 * long words, and one whose name is a single unbroken word - a name is user
 * input, so nothing bounds it. It also raises the two other states these rows
 * have: an open draft, which disables both pencils, and a library error, which
 * puts an alert under the card.
 */
const BUILTIN = "Traycer Green";
const NAMES = [
  BUILTIN,
  "Midnight Harbour Contrast High",
  "Supercalifragilisticexpialidocious",
] as const;

interface ProbeCase {
  readonly name: string;
  readonly draft: boolean;
  readonly error: boolean;
}

interface ProbeWindow extends Window {
  __probeNames?: ReadonlyArray<string>;
  __probeBuiltin?: string;
  __probeApply?: (probeCase: ProbeCase) => void;
  __probeReady?: boolean;
}

/** A saved theme under a given name - what a user's own theme looks like. */
function personalTheme(
  name: string,
  appearance: "light" | "dark",
): ThemeDefinition {
  return {
    ...createThemeFromPreset("traycer-green", appearance),
    id: `probe-${appearance}`,
    name,
  };
}

const probeWindow: ProbeWindow = window;
probeWindow.__probeNames = NAMES;
probeWindow.__probeBuiltin = BUILTIN;
probeWindow.__probeApply = (probeCase) => {
  const builtin = probeCase.name === BUILTIN;
  useSettingsStore.getState().setThemePreset("traycer-green");
  useThemeLibraryStore.setState({
    themes: builtin
      ? []
      : [
          personalTheme(probeCase.name, "light"),
          personalTheme(probeCase.name, "dark"),
        ],
    selected: builtin
      ? { light: null, dark: null }
      : { light: "probe-light", dark: "probe-dark" },
    draft: probeCase.draft ? personalTheme("Draft in progress", "light") : null,
    error: probeCase.error
      ? "That theme file could not be read. It may have been written by a newer version."
      : null,
  });
};

export function ThemePickerNarrowRowFixture(): ReactElement {
  useEffect(() => {
    probeWindow.__probeReady = true;
  }, []);
  return (
    // `settings-surface.tsx`'s scope and scroll pane, then the Appearance
    // panel's own body wrapper - the `@container` the picker measures against.
    <div
      data-settings-touch-scope
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground"
    >
      <div
        data-settings-panel-pane
        className="min-h-0 min-w-0 flex-1 overflow-y-auto"
      >
        <SettingsPanelShell
          title="Appearance"
          description="Themes, fonts, and display preferences."
          bodyClassName="overflow-visible rounded-none border-none bg-transparent"
        >
          <div className="@container flex flex-col gap-8">
            <ThemeGallery />
          </div>
        </SettingsPanelShell>
      </div>
    </div>
  );
}

const container = document.querySelector("#root");
if (container === null) throw new Error("probe root missing");
createRoot(container).render(<ThemePickerNarrowRowFixture />);
