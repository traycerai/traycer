import type { SandboxSecretMode } from "@traycer/protocol/host/secret-intake-catalogue";

/**
 * The words of Settings ▸ Personal ▸ Secrets. Four words carry Personal pages:
 * Personal, secret, variable and host; nothing here names the mechanism a value
 * travels by.
 */

export const SECRETS_EMPTY_TEXT =
  "Secrets are keys and logins your agents use. On a sandbox they are used without being seen; on a computer you own they are set as values.";

export const SECRETS_ADD_LABEL = "Add a secret";

/** Under each personal secret: where its value is readable. */
export const SECRET_READABLE_WHERE =
  "Written as a plain value on every host you own; agents there can read it. Brokered on your sandboxes.";

/** On a team's host, in place of the list's actions. */
export const TEAM_SECRETS_LINE =
  "Team secrets are brokered only; a tool that needs a plain value needs a personal sandbox.";

/**
 * The confirmation a save waits for: where the value becomes readable once
 * it is saved, per the mode chosen for sandboxes.
 */
export function secretSaveConfirmationLines(
  name: string,
  mode: SandboxSecretMode,
  sandboxesByDefault: boolean,
): readonly string[] {
  const sandboxes =
    mode === "brokered"
      ? "On your sandboxes agents use it without reading it."
      : "On your sandboxes any process can read it.";
  return [
    `${name} will be written as a plain value on every host you own, where agents can read it.`,
    sandboxesByDefault
      ? `${sandboxes} Every sandbox you have now and later gets it.`
      : `${sandboxes} A sandbox gets it only when you approve one.`,
  ];
}

export const SECRET_REVOKED_LABEL = "Revoked";
export const SECRET_PENDING_REVIEW_LABEL = "Waiting for you";

/**
 * Beside Replace value, Undo and Destroy, and under the recovery order: what
 * one change reaches.
 */
export const SECRET_SCOPE_LINE =
  "This changes the copy stored here. If the same credential is stored anywhere else, that copy needs its own replacement.";

/** After a replacement: what a running tool on an owned host keeps. */
export const SECRET_RESTART_LINE =
  "A tool already running on this computer keeps the old value until it restarts.";

export const SECRET_REPLACE_STALE =
  "Changed somewhere else just now. Look again before you replace it.";

export const SECRET_SAVED_OFFLINE =
  "Saved. It reaches your account when this computer is connected.";

/** If a secret leaked: the order that closes it fastest. */
export const SECRET_RECOVERY_TITLE = "If this secret leaked";

export const SECRET_RECOVERY_STEPS: readonly string[] = [
  "Revoke it first, in the dashboard: every sandbox stops using the old value within seconds, and each computer you own that holds it as a plain value is listed for you to clear.",
  "Rotate the credential at the service it belongs to.",
  "Replace the value here.",
  "Grant it again.",
];

export const SECRET_RECOVERY_FALLBACK =
  "If Traycer can't be reached, stopping the sandbox ends its sessions.";
