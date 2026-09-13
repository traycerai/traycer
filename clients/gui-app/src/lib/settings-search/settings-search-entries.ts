/**
 * Docs: see `src/components/settings/SETTINGS.md` § Search.
 *
 * Assembly only. Every entry is produced by a section's own collection — the
 * `*.definitions.ts` module beside its panel, which the panel renders from —
 * so there is nothing to write here but the list of collections, one per
 * `SETTINGS_SECTIONS` id (asserted by the index test).
 */
import { AGENT_SELECTION } from "@/components/settings/panels/agents-settings.definitions";
import { APP_DIAGNOSTICS } from "@/components/settings/panels/app-diagnostics-settings.definitions";
import { APP_NOTIFICATIONS } from "@/components/settings/panels/app-notifications-settings.definitions";
import { APPEARANCE } from "@/components/settings/panels/appearance-settings.definitions";
import { DEVICES } from "@/components/settings/panels/devices-sessions.definitions";
import { HOST_DIAGNOSTICS } from "@/components/settings/panels/diagnostics-settings.definitions";
import { GENERAL } from "@/components/settings/panels/general-settings.definitions";
import { HOST_OVERVIEW } from "@/components/settings/panels/host-overview.definitions";
import { KEYBINDINGS } from "@/components/settings/panels/keybindings-settings.definitions";
import { LAYOUT } from "@/components/settings/panels/layout-settings.definitions";
import { LINK_PHONE } from "@/components/settings/panels/link-phone.definitions";
import { HOST_NOTIFICATIONS } from "@/components/settings/panels/notifications-settings.definitions";
import { OPENING_BEHAVIOR } from "@/components/settings/panels/opening-behavior.definitions";
import { PROVIDERS } from "@/components/settings/panels/providers-settings.definitions";
import { SHELL } from "@/components/settings/panels/shell-settings.definitions";
import { USAGE } from "@/components/settings/panels/usage-settings.definitions";
import { WORKTREES } from "@/components/settings/panels/worktrees-settings.definitions";
import {
  assembleSettingsSearchEntries,
  type AnySettingsSectionCollection,
  type SettingsSearchEntry,
} from "@/lib/settings-search/settings-definitions";

/** Every section's collection, in the order the index lists them. */
export const SETTINGS_SEARCH_COLLECTIONS: ReadonlyArray<AnySettingsSectionCollection> =
  [
    GENERAL,
    APPEARANCE,
    OPENING_BEHAVIOR,
    APP_NOTIFICATIONS,
    KEYBINDINGS,
    APP_DIAGNOSTICS,
    LAYOUT,
    DEVICES,
    LINK_PHONE,
    USAGE,
    HOST_OVERVIEW,
    PROVIDERS,
    WORKTREES,
    HOST_NOTIFICATIONS,
    AGENT_SELECTION,
    SHELL,
    HOST_DIAGNOSTICS,
  ];

/**
 * Every settings surface a query can land on: each collection's page entry and
 * its entry-owning rows and groups, with every contributor's words folded in.
 */
export const SETTINGS_SEARCH_ENTRIES: ReadonlyArray<SettingsSearchEntry> =
  assembleSettingsSearchEntries(SETTINGS_SEARCH_COLLECTIONS);
