import {
  SETTINGS_SECTIONS,
  type SettingsSectionId,
} from "@/lib/settings-sections";
import { readNegotiatedMethodVersion } from "@/lib/host/read-negotiated-method-version";

/**
 * The pages of Settings ▸ Environment, addressed by the configuration they
 * show and the page within it. One table for every configuration: Personal,
 * a team and a Local row show the same pages, and a kind of configuration
 * that does not offer a page hides its row. An old host's Local row keeps the
 * same rows and draws only `oldHostSectionShown`'s pages; the Agents panel
 * draws a different body there.
 */
export type EnvironmentPageId =
  | "providers"
  | "mcp-servers"
  | "skills"
  | "permissions"
  | "agent-memories"
  | "agents"
  | "model-routing"
  | "variables"
  | "secrets"
  | "sandboxes"
  | "storage"
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
  | { readonly kind: "unresolved" }
  | { readonly kind: "personal" }
  | {
      readonly kind: "local";
      readonly hostId: string;
      /** The computer's name when picked, for the page's note. */
      readonly hostName: string;
    }
  | { readonly kind: "team"; readonly environmentId: string };

export const UNRESOLVED_PICK: EnvironmentPick = { kind: "unresolved" };

export const PERSONAL_PICK: EnvironmentPick = { kind: "personal" };

/** A pick as one string, the Environment dropdown's radio value. */
export function environmentPickValue(pick: EnvironmentPick): string {
  if (pick.kind === "unresolved") return "";
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
  "agent-memories": "agent-memories",
  agents: "agents",
  "model-routing": "fallback",
  variables: "shell",
  secrets: "secrets",
  sandboxes: "sandboxes",
  storage: "storage",
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
 * no members. A Local row keeps MCP servers, Skills, Sandboxes and Storage in
 * the rail although a computer that has not moved has none of them (they are
 * a cloud configuration's): each says what moving gives it
 * (`components/settings/environment/local-move-page.tsx`), so the rail does
 * not change shape when the computer moves.
 * A team offers every page; the sandboxes plan adds `sandboxes` here for a
 * team if a team without one should not show it.
 */
const PAGES_HIDDEN_BY_PICK: Readonly<
  Record<EnvironmentPick["kind"], ReadonlySet<EnvironmentPageId>>
> = {
  unresolved: new Set(["members"]),
  personal: new Set(["members"]),
  local: new Set(["members"]),
  team: new Set(),
};

/**
 * The pages a Local row on a host that serves no `environment.status` offers:
 * the ones the release before the Environment group showed for a computer.
 */
const OLD_HOST_PAGES: ReadonlySet<EnvironmentPageId> = new Set([
  "providers",
  "permissions",
  "agents",
  "model-routing",
  "variables",
]);

/**
 * Whether `hostId` has completed its handshake without advertising
 * `environment.status`: a released host from before the Environment group.
 */
export function hostLacksEnvironmentStatus(hostId: string): boolean {
  return readNegotiatedMethodVersion(hostId, "environment.status") === false;
}

/**
 * Whether `pick` is a Local row on such a host. Read from the negotiated
 * manifest by the picked host's id, which need not be the window's host.
 */
export function isOldHostLocalPick(pick: EnvironmentPick): boolean {
  return pick.kind === "local" && hostLacksEnvironmentStatus(pick.hostId);
}

/** Every section of the Environment group, the Environment dropdown's pages. */
const ENVIRONMENT_GROUP_SECTIONS: ReadonlySet<SettingsSectionId> = new Set(
  SETTINGS_SECTIONS.filter((entry) => entry.group === "personal").map(
    (entry) => entry.id,
  ),
);

const OLD_HOST_SECTIONS: ReadonlySet<SettingsSectionId> = new Set(
  [...OLD_HOST_PAGES].map(environmentPageSection),
);

/**
 * Whether such an old host's Local row offers `section`: the five pages it
 * has, and every section outside the Environment group. Any other Environment
 * section, a retired one (`machine-setup`) included, is not offered.
 */
export function oldHostSectionShown(section: SettingsSectionId): boolean {
  return (
    !ENVIRONMENT_GROUP_SECTIONS.has(section) || OLD_HOST_SECTIONS.has(section)
  );
}

/**
 * Whether Settings offers `section` under `pick`, in the Environment group's
 * rows and in search: decided by the kind of pick alone. A section that is not
 * one of the registry's pages is offered under every pick; the retired ones
 * (`RETIRED_SETTINGS_SECTION_IDS`) are never offered.
 */
export function environmentSectionShown(
  pick: EnvironmentPick,
  section: SettingsSectionId,
): boolean {
  const pageId = pageIdForSection(section);
  return pageId === null || !PAGES_HIDDEN_BY_PICK[pick.kind].has(pageId);
}

/**
 * Whether `pick` offers `section`: the Environment group's rule
 * (`environmentSectionShown`), and for an old host's Local pick (`oldHost`,
 * read from the manifest by the caller) only the pages that host has.
 */
export function pickOffersSection(
  pick: EnvironmentPick,
  oldHost: boolean,
  section: SettingsSectionId,
): boolean {
  return (
    environmentSectionShown(pick, section) &&
    (!oldHost || oldHostSectionShown(section))
  );
}

/** The pick an address names; a Local row is never addressed by one. */
export function pickForConfiguration(
  configurationId: ConfigurationId,
): EnvironmentPick {
  return configurationId === PERSONAL_CONFIGURATION_ID
    ? PERSONAL_PICK
    : { kind: "team", environmentId: configurationId };
}
