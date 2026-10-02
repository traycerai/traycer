import { useEffect, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { AppearanceSettingsPanel } from "@/components/settings/panels/appearance-settings-panel";
import { createThemeFromPreset } from "@/lib/themes/theme-library";
import type { ThemeDefinition } from "@/lib/themes/theme-definition";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useThemeLibraryStore } from "@/stores/settings/theme-library-store";
import "@/lib/theme-applier";
import "@/components/settings/settings-touch-targets.css";
import "@/index.css";

/**
 * THE LIGHT/DARK THEME ROWS AT EVERY WIDTH: the real Appearance panel, on its
 * Themes area, inside the coarse-pointer settings scope and scroll pane. The
 * panel itself is mounted rather than a copy of its wrapper, because the
 * `@container` the picker's `cqw` width is a share of is the picked area's
 * body, and its width is whatever the rail and the detail padding leave.
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
    // `settings-surface.tsx`'s scope and scroll pane around the panel.
    <div
      data-settings-touch-scope
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground"
    >
      <div
        data-settings-panel-pane
        className="min-h-0 min-w-0 flex-1 overflow-y-auto"
      >
        <AppearanceSettingsPanel />
      </div>
    </div>
  );
}

// The panel's other areas stay mounted while Themes is shown, and they read
// the shell: the zoom row, the installed fonts, the wallpaper picker.
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});
const runnerHost = new MockRunnerHost({
  signInUrl: "http://127.0.0.1:9/sign-in",
  authnBaseUrl: "http://127.0.0.1:9",
  localHost: null,
  hosts: [],
  workspaceFolderPickerPaths: undefined,
  hasLocalHost: undefined,
  traycerCli: undefined,
});

const container = document.querySelector("#root");
if (container === null) throw new Error("probe root missing");
createRoot(container).render(
  <QueryClientProvider client={queryClient}>
    <RunnerHostProvider runnerHost={runnerHost}>
      <ThemePickerNarrowRowFixture />
    </RunnerHostProvider>
  </QueryClientProvider>,
);
