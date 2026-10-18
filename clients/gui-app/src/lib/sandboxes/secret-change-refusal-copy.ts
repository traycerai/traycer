import type { SECRET_UNDO_REFUSAL_CODES } from "@traycer/protocol/host/environment-schemas";

/**
 * The line a refused secret change shows, keyed by the change and the
 * refusal's code. A code with no row here (`secret_name_taken` among them)
 * returns `null`: the caller shows the refusal's own message, as the generic
 * error arm carries it.
 */
export type SecretChangeOperation = "create" | "undo" | "destroy";

type UndoRefusalCode = (typeof SECRET_UNDO_REFUSAL_CODES)[number];

const UNDO_REFUSAL_LINES: Readonly<Record<UndoRefusalCode, string>> = {
  version_destroyed: "That value was destroyed, so it cannot be restored.",
  secret_revoked:
    "This secret is revoked. Restore it to undo; it gets the grants a new secret gets.",
  version_current: "That value is already the current one.",
  secret_version_stale:
    "Changed somewhere else just now. Look again before you undo.",
};

const DESTROY_REFUSAL_LINES: Readonly<Record<string, string>> = {
  version_current: "This is the current value. Replace or revoke it first.",
};

const CREATE_REFUSAL_LINES: Readonly<Record<string, string>> = {
  team_secrets_are_brokered:
    "Team secrets are brokered only; a tool that needs a plain value needs a personal sandbox.",
  provider_name_unknown:
    "Choose the provider; a model provider key takes its provider's variable name.",
};

function lineFor(
  lines: Readonly<Record<string, string>>,
  code: string,
): string | null {
  return Object.hasOwn(lines, code) ? (lines[code] ?? null) : null;
}

export function secretChangeRefusalLine(
  operation: SecretChangeOperation,
  code: string,
): string | null {
  switch (operation) {
    case "undo":
      return lineFor(UNDO_REFUSAL_LINES, code);
    case "destroy":
      return lineFor(DESTROY_REFUSAL_LINES, code);
    case "create":
      return lineFor(CREATE_REFUSAL_LINES, code);
  }
}
