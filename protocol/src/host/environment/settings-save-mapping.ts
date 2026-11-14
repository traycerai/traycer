/**
 * Which environment item a save made in a host's settings becomes.
 *
 * The app remembers its edit from this and compares what it remembers with
 * the value authn holds through {@link canonicalSettingValue}. The function
 * reads its two arguments and nothing else: the request, and the rows of the
 * item the save is built over ({@link SettingsSaveBase}).
 *
 * The host proposes what it computes itself, never a value read from the
 * request. For the shell, pack policy and profile name or colour, the request
 * states the item the app expects (`selection`, `policy`,
 * `environmentProfileId`); the host never writes that statement over what it
 * computes. When the two differ, the app's remembered value matches no hold
 * and the change waits in the review list. No error is raised for it.
 *
 * A save whose item a host can only build from what it alone holds is
 * `unmapped`, with the reason, and nothing may fill it from host state: the
 * app cannot say "this is what I sent" for it.
 *
 * A settings method absent from {@link SettingsSave} proposes nothing: it
 * changes this host only (log levels, worktrees, visualization, session
 * names, catalog, simulator, the local-override pair, and the provider
 * settings that stay on this computer).
 */
import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import type {
  ConfigAgentMemoriesSetRequest,
  ConfigBrowserSetRequest,
  ConfigEnvDeleteRequest,
  ConfigEnvSetRequest,
  ConfigShellAddRequestV12,
  ConfigShellRemoveRequestV12,
  ConfigShellResetRequest,
  ConfigShellRevertArgsRequestV12,
  ConfigShellSelection,
  ConfigShellSetRequestV12,
} from "@traycer/protocol/host/config";
import {
  environmentItemKindSchema,
  environmentOsSchema,
  type EnvironmentAgentDefinitionsDeleteRequest,
  type EnvironmentAgentDefinitionsPutRequest,
  type EnvironmentOs,
  type EnvironmentSetupPutRequest,
} from "@traycer/protocol/host/environment-schemas";
import type { ProvidersFallbackPolicySetRequest } from "@traycer/protocol/host/fallback-policy";
import type {
  ProviderProfileActionV22,
  ProvidersDeleteEnvOverrideRequest,
  ProvidersNativeMutateRequestV14,
  ProvidersPackPolicyStatement,
  ProvidersSetEnabledRequestV22,
  ProvidersSetEnvOverrideRequest,
  ProvidersSetPackPolicyRequestV11,
  ProvidersUsePackVersionRequestV12,
} from "@traycer/protocol/host/provider-schemas";
import {
  harnessIdOfProvider,
  type HostOs,
} from "@traycer/protocol/host/environment/item-identity";
import {
  settingValueSchema,
  type SettingValue,
} from "@traycer/protocol/host/environment/settings-proposals";

/**
 * One save, by the method that made it. Every method through which a
 * person's save in a host's settings becomes an environment item.
 */
