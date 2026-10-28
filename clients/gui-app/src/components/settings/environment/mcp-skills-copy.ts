import { formatCount } from "@/lib/format-count";
import { SECRET_CUSTODY_SENTENCE } from "@/lib/sandboxes/secrets-page-copy";

/**
 * The words of the MCP servers and Skills pages and of each provider's MCP
 * and Skills tabs. `name` is the configuration's: "Personal" or the team's.
 */

/**
 * Which providers use a server or a skill, mid-line after "·": every provider,
 * one, a few by name, or none.
 */
export function providersPhrase(
  using: readonly string[],
  total: number,
): string {
  if (using.length === 0) return "no provider uses it";
  if (using.length === total) return "all providers";
  const [first, second, third] = using;
  if (using.length === 1) return `${first} only`;
  if (using.length === 2) return `${first}, ${second}`;
  if (using.length === 3) return `${first}, ${second} and ${third}`;
  return `${first}, ${second} and ${using.length - 2} more`;
}

/** A server switched off for everyone. */
export const DISABLED_SERVER_PHRASE = "disabled · no provider uses it";

/** A server's tool count as a host reported it. */
export function toolCountPhrase(count: number): string {
  return count === 1 ? "1 tool" : `${count} tools`;
}

/**
 * A skill's row on its configuration's Skills page: "Built-in" for Traycer's
 * own, then its version when it has one, then the providers; the
 * configuration's own carry no source word, since the page already says
 * whose skills these are.
 */
export function skillPageLine(
  origin: "bundled" | "room",
  version: string | null,
  providers: string,
): string {
  return [origin === "bundled" ? "Built-in" : null, version, providers]
    .filter((part) => part !== null)
    .join(" · ");
}

/** The update policy control's options, as the page names them. */
export const SKILL_POLICY_LABELS = {
  "auto-update": "Auto-update",
  evolve: "Evolve",
  frozen: "Frozen",
} as const;

/** What each policy does, under the page's list. */
export const SKILL_POLICIES_LINE =
  "Auto-update: follows upstream, cannot be edited here. Evolve: you and your agents can change it, updates wait for you. Frozen: nothing changes it.";

export const SKILL_UPDATE_AVAILABLE = "Update available";
export const SKILL_UPDATE_NOW_LABEL = "Update now";

export function evolveTitle(skill: string): string {
  return `Stop updates for ${skill}?`;
}

export function evolveDescription(skill: string): string {
  return `You and your agents can change ${skill}. New versions stop landing on their own; Update now brings one in when you choose.`;
}

export const EVOLVE_LABEL = "Stop updates";

export function autoUpdateTitle(skill: string): string {
  return `Replace your changes to ${skill}?`;
}

export function autoUpdateDescription(skill: string): string {
  return `${skill} follows upstream again, and your changes to it are replaced by the current version.`;
}

export const AUTO_UPDATE_LABEL = "Replace changes";

export function updateTitle(skill: string): string {
  return `Update ${skill}?`;
}

export function updateDescription(skill: string): string {
  return `The upstream version replaces ${skill}, and your changes to it are lost.`;
}

export const DELETED_BUILT_INS_HEADING = "Deleted built-ins";
export const RESTORE_SKILL_LABEL = "Restore";

/** An edit the host refused because the skill's policy takes none. */
export const READ_ONLY_EDIT_REFUSAL =
  "This skill can't be edited while it's set to Auto-update or Frozen. Switch it to Evolve to edit it.";

/** An upload over a skill whose policy takes no edit. */
export function readOnlyUploadRefusal(skill: string): string {
  return `${skill} is set to Auto-update or Frozen, so it can't be replaced. Switch it to Evolve first.`;
}

/** Why a policy, update or restore write did not land, by its reason. */
export function skillWriteRefusal(
  reason: string | null,
  failedLine: string,
): string {
  if (reason === "not_ready")
    return "This configuration isn't ready to change these settings yet.";
  if (reason === "policies_unreadable")
    return "This configuration's skill update settings couldn't be read.";
  if (reason === "no_upstream")
    return "This skill has no source to update from.";
  if (reason === "fetch_failed")
    return "Couldn't reach this skill's source. Try again later.";
  return failedLine;
}

/**
 * Where a skill from a source came from, under its name: the source as
 * typed, without its scheme, then the branch it follows unless it is the
 * default one.
 */
