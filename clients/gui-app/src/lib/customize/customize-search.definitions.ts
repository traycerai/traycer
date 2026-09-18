import { CUSTOMIZE_CATALOG } from "@/lib/customize/catalog";
import { isCustomizeAvailable } from "@/lib/settings/settings-availability";
import type { SettingsSearchEntry } from "@/lib/settings-search/settings-definitions";

/**
 * The settings search's LAUNCH results: one per Customize setting, so a reader
 * who types the name of a control the Layout page used to hold is offered the
 * editor aimed at it rather than nothing.
 *
 * Generated from the catalog, never written by hand: the catalog is already the
 * one list of what the editor can edit, with the words a reader uses for each
 * (they are the Layout definitions' own labels and keywords), so a setting
 * added there is searchable here with no second edit.
 *
 * Not a settings section collection, and deliberately so. A collection is the
 * value a panel RENDERS from, and there is no panel here: these entries have no
 * element to point at, so they carry `anchor: null` and a `launch` id instead,
 * and the index test's exact-target rule (which is about anchors) does not
 * apply to them. They wear the Appearance breadcrumb because that is where the
 * card that starts the editor lives.
 *
 * Present only where the editor exists (`isCustomizeAvailable`) - the exact
 * complement of the Layout page's own rows, so a setting is reachable through
 * one of the two in every shell and never both.
 */
export const CUSTOMIZE_LAUNCH_ENTRIES: ReadonlyArray<SettingsSearchEntry> =
  CUSTOMIZE_CATALOG.map((setting) => ({
    section: "appearance",
    anchor: null,
    launch: setting.id,
    kind: "setting",
    availableWhen: isCustomizeAvailable,
    label: setting.label,
    description: null,
    // Where the control lives disambiguates two results with one name (the
    // usage limits are in both the status bar and the header).
    group: setting.absent.where,
    keywords: setting.keywords,
  }));
