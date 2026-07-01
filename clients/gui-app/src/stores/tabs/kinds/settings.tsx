import { Settings } from "lucide-react";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useTabsStore } from "@/stores/tabs/store";
import { settingsTabIntent } from "@/lib/tab-navigation/intents";
import type { SystemTab, TabKindModule } from "@/stores/tabs/types";
import {
  SETTINGS_SECTIONS,
  type SettingsSectionId,
} from "@/lib/settings-sections";

const SETTINGS_TAB_LABEL = "Settings";
const SETTINGS_PATH_PREFIX = "/settings";
const SETTINGS_DEFAULT_PATH = "/settings/general";
const LEGACY_SERVICE_PATH = "/settings/service";

function settingsRouteOptions(section: SettingsSectionId) {
  switch (section) {
    case "general":
      return { to: "/settings/general" } as const;
    case "appearance":
      return { to: "/settings/appearance" } as const;
    case "providers":
      return { to: "/settings/providers" } as const;
    case "permissions":
      return { to: "/settings/permissions" } as const;
    case "agents":
      return { to: "/settings/agents" } as const;
    case "keybindings":
      return { to: "/settings/keybindings" } as const;
    case "shell":
      return { to: "/settings/shell" } as const;
    case "worktrees":
      return { to: "/settings/worktrees" } as const;
    case "host":
      return { to: "/settings/host" } as const;
    case "diagnostics":
      return { to: "/settings/diagnostics" } as const;
  }
}

/**
 * Module for `kind: "settings"` tabs. Singleton; no duplication.
 * Route defaults to the last remembered sub-path, or the general
 * section fallback.
 */
export const settingsTabModule: TabKindModule<"settings", SystemTab> = {
  kind: "settings",
  build: (source) => {
    // Canonicalize against the known section list so stale/renamed paths
    // (e.g. `/settings/old-section` from an earlier build) cannot leak into
    // the tab's `route` or `lastPath`. `settingsSectionFromPath` falls back
    // to `general` for unknown ids and remaps legacy aliases.
    const canonicalPath =
      source.lastPath === null
        ? null
        : settingsSectionPath(settingsSectionFromPath(source.lastPath));
    return {
      kind: "settings",
      id: "settings",
      route: canonicalPath ?? SETTINGS_DEFAULT_PATH,
      name: source.name.length > 0 ? source.name : SETTINGS_TAB_LABEL,
      icon: Settings,
      canDuplicate: false,
      canOpenInNewWindow: true,
      lastPath: canonicalPath,
    };
  },
  descriptor: {
    kind: "settings",
    duplicate: () => null,
    resolveIntent: (tab) =>
      settingsTabIntent(
        settingsSectionFromPath(normalizeSettingsPath(tab.lastPath)),
      ),
    routeOptions: (intent) => settingsRouteOptions(intent.section),
    activate: () => {
      useLandingDraftStore.getState().clearActiveDraft();
    },
    requestClose: () => {
      useTabsStore.getState().closeSystemTab("settings");
    },
    requiresCloseConfirm: () => false,
    openInNewWindow: (tab, deps) => {
      void deps.bridge.requestNew(tab.route);
    },
    matchesPath: (_tab, pathname) => isSettingsPath(pathname),
  },
};

/** Backwards-compat export so existing imports of `settingsTabDescriptor` keep working. */
export const settingsTabDescriptor = settingsTabModule.descriptor;

export function defaultSettingsTabName(): string {
  return SETTINGS_TAB_LABEL;
}

export function settingsDefaultPath(): string {
  return SETTINGS_DEFAULT_PATH;
}

export function settingsSectionPath(section: SettingsSectionId): string {
  return `${SETTINGS_PATH_PREFIX}/${section}`;
}

export function settingsSectionFromPath(
  pathname: string | null,
): SettingsSectionId {
  if (pathname === null) return "general";
  // Legacy `/settings/service` resolves to the Host section so a
  // remembered tab path from before the rename still lands on the
  // current native-packaging surface (the route itself redirects).
  if (pathname === LEGACY_SERVICE_PATH) return "host";
  const match = SETTINGS_SECTIONS.find(
    (section) => settingsSectionPath(section.id) === pathname,
  );
  return match === undefined ? "general" : match.id;
}

export function isSettingsPath(pathname: string): boolean {
  return (
    pathname === SETTINGS_PATH_PREFIX ||
    pathname === `${SETTINGS_PATH_PREFIX}/` ||
    pathname.startsWith(`${SETTINGS_PATH_PREFIX}/`)
  );
}

export function normalizeSettingsPath(pathname: string | null): string | null {
  if (pathname === null) return null;
  return isSettingsPath(pathname) ? pathname : null;
}
