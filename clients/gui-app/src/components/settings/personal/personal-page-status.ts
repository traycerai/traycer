import type {
  EnvironmentItemStatus,
  EnvironmentStatusResponse,
} from "@traycer/protocol/host/environment-schemas";
import { PROVIDER_DISPLAY_NAMES } from "@traycer/protocol/host/provider-schemas";
import type { SettingsSectionId } from "@/lib/settings-sections";

/**
 * What a Personal page says about the host it reads through: whether its
 * settings reached that host, from the host's own `environment.status`.
 *
 * A Personal page edits settings that follow the person to every host. The
 * host this window reads through answers for itself only, so the line names
 * it: "Applied on dev-box", "Applying Shell on dev-box", "Changes apply on
 * dev-box when it reconnects". The dashboard's Hosts page is where every host
 * is compared.
 */

/** The item kinds each Personal page edits (model page, the item kinds). */
const PAGE_ITEM_KINDS: Readonly<
  Partial<Record<SettingsSectionId, ReadonlySet<string>>>
> = {
  providers: new Set(["managed_profile", "env_override", "pack_policy"]),
  fallback: new Set(["fallback_policy"]),
  shell: new Set(["variable", "shell"]),
  agents: new Set(["agent_selection_guide"]),
  "browser-agent-access": new Set(["browser_agent_access"]),
  "mcp-servers": new Set(["mcp_server"]),
  skills: new Set(["skill"]),
  "agent-definitions": new Set(["agent_definition"]),
  "machine-setup": new Set(["setup_script"]),
};

/** Whether `section` is a Personal page that reports status. */
export function personalPageItemKinds(
  section: SettingsSectionId,
): ReadonlySet<string> | null {
  return PAGE_ITEM_KINDS[section] ?? null;
}

export type PersonalPageStatusTone = "info" | "warning" | "success";

export interface PersonalPageStatusLine {
  readonly tone: PersonalPageStatusTone;
  readonly text: string;
}

/**
 * The window host as a Personal page sees it:
 *  - `unsupported`: a version without these settings ("Update this host to
 *    use your settings"); the page is read-only.
 *  - `unknown`: not answered yet, or the read failed. Nothing is claimed.
 *  - `not-set-up`: the host serves the method and has no settings of the
 *    person's yet; the page works as it always has.
 *  - `ready`: the host's own status.
 */
export type PersonalHostState =
  | { readonly kind: "unsupported" }
  | { readonly kind: "unknown" }
  | { readonly kind: "not-set-up" }
  | { readonly kind: "ready"; readonly status: EnvironmentStatusResponse };

export const UPDATE_HOST_TEXT =
  "Update this host to use your settings. Until then this page is read-only.";

/** Why an item did not apply, in words, for the codes a person can act on. */
const FAILURE_REASONS: Readonly<Partial<Record<string, string>>> = {
  permission_denied: "permission denied",
  not_installed: "not installed on this host",
  invalid_value: "the value isn't valid",
  native_write_failed: "the setting couldn't be written",
  fetch_failed: "it couldn't be downloaded",
  timed_out: "it timed out",
};

/**
 * Why an item did not apply, for a code whose `args.kind` names the case: a
 * whole sentence, since the case carries what to do. Read before the code's
 * own reason.
 */
const FAILURE_CASES: Readonly<
  Partial<Record<string, Partial<Record<string, string>>>>
> = {
  unsupported_kind: {
    headers_in_sandbox: "Use a token for this server in sandboxes.",
  },
  // The host names the provider by its id with each `-` as `_`.
  native_write_failed: Object.fromEntries(
    Object.entries(PROVIDER_DISPLAY_NAMES).map(([providerId, name]) => [
      providerId.replaceAll("-", "_"),
      `It couldn't be written for ${name}.`,
    ]),
  ),
};

const SINGLETON_LABELS: Readonly<Partial<Record<string, string>>> = {
  shell: "The shell",
  fallback_policy: "Model routing",
  agent_selection_guide: "Agent selection",
  browser_agent_access: "Browser agent access",
  managed_profile: "A profile",
};

