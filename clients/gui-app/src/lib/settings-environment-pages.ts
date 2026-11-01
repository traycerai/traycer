import type { SettingsSectionId } from "@/lib/settings-sections";
import {
  navigateToSettingsSection,
  rememberSettingsTabSection,
} from "@/lib/settings-navigation";
import { getSystemTabModalApi } from "@/stores/tabs/system-tab-modal-bridge";

/**
 * The pages of Settings ▸ Environment, addressed by the configuration they
 * show and the page within it. One table for every configuration: Personal,
 * a team and a Local row show the same pages, and a configuration that
 * does not offer a page hides its row rather than forking a panel.
 */
export type EnvironmentPageId =
  | "providers"
  | "mcp-servers"
  | "skills"
  | "permissions"
  | "agents"
  | "model-routing"
  | "variables"
  | "secrets"
  | "sandboxes"
  | "members";

/**
 * A configuration: `"personal"` (`PERSONAL_CONFIGURATION_ID`) for the
 * person's own, any other value a team's `environmentId` from
 * `environment.list`.
 */
export type ConfigurationId = string;

export const PERSONAL_CONFIGURATION_ID: ConfigurationId = "personal";

export interface EnvironmentPageAddress {
  readonly configurationId: ConfigurationId;
  readonly pageId: EnvironmentPageId;
}

/**
 * What the Environment dropdown has picked. A Local row is a computer whose
 * own settings have not moved into Personal: its pages are read from it.
 */
export type EnvironmentPick =
  | { readonly kind: "personal" }
  | {
      readonly kind: "local";
      readonly hostId: string;
      /** The computer's name when picked, for the page's note. */
      readonly hostName: string;
    }
  | { readonly kind: "team"; readonly environmentId: string };

export const PERSONAL_PICK: EnvironmentPick = { kind: "personal" };

/** A pick as one string, the Environment dropdown's radio value. */
export function environmentPickValue(pick: EnvironmentPick): string {
  if (pick.kind === "local") return `local:${pick.hostId}`;
  if (pick.kind === "team") return `team:${pick.environmentId}`;
  return "personal";
}

/**
 * The table every Environment row is drawn from: each page's Settings
 * section. The sandboxes plan mounts its page in the `sandboxes` section's
 * slot (`components/settings/environment/sandboxes-page-slot`); the Members page is
 * the `members` section's.
 */
const PAGE_SECTIONS: Readonly<Record<EnvironmentPageId, SettingsSectionId>> = {
  providers: "providers",
  "mcp-servers": "mcp-servers",
  skills: "skills",
  permissions: "permissions",
  agents: "agents",
  "model-routing": "fallback",
  variables: "shell",
  secrets: "secrets",
  sandboxes: "sandboxes",
  members: "members",
};

export function environmentPageSection(
  pageId: EnvironmentPageId,
): SettingsSectionId {
  return PAGE_SECTIONS[pageId];
}

function pageIdForSection(
  section: SettingsSectionId,
): EnvironmentPageId | null {
  for (const [pageId, pageSection] of Object.entries(PAGE_SECTIONS)) {
    if (pageSection === section && isEnvironmentPageId(pageId)) return pageId;
  }
  return null;
}

function isEnvironmentPageId(value: string): value is EnvironmentPageId {
  return value in PAGE_SECTIONS;
}

/**
 * Pages a kind of configuration does not offer. Personal and a Local row have
 * no members. A Local row has no MCP servers, Skills or Sandboxes pages: those
 * are a cloud configuration's, and a computer that has not moved has none.
 * A team offers every page; the sandboxes plan adds `sandboxes` here for a
 * team if a team without one should not show it.
 */
const PAGES_HIDDEN_BY_PICK: Readonly<
  Record<EnvironmentPick["kind"], ReadonlySet<EnvironmentPageId>>
> = {
  personal: new Set(["members"]),
  local: new Set(["mcp-servers", "skills", "sandboxes", "members"]),
  team: new Set(),
};

/**
 * Whether the Environment group shows `section`'s row under `pick`. A section
 * of the group that is not one of the registry's pages is shown under every
 * pick; the retired ones (`RETIRED_SETTINGS_SECTION_IDS`) are never offered.
 */