export function skillUpstreamLine(source: string, ref: string): string {
  const where = source.replace(/^[a-z+]+:\/\//i, "").replace(/\.git$/i, "");
  return ref === "HEAD" ? `From ${where}` : `From ${where} · ${ref}`;
}

export const CHECK_SKILL_UPDATES_LABEL = "Check for updates";
export const IMPORT_SKILL_LABEL = "Import from source";

/** A source holding more skills than one import installs. */
export function skillImportLimitLine(max: number): string {
  return `You can import up to ${String(max)} skills at a time.`;
}
export const IMPORT_SKILL_TITLE = "Import skills from a source";
export const IMPORT_SKILL_DESCRIPTION =
  "Paste a public repository. Imported skills update from it on their own until you change their updates setting.";
export const IMPORT_SOURCE_HINT =
  "owner/repo, or an https link to a repository or a folder in it. An npx skills command works too.";

export const SKILLS_DIRECTORY_SEARCH_LABEL = "Search skills.sh";

/** Under the directory search: where results come from, and what a pick reads. */
export const SKILLS_DIRECTORY_NOTE =
  "Results come from a public directory. Importing reads the skill from its own repository.";

export const SKILLS_DIRECTORY_NO_RESULTS = "No results";

/** A directory result's install count, as the page counts. */
export function skillInstallsPhrase(count: number): string {
  return count === 1 ? "1 install" : `${formatCount(count)} installs`;
}

/** Why an import was refused, by its reason; `name` is the skill it names. */
export function skillImportRefusal(
  reason: string,
  name: string | null,
  configuration: string,
): string {
  const skill = name ?? "A chosen skill";
  switch (reason) {
    case "not_ready":
      return "This configuration isn't ready to change these settings yet.";
    case "invalid_source":
      return "Only a public repository can be imported. Paste owner/repo or its https link.";
    case "fetch_failed":
      return "Couldn't reach this source. Check it and try again.";
    case "expired":
      return "This source changed since it was read. Read it again.";
    case "not_found":
      return `${skill} isn't in this source anymore. Read it again.`;
    case "invalid_name":
      return `${skill} has a name a skill can't have.`;
    case "exists":
      return `${configuration} already has a skill named ${skill}. Remove it first.`;
    case "bundled_name":
      return `${skill} is the name of a built-in skill. It can't be imported under that name.`;
    case "too_large":
      return "These skills are larger than 32 MB together. Import fewer at once.";
    default:
      return "Couldn't import from this source.";
  }
}

/**
 * A skill's source beside a provider's switch, where sources mix: "Built-in"
 * for Traycer's own, else the configuration's name (`name`).
 */
export function skillSourcePhrase(
  origin: "bundled" | "room",
  name: string,
): string {
  return origin === "bundled" ? "Built-in" : name;
}

export function serverSwitchLabel(enabled: boolean): string {
  return enabled ? "Enabled" : "Disabled";
}

/** A failed send of the Enabled switch. */
export function serverSwitchFailed(server: string, enabled: boolean): string {
  return `Couldn't turn ${server} ${enabled ? "on" : "off"}. Try again.`;
}

export function mcpPageSubtitle(personal: boolean, name: string): string {
  return personal
    ? "Tools agents can call. Personal's servers reach every provider on every computer and sandbox running Personal."
    : `Tools agents can call. ${name}'s servers reach every provider on every host running ${name}.`;
}

export function skillsPageSubtitle(personal: boolean, name: string): string {
  return personal
    ? "Instructions agents follow for a kind of task. Personal's skills reach every provider on every computer and sandbox running Personal."
    : `Instructions agents follow for a kind of task. ${name}'s skills reach every provider on every host running ${name}.`;
}

/** A built-in skill's line beside its per-provider switches. */
export const BUILT_IN_SKILL_LINE =
  "Comes with Traycer. Switch it off for any provider that shouldn't use it.";

export function addServerTitle(name: string): string {
  return `Add an MCP server to ${name}`;
}

export function editServerTitle(server: string): string {
  return `Edit ${server}`;
}

export function mcpReadFailed(name: string): string {
  return `Couldn't read ${name}'s MCP servers.`;
}

export function skillsReadFailed(name: string): string {
  return `Couldn't read ${name}'s skills.`;
}

export function addServerReach(personal: boolean, name: string): string {
  return personal
    ? "It reaches every provider on every computer and sandbox running Personal."
    : `It reaches every provider on every host running ${name}.`;
}

/** The Secret option's line: Pick needs `put@1.1`; a 1.0 host takes Add only. */
export function secretOptionLine(canPick: boolean): string {
  return canPick
    ? "Pick or add a secret. It is sent only to this server's address."
    : "Add a secret. It is sent only to this server's address.";
}

export function custodySentence(personal: boolean, name: string): string {
  return personal
    ? SECRET_CUSTODY_SENTENCE
    : `Stored encrypted in Traycer's cloud. ${name}'s sandboxes and connected services use it without seeing it; no computer receives the value.`;
}

/**
 * A command server asked for a secret: the broker cannot bind one. `variable`
 * is the variable name typed, or `null` before one is.
 */
export function stdioSecretRefusal(variable: string | null): string {
  const secret = variable === null ? "a secret" : `a secret for ${variable}`;
  return `A server that runs as a command can't use ${secret}. Add the server without it, or choose Remote if the server has a web address.`;
}

export function serversCardHeading(name: string, provider: string): string {
  return `${name}'s servers · for ${provider}`;
}

export function skillsCardHeading(name: string, provider: string): string {
  return `${name}'s skills · for ${provider}`;
}

export function onHostOnlyHeading(host: string): string {
  return `On ${host} only · not shared`;
}

/** Under an empty MCP servers page: the servers a provider kept on this computer. */
export function onHostOnlyServersLine(count: number, name: string): string {
  return count === 1
    ? `1 server on this computer only, not in ${name}`
    : `${count} servers on this computer only, not in ${name}`;
}

export function onHostOnlyServersLink(count: number, provider: string): string {
  return count === 1
    ? `See it on ${provider} ▸ MCP`
    : `See them on ${provider} ▸ MCP`;
}

/**
 * Where an on-host entry lives: "all projects" for the provider's global
 * settings, or the project's or worktree's folder with its branch.
 */
export function onHostScopePhrase(
  target: { readonly name: string; readonly branch: string | null } | null,
): string {
  if (target === null) return "all projects";
  return target.branch === null
    ? target.name
    : `${target.name} · ${target.branch}`;
}

export function addToConfigurationLabel(name: string): string {
  return `Add to ${name}`;
}

export function emptyServersTabLine(name: string): string {
  return `${name} has no servers yet.`;
}

export function removeTitle(entry: string): string {
  return `Remove ${entry}?`;
}

/** What removing a server or a skill does, on every place it reaches. */
export function removeReach(
  personal: boolean,
  name: string,
  entry: string,
): string {
  return personal
    ? `This removes ${entry} from every provider on every computer and sandbox running Personal.`
    : `This removes ${entry} from every provider on every host running ${name}.`;
}

/** A removed server's secret: one added with it goes, a picked one stays. */
export function removeSecretLine(secret: string, owned: boolean): string {
  return owned
    ? `Its secret, ${secret}, was added with this server and is deleted with it.`
    : `Its secret, ${secret}, stays on Secrets.`;
}

export const REMOVE_SERVER_LABEL = "Remove server";
export const REMOVE_SKILL_LABEL = "Remove skill";

/** A secret's hosts, as the chips name them: two by name, then a count. */
export function hostsPhrase(hosts: readonly string[]): string {
  const [first, second, third] = hosts;
  if (hosts.length === 0) return "";
  if (hosts.length === 1) return first;
  if (hosts.length === 2) return `${first} and ${second}`;
  if (hosts.length === 3) return `${first}, ${second} and ${third}`;
  return `${first}, ${second} and ${hosts.length - 2} more`;
}

export const SKILL_SWITCHES_UNAVAILABLE =
  "Choosing skills per provider isn't available in this version. Every skill reaches every provider.";

/** A refused server write's facts: the server and the secret it named. */
export interface ServerRefusalContext {
  readonly configuration: string;
  readonly server: string;
  /** The picked or bound secret, with the hosts it is sent to. */
  readonly secret: {
    readonly name: string;
    readonly hosts: readonly string[];
  } | null;
}

/**
 * Why a server's switch was refused: a taken name as a save words it, any
 * other code as the switch failing.
 */
export function serverSwitchRefusal(
  reason: string | null,
  configuration: string,
  server: string,
  enabled: boolean,
): string {
  if (reason === "name_taken")
    return serverRefusal(reason, { configuration, server, secret: null });
  return serverSwitchFailed(server, enabled);
}

/** Why a server write was refused, by the host's or authn's code. */
export function serverRefusal(
  reason: string | null,
  context: ServerRefusalContext,
): string {
  if (reason === "name_taken")
    return `${context.configuration} already has a server named ${context.server}. Pick another name.`;
  if (reason === "stdio_credential") return stdioSecretRefusal(null);
  if (
    (reason === "secret_not_bindable" ||
      reason === "secret_destination_mismatch") &&
    context.secret !== null &&
    context.secret.hosts.length > 0
  )
    return `${context.secret.name} is only ever sent to ${hostsPhrase(context.secret.hosts)}, not to this server's address. Pick another secret, or add one for this address.`;
  return "Couldn't save this server. Try again.";
}