export type SettingsSave =
  | {
      readonly method: "config.shell.set";
      readonly request: ConfigShellSetRequestV12;
    }
  | {
      readonly method: "config.shell.reset";
      readonly request: ConfigShellResetRequest;
    }
  | {
      readonly method: "config.shell.add";
      readonly request: ConfigShellAddRequestV12;
    }
  | {
      readonly method: "config.shell.remove";
      readonly request: ConfigShellRemoveRequestV12;
    }
  | {
      readonly method: "config.shell.revertArgs";
      readonly request: ConfigShellRevertArgsRequestV12;
    }
  | { readonly method: "config.env.set"; readonly request: ConfigEnvSetRequest }
  | {
      readonly method: "config.env.delete";
      readonly request: ConfigEnvDeleteRequest;
    }
  | {
      readonly method: "config.browser.set";
      readonly request: ConfigBrowserSetRequest;
    }
  | {
      readonly method: "config.agentMemories.set";
      readonly request: ConfigAgentMemoriesSetRequest;
    }
  | {
      readonly method: "providers.setEnvOverride";
      readonly request: ProvidersSetEnvOverrideRequest;
    }
  | {
      readonly method: "providers.deleteEnvOverride";
      readonly request: ProvidersDeleteEnvOverrideRequest;
    }
  | {
      readonly method: "providers.usePackVersion";
      readonly request: ProvidersUsePackVersionRequestV12;
    }
  | {
      readonly method: "providers.setPackPolicy";
      readonly request: ProvidersSetPackPolicyRequestV11;
    }
  | {
      readonly method: "providers.setEnabled";
      readonly request: ProvidersSetEnabledRequestV22;
    }
  | {
      readonly method: "providers.fallbackPolicy.set";
      readonly request: ProvidersFallbackPolicySetRequest;
    }
  | {
      readonly method: "providers.nativeMutate";
      readonly request: ProvidersNativeMutateRequestV14;
    }
  | {
      readonly method: "environment.setup.put";
      readonly request: EnvironmentSetupPutRequest;
    }
  | {
      readonly method: "environment.agentDefinitions.put";
      readonly request: EnvironmentAgentDefinitionsPutRequest;
    }
  | {
      readonly method: "environment.agentDefinitions.delete";
      readonly request: EnvironmentAgentDefinitionsDeleteRequest;
    };

export type SettingsSaveMethod = SettingsSave["method"];

const editAddressFields = {
  kind: environmentItemKindSchema,
  key: lazySchema(() => z.string().min(1).max(3072)),
  /** Null for a kind with no per-OS rows. */
  os: lazySchema(() => environmentOsSchema.nullable()),
} as const;

/**
 * The item a save becomes. A put carries its value and
 * {@link canonicalSettingValue} of it, the form the app remembers and
 * compares a held value against; a delete carries neither.
 */
export const settingsItemEditSchema = lazySchema(() =>
  z.discriminatedUnion("operation", [
    z.object({
      ...editAddressFields,
      operation: z.literal("put"),
      value: settingValueSchema,
      canonicalValue: z.string(),
    }),
    z.object({
      ...editAddressFields,
      operation: z.literal("delete"),
      value: z.null(),
      canonicalValue: z.null(),
    }),
  ]),
);
export type SettingsItemEdit = z.infer<typeof settingsItemEditSchema>;

/**
 * Why a save has no mapping. Closed: every method maps to a proposal, to
 * nothing, or to one of these.
 *
 * - `key_from_host_state`: the item's key is found only in the host's own
 *   records (its managed entries, its profile store).
 * - `host_os_unknown`: the item has per-OS rows and the OS of the host the
 *   save is made on is not known.
 */
export const SETTINGS_SAVE_UNMAPPED_REASONS = [
  "key_from_host_state",
  "host_os_unknown",
] as const;
export type SettingsSaveUnmappedReason =
  (typeof SETTINGS_SAVE_UNMAPPED_REASONS)[number];

export type SettingsSaveMapping =
  | { readonly kind: "proposal"; readonly edit: SettingsItemEdit }
  /**
   * The app expects no proposal: the save changes this host only, or is
   * refused, or its request states no item (a caller older than the field).
   */
  | { readonly kind: "local_only" }
  /**
   * A skill removed from this host's global settings. The host's managed
   * entries decide whether it also deletes a leftover item of the retired
   * `skill` kind, on its own token, as it does today. Either way there is no
   * proposal and no hold, so the app remembers nothing.
   */
  | { readonly kind: "retired_item_delete" }
  /**
   * Promoting an MCP server to the environment: neither a proposal nor a
   * save on this host alone. Its form is not settled; nothing is built on it.
   */
  | { readonly kind: "mcp_promotion" }
  | { readonly kind: "unmapped"; readonly reason: SettingsSaveUnmappedReason };

/** The environment item whose rows a save is built over. */
export interface SettingsItemAddress {
  readonly kind: string;
  readonly key: string;
}

/** One row the environment holds for a save's item. */
export interface SettingsBaseRow {
  /** Null for a kind with no per-OS rows. */
  readonly os: EnvironmentOs | null;
  readonly value: SettingValue;
}

