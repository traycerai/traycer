/**
 * Root:
 *   - Open Tasks (flat, filtered out on `/epics`)
 *   - Open App Settings (sub-page entry; displays the live
 *     `app.settings.open` chord so keyboard users see the direct
 *     shortcut even though the palette row opens a section picker)
 *
 * Settings sub-page: one row per section this build offers
 * (`visibleSettingsSections`) and the Environment pick offers
 * (`useEnvironmentSectionShown`, as the rail and search filter), with
 * the current section filtered out on `/settings/<id>` routes. The pick and
 * its host are read only while the sub-page is open; the root entry's
 * keywords name every section this build offers, so typing a section's name
 * reaches the entry without that read.
 *
 * Runs as a `ReactCommandSource` so the Open-Settings chord
 * refreshes live when the user rebinds `app.settings.open`.
 */
import { useMemo } from "react";
import { useEnvironmentPickerModel } from "@/components/settings/environment/use-environment-picker-model";
import { useEnvironmentSectionShown } from "@/components/settings/environment/use-environment-section-shown";
import {
  useHostScopeFor,
  WINDOW_HOST_SELECTION,
} from "@/components/settings/host-scope/use-host-scope";
import {
  SETTINGS_SECTION_GROUPS,
  visibleSettingsSections,
  type SettingsSection,
  type SettingsSectionGroupId,
  type SettingsSectionId,
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
    return useMemo<ReadonlyArray<CommandItem>>(() => {
      const items: Array<CommandItem> = [];
      if (ctx.pathname !== "/epics") items.push(OPEN_EPICS_ITEM);
      items.push(
        buildSettingsEntryItem(
          settingsChord,
          settingsSectionItems(ctx.pathname, everySectionShown),
        ),
      );
      if (import.meta.env.DEV) {
        items.push(ARTIFACT_PROOF_ITEM);
      }
      return items;
    }, [ctx.pathname, settingsChord]);
  },
};

const ARTIFACT_PROOF_ITEM: CommandItem = {
  id: "dev:artifact-proof",
  label: "Dev: artifact serving proof",
  description: null,
  keywords: ["dev", "artifact", "sandbox", "proof"],
  group: "navigation",
  scope: "actions",
  shortcut: null,
  actionId: null,
  run: (ctx) => ctx.router.navigateSettingsSection("dev-artifact-proof"),
  subpage: null,
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
  useItems: (ctx: CommandContext) => {
    const windowScope = useHostScopeFor(WINDOW_HOST_SELECTION);
    useEnvironmentPickerModel(windowScope);
    const sectionShown = useEnvironmentSectionShown(windowScope);
    return useMemo<ReadonlyArray<CommandItem>>(
      () => settingsSectionItems(ctx.pathname, sectionShown),
      [ctx.pathname, sectionShown],
    );
  },
};

function everySectionShown(): boolean {
  return true;
}

function settingsSectionItems(
  pathname: string,
  sectionShown: (section: SettingsSectionId) => boolean,
): ReadonlyArray<CommandItem> {
  return visibleSettingsSections().flatMap((section) =>
    pathname !== `/settings/${section.id}` && sectionShown(section.id)
      ? [buildSectionItem(section)]
      : [],
  );
}

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
  const group = groupLabel(section.group);
  return {
    id: `nav:settings/${section.id}`,
    label: section.label,
    description: null,
    // The section `id` rides along as a keyword so a renamed section stays
    // findable under the vocabulary users already learned (e.g. "agents" still
    // reaches "Agent selection"). The group label joins it so the scope is
    // TYPEABLE as well as visible — "host diag" has to reach the host page.
    keywords: [
      "settings",
      section.label.toLowerCase(),
      section.id,
      // Hyphenated ids stay findable by each segment ("notifications" still
      // reaches Sounds after that row dropped the word from its label).
      ...section.id.split("-"),
      ...(group === undefined ? [] : [group.toLowerCase()]),
    ],
    group: "navigation",
    scope: "actions",
    shortcut: null,
    actionId: null,
    // The rail says which scope a section belongs to with a group heading; this
    // list has no headings, so the badge carries it per row. Rendered on EVERY
    // section, not just the pair that collides: badging only the ambiguous ones
    // makes the absence of a badge mean something, and the next duplicate label
    // would then ship looking unambiguous.
    statusBadge: group,
    run: (ctx) => ctx.router.navigateSettingsSection(section.id),
    subpage: null,
  };
}

// `undefined`, not `""`, for a group the registry has never heard of: the
// palette renders any defined `statusBadge`, so an empty string paints an
// EMPTY chip on every row of that section.
function groupLabel(group: SettingsSectionGroupId): string | undefined {
  return SETTINGS_SECTION_GROUPS.find((entry) => entry.id === group)?.label;
}
