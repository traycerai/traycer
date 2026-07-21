/**
 * Root:
 *   - Open Tasks (flat, filtered out on `/epics`)
 *   - Open App Settings (sub-page entry; displays the live
 *     `app.settings.open` chord so keyboard users see the direct
 *     shortcut even though the palette row opens a section picker)
 *
 * Settings sub-page: one row per `SETTINGS_SECTIONS` entry, with
 * the current section filtered out on `/settings/<id>` routes.
 *
 * Runs as a `ReactCommandSource` so the Open-Settings chord
 * refreshes live when the user rebinds `app.settings.open`.
 */
import { useMemo } from "react";
import {
  SETTINGS_SECTIONS,
  type SettingsSection,
} from "@/lib/settings-sections";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";
import { withSubpageLabels } from "@/lib/commands/sub-page-keywords";
import type {
  CommandContext,
  CommandItem,
  CommandSubpage,
  ReactCommandSource,
} from "@/lib/commands/types";

export const navigationSource: ReactCommandSource = {
  id: "navigation",
  useItems: (ctx: CommandContext) => {
    const settingsChord = useKeybindingStore(
      (state) => state.bindings["app.settings.open"] ?? null,
    );
    const sectionItems = SETTINGS_SUBPAGE.useItems(ctx);
    return useMemo<ReadonlyArray<CommandItem>>(() => {
      const items: Array<CommandItem> = [];
      if (ctx.pathname !== "/epics") items.push(OPEN_EPICS_ITEM);
      items.push(buildSettingsEntryItem(settingsChord, sectionItems));
      return items;
    }, [ctx.pathname, settingsChord, sectionItems]);
  },
};

const OPEN_EPICS_ITEM: CommandItem = {
  id: "nav:epics",
  label: "Open Tasks",
  description: null,
  keywords: ["tasks", "epics", "history", "list", "browse"],
  group: "navigation",
  scope: "actions",
  shortcut: null,
  actionId: null,
  run: (ctx) => ctx.router.navigateToEpicList(),
  subpage: null,
};

const SETTINGS_SUBPAGE: CommandSubpage = {
  id: "nav:settings",
  title: "Open settings",
  useItems: (ctx: CommandContext) =>
    useMemo<ReadonlyArray<CommandItem>>(
      () =>
        SETTINGS_SECTIONS.flatMap((section) =>
          ctx.pathname !== `/settings/${section.id}`
            ? [buildSectionItem(section)]
            : [],
        ),
      [ctx.pathname],
    ),
};

function buildSettingsEntryItem(
  shortcut: string | null,
  sectionItems: ReadonlyArray<CommandItem>,
): CommandItem {
  return {
    id: "nav:settings",
    label: "Open App Settings",
    description: null,
    keywords: withSubpageLabels(
      ["settings", "preferences", "config"],
      [sectionItems],
    ),
    group: "navigation",
    scope: "actions",
    // Shortcut is for discoverability - clicking the palette row
    // opens the section picker below, while the chord still
    // navigates directly to `/settings/general` via
    // `app.settings.open`.
    shortcut,
    actionId: null,
    subpage: SETTINGS_SUBPAGE,
    run: () => undefined,
  };
}

function buildSectionItem(section: SettingsSection): CommandItem {
  return {
    id: `nav:settings/${section.id}`,
    label: section.label,
    description: null,
    // The section `id` rides along as a keyword so a renamed section stays
    // findable under the vocabulary users already learned (e.g. "agents" still
    // reaches "Agent selection").
    keywords: ["settings", section.label.toLowerCase(), section.id],
    group: "navigation",
    scope: "actions",
    shortcut: null,
    actionId: null,
    run: (ctx) => ctx.router.navigateSettingsSection(section.id),
    subpage: null,
  };
}
