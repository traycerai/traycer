/**
 * Root: one "Change theme" entry. Sub-page: Light / Dark / System.
 * Collapsed behind a sub-page because theme flips are rare enough
 * that surfacing three rows on the palette root pushes more
 * valuable items off screen.
 */
import {
  useSettingsStore,
  type ThemeMode,
} from "@/stores/settings/settings-store";
import { withSubpageLabels } from "@/lib/commands/sub-page-keywords";
import type {
  CommandItem,
  CommandSource,
  CommandSubpage,
} from "@/lib/commands/types";

interface ThemeOption {
  readonly mode: ThemeMode;
  readonly label: string;
  readonly keywords: ReadonlyArray<string>;
}

const THEME_OPTIONS: ReadonlyArray<ThemeOption> = [
  { mode: "light", label: "Light", keywords: ["theme", "light"] },
  { mode: "dark", label: "Dark", keywords: ["theme", "dark"] },
  { mode: "system", label: "System", keywords: ["theme", "auto", "system"] },
];

const THEME_SUBPAGE_ITEMS: ReadonlyArray<CommandItem> = THEME_OPTIONS.map(
  (option) => ({
    id: `theme:${option.mode}`,
    label: option.label,
    description: null,
    keywords: option.keywords,
    group: "theme",
    scope: "actions",
    shortcut: null,
    actionId: null,
    subpage: null,
    run: () => {
      useSettingsStore.getState().setTheme(option.mode);
    },
  }),
);

const THEME_SUBPAGE: CommandSubpage = {
  id: "theme:pick",
  title: "Change theme",
  useItems: () => THEME_SUBPAGE_ITEMS,
};

const CHANGE_THEME_ITEM: CommandItem = {
  id: "theme:change",
  label: "Change theme",
  description: null,
  keywords: withSubpageLabels(["theme", "appearance"], [THEME_SUBPAGE_ITEMS]),
  group: "theme",
  scope: "actions",
  shortcut: null,
  actionId: null,
  subpage: THEME_SUBPAGE,
  run: () => undefined,
};

const ROOT_ITEMS: ReadonlyArray<CommandItem> = [CHANGE_THEME_ITEM];

export const themeSource: CommandSource = {
  id: "theme",
  getItems: (): ReadonlyArray<CommandItem> => ROOT_ITEMS,
};
