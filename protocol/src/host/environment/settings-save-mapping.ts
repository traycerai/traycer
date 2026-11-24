// The app pairs an edit with the live revision it read itself, never one a host
// reported. For a stated item (shell `selection`, pack `policy`) the host proposes
// what it computes and never the stated value; a difference waits in review.
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
import { harnessIdOfProvider } from "@traycer/protocol/host/environment/item-identity";
import type { HostOs } from "@traycer/protocol/host/environment/host-os";
import {
  settingValueSchema,
  type SettingValue,
} from "@traycer/protocol/host/environment/settings-proposals";

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

/** A put carries its value and its canonical text; a delete carries neither. */
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

/** Closed: every method maps to a proposal, to nothing, or to one of these. */
export const SETTINGS_SAVE_UNMAPPED_REASONS = [
  "key_from_host_state",
  "host_os_unknown",
] as const;
export type SettingsSaveUnmappedReason =
  (typeof SETTINGS_SAVE_UNMAPPED_REASONS)[number];

export type SettingsSaveMapping =
  | { readonly kind: "proposal"; readonly edit: SettingsItemEdit }
  | { readonly kind: "local_only" }
  /** Either way there is no proposal and no hold. */
  | { readonly kind: "retired_item_delete" }
  /** Its form is not settled; nothing is built on it. */
  | { readonly kind: "mcp_promotion" }
  | { readonly kind: "unmapped"; readonly reason: SettingsSaveUnmappedReason };

export interface SettingsItemAddress {
  readonly kind: string;
  readonly key: string;
}

export interface SettingsBaseRow {
  /** Null for a kind with no per-OS rows. */
  readonly os: EnvironmentOs | null;
  readonly value: SettingValue;
}

/** The app passes rows it read from authn, never rows a host returned; when they differ nothing is applied silently. */
export interface SettingsSaveBase {
  readonly rows: readonly SettingsBaseRow[];
  readonly hostOs: HostOs | null;
  /** The host edits its own settings, so the Personal rows only supply the address and base. */
  readonly prebind?: true;
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

/** Every object's own keys in code-unit order at every depth, `__proto__` included; no whitespace. */
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

/** This host's own OS's row when the environment holds one, else the `any` row. */
function perOsRow(base: SettingsSaveBase): EnvironmentOs | null {
  const hostOs = base.hostOs;
  if (hostOs === null) return null;
  return base.rows.some((row) => row.os === hostOs) ? hostOs : "any";
}

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

/** null for a removal (its key is the host's alone), an acknowledgement, or no environment profile named. */
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

/** Every other field is kept, `enabled` and the broker's fields included. */
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
    case "providers.usePackVersion":
    case "providers.setPackPolicy":
      return { kind: "pack_policy", key: save.request.packId };
    case "config.browser.set":
    case "config.agentMemories.set":
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

function rowAt(
  base: SettingsSaveBase,
  os: EnvironmentOs | null,
): SettingsBaseRow | null {
  return os === null
    ? singleRow(base)
    : (base.rows.find((row) => row.os === os) ?? null);
}

function unlessUnchanged(
  mapping: SettingsSaveMapping,
  base: SettingsSaveBase,
): SettingsSaveMapping {
  if (mapping.kind !== "proposal") return mapping;
  const edit = mapping.edit;
  const row = rowAt(base, edit.os);
  if (edit.operation === "delete") return row === null ? LOCAL_ONLY : mapping;
  return row !== null &&
    canonicalSettingValue(row.value) === edit.canonicalValue
    ? LOCAL_ONLY
    : mapping;
}

/**
 * Never a promise the host proposes it: a null `proposal` in the save answer lets
 * the app forget the edit. A value is never taken from a receipt.
 */
export function settingsSaveItemEdit(
  save: SettingsSave,
  base: SettingsSaveBase,
): SettingsSaveMapping {
  const mapping = itemEditOf(save, base);
  // A prebind edit can be different on the host even if it agrees with Personal.
  return base.prebind === true || settingsSaveBaseAddress(save) === null
    ? mapping
    : unlessUnchanged(mapping, base);
}

function itemEditOf(
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