export function environmentSectionShown(
  pick: EnvironmentPick,
  section: SettingsSectionId,
): boolean {
  const pageId = pageIdForSection(section);
  return pageId === null || !PAGES_HIDDEN_BY_PICK[pick.kind].has(pageId);
}

/**
 * Moves the selection, and the surface off a page the selection it lands on
 * does not offer.
 *
 * Both movers go through here, because the second half is not optional:
 * Personal has no Members page, so a person removed from the team they were
 * reading would otherwise be left on a panel that renders nothing, with the
 * sidebar row they were standing on gone from under them. `activeSection` is
 * `null` where the mover does not know the page — nothing is moved then.
 *
 * What is NOT shared is how the surface moves, because the two movers differ
 * in the only way that matters here: whether a person asked for this. A press
 * on a picker row is a gesture, and taking the surface with it is the whole
 * point. A removal is a fact the server reported, and Settings may be sitting
 * in a split pane the person is not looking at — so the caller passes the move
 * rather than inheriting one, and `moveEnvironmentSurface` has the two.
 */
export function moveEnvironmentPick(input: {
  readonly next: EnvironmentPick;
  readonly activeSection: SettingsSectionId | null;
  readonly setPick: (next: EnvironmentPick) => void;
  readonly moveSurface: (section: SettingsSectionId) => void;
}): void {
  input.setPick(input.next);
  if (
    input.activeSection !== null &&
    !environmentSectionShown(input.next, input.activeSection)
  ) {
    input.moveSurface("providers");
  }
}

/**
 * The two ways the Settings surface is taken off a page, for
 * `moveEnvironmentPick`'s `moveSurface`.
 *
 * `onGesture` is the command: it opens Settings and focuses it, which is right
 * when a person just pressed something on it.
 *
 * `onServerFact` never activates anything, and Settings has three
 * presentations to reach without doing so. `navigateToSettingsSection` is
 * wrong for all of them: it routes through `openSettings`, which focuses the
 * Settings tab, and in a split that takes the partner pane's focus and route —
 * pulling a person off the work they were doing because a membership changed
 * in the background, which is a worse failure than the blank panel this guard
 * exists to prevent.
 *
 * - The live overlay: set the section. That moves what the person is already
 *   looking at and activates nothing.
 * - A Settings pane that does NOT own the route: remember the path. The
 *   surface prefers its remembered path exactly while a partner owns the
 *   route, so remembering is what moves it.
 * - A Settings surface that DOES own the route: remembering moves nothing,
 *   because the surface prefers the route wherever it owns it
 *   (`settings-surface.test.tsx` asserts that both ways round). Its route has
 *   to be replaced instead — which activates nothing and takes no partner's
 *   focus, because a surface owning the route is already the focused route
 *   owner. This is the presentation a person reading Settings ▸ Environment ▸
 *   Members with no overlay up is in, so it is the likeliest one of the three
 *   to be standing in when a removal lands.
 *
 * Both of the moves that need the router go through the bridge, which is what
 * the bridge is for: a panel cannot reach for router hooks, because the modal
 * may be the one hosting it. `replaceOwnedSettingsRoute` is a no-op wherever
 * Settings does not own the route, so the order below is "remember, and move
 * the route too if this surface is holding one".
 */
export const moveEnvironmentSurface = {
  onGesture: (section: SettingsSectionId): void => {
    navigateToSettingsSection(section);
  },
  onServerFact: (section: SettingsSectionId): void => {
    const api = getSystemTabModalApi();
    if (api !== null && api.isOverlayActive("settings")) {
      api.setSection(section);
      return;
    }
    rememberSettingsTabSection(section);
    // A no-op unless Settings owns the route. `null` is a cold launch, where
    // the bridge has published nothing and there is no surface to move.
    if (api !== null) api.replaceOwnedSettingsRoute(section);
  },
};

/** The pick an address names; a Local row is never addressed by one. */
export function pickForConfiguration(
  configurationId: ConfigurationId,
): EnvironmentPick {
  return configurationId === PERSONAL_CONFIGURATION_ID
    ? PERSONAL_PICK
    : { kind: "team", environmentId: configurationId };
}
