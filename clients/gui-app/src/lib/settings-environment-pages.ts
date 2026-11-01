import type { SettingsSectionId } from "@/lib/settings-sections";

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

/** The pick an address names; a Local row is never addressed by one. */
export function pickForConfiguration(
  configurationId: ConfigurationId,
): EnvironmentPick {
  return configurationId === PERSONAL_CONFIGURATION_ID
    ? PERSONAL_PICK
    : { kind: "team", environmentId: configurationId };
}