/**
 * What a save is built over besides its request.
 *
 * `rows` is every row of the item {@link settingsSaveBaseAddress} names,
 * every OS's, and is empty when the environment holds none or the save
 * names no item. The app passes the rows it read from authn on the person's
 * sign-in, never rows a host returned; the host passes the rows it received.
 * When the two differ, the edits differ and nothing is applied silently.
 */
export interface SettingsSaveBase {
  readonly rows: readonly SettingsBaseRow[];
  /** The OS of the host the save is made on; null when it is not known. */
  readonly hostOs: HostOs | null;
}

const LOCAL_ONLY: SettingsSaveMapping = { kind: "local_only" };

function unmapped(reason: SettingsSaveUnmappedReason): SettingsSaveMapping {
  return { kind: "unmapped", reason };
}

function put(
  address: SettingsItemAddress,
  os: EnvironmentOs | null,
  value: SettingValue,
): SettingsSaveMapping {
  return {
    kind: "proposal",
    edit: {
      ...address,
      os,
      operation: "put",
      value,
      canonicalValue: canonicalSettingValue(value),
    },
  };
}

function remove(
  address: SettingsItemAddress,
  os: EnvironmentOs | null,
): SettingsSaveMapping {
  return {
    kind: "proposal",
    edit: {
      ...address,
      os,
      operation: "delete",
      value: null,
      canonicalValue: null,
    },
  };
}

/**
 * The one canonical text of an item value: JSON with every object's own keys
 * in code-unit order at every depth and no whitespace. Two values give the
 * same text exactly when they are the same JSON, whatever order their keys
 * were written in; every own key counts, `__proto__` included. It compares
 * the values it is handed: a parser that drops a key before the value
 * reaches it is outside what it can see.
 */