/** The name a person knows an item by: a variable's own name, else the page's. */
export function itemLabel(item: {
  readonly kind: string;
  readonly key: string;
}): string {
  if (item.kind === "variable") return item.key;
  if (item.kind === "env_override") {
    const separator = item.key.indexOf(":");
    return separator === -1 ? item.key : item.key.slice(separator + 1);
  }
  if (item.kind === "pack_policy") return item.key;
  // An MCP server's item is keyed by the server's name.
  if (item.kind === "mcp_server") return item.key;
  return SINGLETON_LABELS[item.kind] ?? "A setting";
}

function failedText(item: EnvironmentItemStatus, hostName: string): string {
  // Destructured, not `item.code`: the keyboard-read inventory treats any
  // expression with a `.code` read as a keyboard event, and `item.key` would
  // then count as a key read.
  const { code } = item;
  const caseKind = item.args.kind;
  const caseText =
    caseKind === null ? undefined : FAILURE_CASES[code]?.[caseKind];
  if (caseText !== undefined) {
    return `${itemLabel(item)} didn't apply on ${hostName}. ${caseText}`;
  }
  const reason = FAILURE_REASONS[code];
  return reason === undefined
    ? `${itemLabel(item)} didn't apply on ${hostName}.`
    : `${itemLabel(item)} didn't apply on ${hostName}: ${reason}.`;
}

function unsupportedText(
  item: EnvironmentItemStatus,
  hostName: string,
): string {
  // The floor rule: a floor names the version the host needs; at or above
  // it the field is null and the item is not supported on this version yet.
  return item.minimumHostVersion === null
    ? `${itemLabel(item)} isn't supported on this host version yet.`
    : `Update ${hostName} to use ${itemLabel(item)}.`;
}

/**
 * The one line a Personal page shows for `state`, or `null` for nothing to
 * say. Worst first: a host that cannot be reached, then a failure, then an
 * item this version cannot apply, then one still applying, then applied.
 */
export function personalPageStatusLine(
  state: PersonalHostState,
  kinds: ReadonlySet<string>,
  hostName: string,
): PersonalPageStatusLine | null {
  if (state.kind === "unsupported") {
    return { tone: "info", text: UPDATE_HOST_TEXT };
  }
  if (state.kind !== "ready") return null;
  const { status } = state;
  if (status.principal === null) return null;
  if (status.reachability !== "connected") {
    return {
      tone: "info",
      text: `Changes apply on ${hostName} when it reconnects.`,
    };
  }
  const items = status.items.filter((item) => kinds.has(item.kind));
  if (items.length === 0) return null;
  const failed = items.find((item) => item.status === "failed");
  if (failed !== undefined) {
    return { tone: "warning", text: failedText(failed, hostName) };
  }
  const unsupported = items.find((item) => item.status === "unsupported");
  if (unsupported !== undefined) {
    return { tone: "info", text: unsupportedText(unsupported, hostName) };
  }
  const pending = items.find((item) => item.status === "pending");
  if (pending !== undefined) {
    return {
      tone: "info",
      text: `Applying ${itemLabel(pending)} on ${hostName}.`,
    };
  }
  return { tone: "success", text: `Applied on ${hostName}.` };
}

/**
 * The keys of `kind` edited on this host while it could not reach the
 * person's settings, still waiting for their receipt. A row shows "pending"
 * until the receipt is accepted, which removes it from this set.
 */
export function pendingUploadKeys(
  state: PersonalHostState,
  kind: string,
): ReadonlySet<string> {
  if (state.kind !== "ready") return EMPTY_KEYS;
  const keys = state.status.pendingUploads
    .filter((upload) => upload.kind === kind && upload.receipt === "pending")
    .map((upload) => upload.key);
  return keys.length === 0 ? EMPTY_KEYS : new Set(keys);
}

const EMPTY_KEYS: ReadonlySet<string> = new Set();
