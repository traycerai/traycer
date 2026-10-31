/**
 * The words of Settings ▸ Personal ▸ Secrets. Four words carry Personal pages:
 * Personal, secret, variable and host; nothing here names the mechanism a value
 * travels by.
 */

import { namedHosts } from "@/components/settings/environment/status-chip-model";
import {
  formatSettingsDate,
  onSettingsDate,
} from "@/lib/settings/settings-date";

export const SECRETS_EMPTY_TEXT =
  "Values and logins your agents use. On your computers they are set as values; on sandboxes agents use them without seeing them.";

/** A team's Secrets text, as its subtitle and as its empty state. */
export function teamSecretsText(teamName: string): string {
  return `Values and logins ${teamName}'s agents use, on its sandboxes without being seen.`;
}

export const SECRETS_ADD_LABEL = "Add a secret";

export const SECRETS_NEED_UPDATED_HOST = "These secrets need an updated host.";

/** In place of the list when Personal's secrets could not be read. */
export const PERSONAL_SECRETS_READ_FAILED = "Couldn't read Personal's secrets.";

/** In place of the kinds Add a secret does not offer: a provider's key. */
export const PROVIDER_KEYS_LINE = {
  before: "Provider keys are set on each provider's Account tab, under ",
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
 * added by you 24 Oct", each clause only when it is known.
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
  "Team secrets are brokered only; a tool that needs a plain value needs a personal sandbox.";

export const SECRET_REVOKED_LABEL = "Revoked";
export const SECRET_PENDING_REVIEW_LABEL = "Waiting for you";

/**
 * Beside Replace value, Undo and Destroy, and under the recovery order: what
 * one change reaches.
 */
export const SECRET_SCOPE_LINE =
  "This changes the copy stored here. If the same credential is stored anywhere else, that copy needs its own replacement.";

/**
 * On every secret and key Add and Replace: where the value is stored and
 * who can read it. Personal's sentence; a team has its own.
 */
export const SECRET_CUSTODY_SENTENCE =
  "Stored encrypted in Traycer's cloud. Computers running Personal receive the value, readable by their tools and agents; sandboxes use it without seeing it.";

/** After a replacement, and on Replace itself: what a running tool keeps. */
export const SECRET_RESTART_LINE =
  "Tools already running keep the old value until they restart.";

export const SECRET_REPLACE_STALE =
  "Changed somewhere else just now. Look again before you replace it.";

export const SECRET_SAVED_OFFLINE =
  "Saved. It reaches your account when this computer is connected.";

/** If a secret leaked: the order that closes it fastest. */
export const SECRET_RECOVERY_TITLE = "If this secret leaked";

export const SECRET_RECOVERY_STEPS: readonly string[] = [
  "Remove it first: every sandbox stops using the old value, and each computer that holds it as a value keeps it until its tools restart.",
  "Rotate the credential at the service it belongs to.",
  "Replace the value here.",
  "Grant it again.",
];

/**
 * Remove's confirmation: "Added by you on 24 Oct. Version 1. On dev-box and
 * laptop. Tools already running keep it until they restart." Each of the
 * first three clauses only when it is known; nothing is ever "unknown".
 * `computers` are the ones holding a copy, named as the page chip names them.
 */
export function secretRemovePreview(input: {
  readonly added: string | null;
  readonly version: number | null;
  readonly computers: readonly string[];
}): string {
  const clauses: string[] = [];
  if (input.added !== null) clauses.push(`${input.added}.`);
  if (input.version !== null) clauses.push(`Version ${input.version}.`);
  if (input.computers.length > 0) {
    clauses.push(`On ${namedHosts(input.computers, "computers")}.`);
  }
  clauses.push("Tools already running keep it until they restart.");
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
  "If Traycer can't be reached, stopping the sandbox ends its sessions.";
