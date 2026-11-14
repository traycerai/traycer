/**
 * The words of Settings ▸ Personal ▸ Secrets. Four words carry Personal pages:
 * Personal, secret, variable and host; nothing here names the mechanism a value
 * travels by.
 */

import {
  formatSettingsDate,
  onSettingsDate,
} from "@/lib/settings/settings-date";

export const SECRETS_EMPTY_TEXT =
  "Values and logins your agents use on sandboxes, without seeing them.";

/** A team's Secrets text, as its subtitle and as its empty state. */
export function teamSecretsDescription(name: string): string {
  return `Values and logins ${name}'s agents use, on its sandboxes without being seen.`;
}

export const SECRETS_ADD_LABEL = "Add a secret";

export const SECRETS_NEED_UPDATED_HOST = "These secrets need an updated host.";

/** In place of the list when Personal's secrets could not be read. */
export const PERSONAL_SECRETS_READ_FAILED = "Couldn't read Personal's secrets.";

/** In place of the kinds Add a secret does not offer: a provider's key. */
export const PROVIDER_KEYS_LINE = {
  before: "Provider keys are set on each provider's page, under ",
  link: "Providers",
  after: ".",
} as const;

/**
 * Who made a secret's current value and when: "added by you 24 Oct" for its
 * first, "replaced by you 24 Oct" after. Personal's values are all the
 * person's own; a team's author is not on the wire, so it is left out.
 */
export function secretValueOrigin(
  version: { readonly ordinal: number; readonly createdAt: number },
  byYou: boolean,
): string {
  const verb = version.ordinal === 1 ? "added" : "replaced";
  return `${verb}${byYou ? " by you" : ""} ${formatSettingsDate(version.createdAt, false)}`;
}

/**
 * What a secret's row says after its name: "Set · sent to api.stripe.com ·
 * added by you 24 Oct", each clause only when it is known. Several addresses
 * are joined with commas and the row wraps them.
 */
export function secretRowDetail(input: {
  readonly destinations: readonly string[];
  readonly origin: string | null;
}): string {
  const parts = ["Set"];
  if (input.destinations.length > 0) {
    parts.push(`sent to ${input.destinations.join(", ")}`);
  }
  if (input.origin !== null) parts.push(input.origin);
  return parts.join(" · ");
}

/** On a team's host, in place of the list's actions. */
export const TEAM_SECRETS_LINE =
  "Team secrets are used on the team's sandboxes, without being seen.";

export const SECRET_REVOKED_LABEL = "Revoked";

/**
 * Beside Replace value, Undo and Destroy, and under the recovery order: what
 * one change reaches.
 */
export const SECRET_SCOPE_LINE =
  "This changes the copy stored here. If the same credential is stored anywhere else, that copy needs its own replacement.";

/**
 * On a secret's Add and Replace: where Personal's value is stored and who
 * uses it. An MCP token and a provider key each have their own sentence.
 */
export const SECRET_CUSTODY_SENTENCE =
  "Stored encrypted in Traycer's cloud. Sandboxes use it without seeing it.";

/** A team's sentence where a value is added: no computer receives it. */
export function teamCustodySentence(name: string): string {
  return `Stored encrypted in Traycer's cloud. ${name}'s sandboxes and connected services use it without seeing it; no computer receives the value.`;
}

/** A secret's Add and Replace: Personal's sentence, or the team's. */
export function secretCustodySentence(personal: boolean, name: string): string {
  return personal ? SECRET_CUSTODY_SENTENCE : teamCustodySentence(name);
}

export const SECRET_REPLACE_STALE =
  "Changed somewhere else just now. Look again before you replace it.";

export const SECRET_SAVED_OFFLINE =
  "Saved. It reaches your account when this computer is connected.";

/** If a secret leaked: the order that closes it fastest. */
export const SECRET_RECOVERY_TITLE = "If this secret leaked";

export const SECRET_RECOVERY_STEPS: readonly string[] = [
  "Remove it first: every sandbox stops using the old value.",
  "Rotate the credential at the service it belongs to.",
  "Replace the value here.",
  "Grant it again.",
];

/**
 * Remove's confirmation: "Added by you on 24 Oct. Version 1." Each clause
 * only when it is known; nothing is ever "unknown".
 */
export function secretRemovePreview(input: {
  readonly added: string | null;
  readonly version: number | null;
}): string {
  const clauses: string[] = [];
  if (input.added !== null) clauses.push(`${input.added}.`);
  if (input.version !== null) clauses.push(`Version ${input.version}.`);
  return clauses.join(" ");
}

/**
 * Remove's first line for a secret MCP servers use, around its "MCP servers"
 * link to that page; `null` when no server uses it.
 */
export function secretUsedByLine(servers: readonly string[]): {
  readonly before: string;
  readonly link: string;
  readonly after: string;
} | null {
  const first = servers.at(0);
  if (first === undefined) return null;
  if (servers.length === 1) {
    return {
      before: `Used by ${first}. Removing it leaves ${first} without a credential; if the server needs one, it stops working until you pick another secret on `,
      link: "MCP servers",
      after: ".",
    };
  }
  const second = servers.at(1) ?? "";
  const names =
    servers.length === 2
      ? `${first} and ${second}`
      : `${first}, ${second} and ${servers.length - 2} more`;
  return {
    before: `Used by ${names}. Removing it leaves them without a credential; any that need one stop working until you pick another secret on `,
    link: "MCP servers",
    after: ".",
  };
}

/** The add clause of Remove's preview: "Added by you on 24 Oct". */
export function secretAddedClause(createdAt: number, byYou: boolean): string {
  return `Added${byYou ? " by you" : ""} ${onSettingsDate(createdAt)}`;
}

export const SECRET_RECOVERY_FALLBACK =
  "If Traycer can't be reached, finish or stop running agent turns and shells before stopping the sandbox to end its sessions.";
