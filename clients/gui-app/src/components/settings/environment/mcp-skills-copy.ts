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

/** A skill's source: Traycer's own, or one written or added in Settings. */
export function skillSourcePhrase(origin: "bundled" | "room"): string {
  return origin === "bundled" ? "Built-in" : "written in Settings";
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
  "Comes with Traycer and can't be removed. Switch it off for any provider that shouldn't use it.";

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

/** A command server asked for a secret: the broker cannot bind one. */
export function stdioSecretRefusal(field: string): string {
  return `A server that runs as a command can't use a secret for ${field}. Add the server without it, or choose Remote if the server has a web address.`;
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
  if (reason === "stdio_credential") return stdioSecretRefusal("this server");
  if (
    (reason === "secret_not_bindable" ||
      reason === "secret_destination_mismatch") &&
    context.secret !== null &&
    context.secret.hosts.length > 0
  )
    return `${context.secret.name} is only ever sent to ${hostsPhrase(context.secret.hosts)}, not to this server's address. Pick another secret, or add one for this address.`;
  return "Couldn't save this server. Try again.";
}
