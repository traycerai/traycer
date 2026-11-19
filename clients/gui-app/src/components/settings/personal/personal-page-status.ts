import type { EnvironmentStatusResponse } from "@traycer/protocol/host/environment-schemas";
import { PROVIDER_DISPLAY_NAMES } from "@traycer/protocol/host/provider-schemas";
import type { SettingsSectionId } from "@/lib/settings-sections";
import { ownValue } from "@/lib/own-value";

/** The item kinds each Personal page edits (model page, the item kinds). */
const PAGE_ITEM_KINDS: Readonly<
  Partial<Record<SettingsSectionId, ReadonlySet<string>>>
> = {
  providers: new Set(["managed_profile", "env_override", "pack_policy"]),
  fallback: new Set(["fallback_policy"]),
  shell: new Set(["variable", "shell"]),
  agents: new Set(["agent_selection_guide", "agent_definition"]),
  "mcp-servers": new Set(["mcp_server"]),
  skills: new Set(["skill"]),
  "machine-setup": new Set(["setup_script"]),
};

/** The item kinds `section` edits, or `null` for a page with none. */
export function personalPageItemKinds(
  section: SettingsSectionId,
): ReadonlySet<string> | null {
  return PAGE_ITEM_KINDS[section] ?? null;
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
export const FAILURE_REASONS: Readonly<Partial<Record<string, string>>> = {
  permission_denied: "permission denied",
  not_installed: "not installed on this host",
  invalid_value: "the value isn't valid",
  native_write_failed: "the setting couldn't be written",
  fetch_failed: "it couldn't be downloaded",
  timed_out: "it timed out",
};

/**
 * The kinds a configuration holds one of, named by the Settings page or tab
 * that owns them; their keys are storage names a person never reads.
 */
const PAGE_NAMED_KINDS: Readonly<Partial<Record<string, string>>> = {
  shell: "The shell",
  fallback_policy: "Model routing",
  agent_selection_guide: "Agent selection",
  browser_agent_access: "Browser agent access",
  auto_policy: "Permissions",
  sandbox_defaults: "Sandbox defaults",
};

/**
 * The page name of an item of `kind`, or `null` for a kind a person knows by
 * each item's own name (a variable, an MCP server).
 */
export function itemPageName(kind: string): string | null {
  return ownValue(PAGE_NAMED_KINDS, kind) ?? null;
}

/**
 * An env override's provider, from its item key `<providerId>:<variable>`,
 * or `null` for a key without a known provider.
 */
export function envOverrideProviderName(key: string): string | null {
  const separator = key.indexOf(":");
  if (separator === -1) return null;
  const providerId = key.slice(0, separator);
  return (
    Object.entries(PROVIDER_DISPLAY_NAMES).find(
      ([id]) => id === providerId,
    )?.[1] ?? null
  );
}

/**
 * A move or stop row's name: its page's name for a kind a configuration
 * holds one of, `<variable> (<Provider>)` for an env override, else the
 * row's own label (a variable's or a server's name).
 */
export function moveRowLabel(row: {
  readonly kind: string;
  readonly key: string;
  readonly label: string;
}): string {
  const pageName = itemPageName(row.kind);
  if (pageName !== null) return pageName;
  if (row.kind !== "env_override") return row.label;
  const provider = envOverrideProviderName(row.key);
  const variable = itemLabel(row);
  return provider === null ? variable : `${variable} (${provider})`;
}

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
  if (item.kind === "managed_profile") return "A profile";
  return itemPageName(item.kind) ?? "A setting";
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