export function canonicalSettingValue(value: SettingValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalSettingValue).join(",")}]`;
  }
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const keys = Object.keys(value).sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const members: string[] = [];
  for (const key of keys) {
    const child = value[key];
    if (child !== undefined) {
      members.push(`${JSON.stringify(key)}:${canonicalSettingValue(child)}`);
    }
  }
  return `{${members.join(",")}}`;
}

function objectOf(value: SettingValue): Record<string, SettingValue> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

/**
 * The OS row a per-OS edit is written as: this host's own OS's row when the
 * environment holds one, else the `any` row, as a host reads its item.
 */
function perOsRow(base: SettingsSaveBase): EnvironmentOs | null {
  const hostOs = base.hostOs;
  if (hostOs === null) return null;
  return base.rows.some((row) => row.os === hostOs) ? hostOs : "any";
}

/** The row of a kind with no per-OS rows. */
function singleRow(base: SettingsSaveBase): SettingsBaseRow | null {
  return base.rows.find((row) => row.os === null || row.os === "any") ?? null;
}

function perOsPut(
  address: SettingsItemAddress,
  base: SettingsSaveBase,
  value: SettingValue,
): SettingsSaveMapping {
  const os = perOsRow(base);
  return os === null ? unmapped("host_os_unknown") : put(address, os, value);
}

function perOsRemove(
  address: SettingsItemAddress,
  base: SettingsSaveBase,
): SettingsSaveMapping {
  const os = perOsRow(base);
  return os === null ? unmapped("host_os_unknown") : remove(address, os);
}

const SHELL: SettingsItemAddress = { kind: "shell", key: "shell" };

/** The shell item a shell save leaves, as the app states it. */
function shellEdit(
  selection: ConfigShellSelection,
  base: SettingsSaveBase,
): SettingsSaveMapping {
  switch (selection.kind) {
    case "shell":
      return perOsPut(SHELL, base, {
        path: selection.path,
        args: selection.args,
      });
    case "system_default":
      return perOsRemove(SHELL, base);
    case "not_stated":
      return LOCAL_ONLY;
  }
}

/** The pack policy a pack save leaves, as the app states it. */
function packPolicyEdit(
  packId: string,
  policy: ProvidersPackPolicyStatement,
): SettingsSaveMapping {
  if (policy === null) return LOCAL_ONLY;
  return put({ kind: "pack_policy", key: packId }, null, {
    pinnedVersion: policy.pinnedVersion,
    autoDownload: policy.autoDownload,
  });
}

/**
 * The `managed_profile` item a rename or recolor is for, keyed by the
 * harness id and the environment profile the request names; null for a
 * removal (its key is the host's alone), an acknowledgement, or a profile the
 * request names no environment profile for.
 */
function profileAddress(
  request: ProvidersSetEnabledRequestV22,
  action: ProviderProfileActionV22,
): SettingsItemAddress | null {
  if (action.type !== "rename" && action.type !== "recolor") return null;
  if (action.environmentProfileId === null) return null;
  return {
    kind: "managed_profile",
    key: `${harnessIdOfProvider(request.providerId)}:${action.environmentProfileId}`,
  };
}

/**
 * A rename or recolor: the environment's copy of the profile with the new
 * name or colour laid over it, every other field kept, `enabled` and the
 * broker's own fields included.
 */
function profileEdit(
  request: ProvidersSetEnabledRequestV22,
  base: SettingsSaveBase,
): SettingsSaveMapping {
  const action = request.profileAction;
  if (action === null || action.type === "acknowledgeAmbientDrift") {
    return LOCAL_ONLY;
  }
  if (action.type === "remove") return unmapped("key_from_host_state");
  const address = profileAddress(request, action);
  // With no environment profile named, the profile is this computer's own.
  if (address === null) return LOCAL_ONLY;
  const row = singleRow(base);
  const item = row === null ? null : objectOf(row.value);
  if (item === null) return LOCAL_ONLY;
  return put(
    address,
    null,
    action.type === "rename"
      ? { ...item, name: action.label }
      : { ...item, color: action.accentColor },
  );
}

/**
 * The item whose rows a save is built over, which the caller reads and
 * passes as {@link SettingsSaveBase.rows}; null when the save needs none.
 */
export function settingsSaveBaseAddress(
  save: SettingsSave,
): SettingsItemAddress | null {
  switch (save.method) {
    case "config.shell.set":
    case "config.shell.reset":
    case "config.shell.add":
    case "config.shell.remove":
    case "config.shell.revertArgs":
      return SHELL;
    case "config.env.set":
    case "config.env.delete":
      return { kind: "variable", key: save.request.key };
    case "providers.setEnvOverride":
    case "providers.deleteEnvOverride":
      return {
        kind: "env_override",
        key: `${save.request.providerId}:${save.request.key}`,
      };
    case "providers.nativeMutate": {
      const mutation = save.request.mutation;
      if (mutation.kind !== "mcp" || mutation.scope !== "global") return null;
      const action = mutation.mutation;
      if (action.action === "toggleTool")
        return { kind: "mcp_server", key: action.serverName };
      if (action.action === "remove")
        return { kind: "mcp_server", key: action.name };
      return null;
    }
    case "providers.setEnabled": {
      const action = save.request.profileAction;
      return action === null ? null : profileAddress(save.request, action);
    }
    case "config.browser.set":
    case "config.agentMemories.set":
    case "providers.usePackVersion":
    case "providers.setPackPolicy":
    case "providers.fallbackPolicy.set":
    case "environment.setup.put":
    case "environment.agentDefinitions.put":
    case "environment.agentDefinitions.delete":
      return null;
  }
}

function nativeMutateEdit(
  request: ProvidersNativeMutateRequestV14,
  base: SettingsSaveBase,
): SettingsSaveMapping {
  const mutation = request.mutation;
  if (mutation.kind === "promoteToPersonal") {
    return mutation.entryKind === "mcp"
      ? { kind: "mcp_promotion" }
      : LOCAL_ONLY;
  }
  if (mutation.scope !== "global") return LOCAL_ONLY;
  if (mutation.kind === "skills") {
    return mutation.mutation.action === "remove"
      ? { kind: "retired_item_delete" }
      : LOCAL_ONLY;
  }
  if (mutation.kind !== "mcp") return LOCAL_ONLY;
  const action = mutation.mutation;
  const row = singleRow(base);
  // With no item of that name the server is this host's own.
  if (row === null) return LOCAL_ONLY;
  if (action.action === "remove") {
    return remove({ kind: "mcp_server", key: action.name }, null);
  }
  if (action.action !== "toggleTool") return LOCAL_ONLY;
  const item = objectOf(row.value);
  if (item === null) return LOCAL_ONLY;
  const toggles = objectOf(item["toolToggles"] ?? {});
  if (toggles === null) return LOCAL_ONLY;
  const harnessId = harnessIdOfProvider(request.providerId);
  const harnessToggles = objectOf(toggles[harnessId] ?? {});
  if (harnessToggles === null) return LOCAL_ONLY;
  return put({ kind: "mcp_server", key: action.serverName }, null, {
    ...item,
    toolToggles: {
      ...toggles,
      [harnessId]: { ...harnessToggles, [action.toolName]: action.enabled },
    },
  });
}

/**
 * The item a save becomes, from its request and the rows it is built over.
 *
 * A proposal here is what the app expects to find held; it is never a
 * promise that the host proposes it. A host may propose nothing for a save
 * that maps to a proposal (the entry it changed was this host's own), and
 * then its save answer's `proposal` is null: the app may take that absence
 * as its cue to forget the edit, and never takes a value from a receipt.
 */
export function settingsSaveItemEdit(
  save: SettingsSave,
  base: SettingsSaveBase,
): SettingsSaveMapping {
  switch (save.method) {
    case "config.shell.set":
    case "config.shell.add":
    case "config.shell.remove":
    case "config.shell.revertArgs":
      return shellEdit(save.request.selection, base);
    case "config.shell.reset":
      return perOsRemove(SHELL, base);
    case "providers.usePackVersion":
    case "providers.setPackPolicy":
      return packPolicyEdit(save.request.packId, save.request.policy);
    case "config.env.set":
      // A null value masks an inherited variable on this host only.
      return save.request.value === null
        ? LOCAL_ONLY
        : perOsPut({ kind: "variable", key: save.request.key }, base, {
            value: save.request.value,
          });
    case "config.env.delete":
      return perOsRemove({ kind: "variable", key: save.request.key }, base);
    case "providers.setEnvOverride":
      return save.request.value === null
        ? LOCAL_ONLY
        : perOsPut(
            {
              kind: "env_override",
              key: `${save.request.providerId}:${save.request.key}`,
            },
            base,
            { value: save.request.value },
          );
    case "providers.deleteEnvOverride":
      return perOsRemove(
        {
          kind: "env_override",
          key: `${save.request.providerId}:${save.request.key}`,
        },
        base,
      );
    case "config.browser.set":
      return put({ kind: "browser_agent_access", key: "browser" }, null, {
        enabled: save.request.agentAccess,
      });
    case "config.agentMemories.set":
      return put({ kind: "agent_memory", key: "memory" }, null, {
        enabled: save.request.enabled,
      });
    case "providers.setEnabled":
      return profileEdit(save.request, base);
    case "providers.fallbackPolicy.set":
      return put(
        { kind: "fallback_policy", key: "fallback" },
        null,
        settingValueSchema.parse(
          JSON.parse(JSON.stringify({ document: save.request.policy })),
        ),
      );
    case "providers.nativeMutate":
      return nativeMutateEdit(save.request, base);
    case "environment.setup.put":
      return put({ kind: "setup_script", key: "setup" }, save.request.os, {
        text: save.request.text,
      });
    case "environment.agentDefinitions.put":
      return put({ kind: "agent_definition", key: save.request.name }, null, {
        text: save.request.text,
      });
    case "environment.agentDefinitions.delete":
      return remove({ kind: "agent_definition", key: save.request.name }, null);
  }
}
