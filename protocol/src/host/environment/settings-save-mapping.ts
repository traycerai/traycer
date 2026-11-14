/**
 * Which environment item a save made in a host's settings becomes, computed
 * from the request alone.
 *
 * The host builds its proposal from this, and the app remembers its edit
 * from this, so the value the app remembers and the value authn holds
 * compare byte for byte through {@link canonicalSettingValue}. The function
 * reads nothing but its argument: no host state, no clock, no environment.
 *
 * A save whose item a host can only build from what it already holds is
 * `unmapped`, with the reason, and nothing may fill it from host state: the
 * app cannot say "this is what I sent" for it.
 */
import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import type {
  ConfigAgentMemoriesSetRequest,
  ConfigBrowserSetRequest,
  ConfigEnvDeleteRequest,
  ConfigEnvSetRequest,
  ConfigShellAddRequest,
  ConfigShellRemoveRequest,
  ConfigShellResetRequest,
  ConfigShellRevertArgsRequest,
  ConfigShellSetRequest,
} from "@traycer/protocol/host/config";
import {
  environmentItemKindSchema,
  environmentOsSchema,
  type EnvironmentAgentDefinitionsDeleteRequest,
  type EnvironmentAgentDefinitionsPutRequest,
  type EnvironmentSetupPutRequest,
} from "@traycer/protocol/host/environment-schemas";
import type { ProvidersFallbackPolicySetRequest } from "@traycer/protocol/host/fallback-policy";
import type {
  ProvidersDeleteEnvOverrideRequest,
  ProvidersNativeMutateRequestV14,
  ProvidersSetEnabledRequestV21,
  ProvidersSetEnvOverrideRequest,
  ProvidersSetPackPolicyRequest,
  ProvidersUsePackVersionRequest,
} from "@traycer/protocol/host/provider-schemas";
import {
  settingValueSchema,
  settingsProposalOperationSchema,
  type SettingValue,
} from "@traycer/protocol/host/environment/settings-proposals";

/**
 * One save, by the method that made it. Every method through which a
 * person's save in a host's settings becomes an environment item.
 */
export type SettingsSave =
  | {
      readonly method: "config.shell.set";
      readonly request: ConfigShellSetRequest;
    }
  | {
      readonly method: "config.shell.reset";
      readonly request: ConfigShellResetRequest;
    }
  | {
      readonly method: "config.shell.add";
      readonly request: ConfigShellAddRequest;
    }
  | {
      readonly method: "config.shell.remove";
      readonly request: ConfigShellRemoveRequest;
    }
  | {
      readonly method: "config.shell.revertArgs";
      readonly request: ConfigShellRevertArgsRequest;
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
      readonly request: ProvidersUsePackVersionRequest;
    }
  | {
      readonly method: "providers.setPackPolicy";
      readonly request: ProvidersSetPackPolicyRequest;
    }
  | {
      readonly method: "providers.setEnabled";
      readonly request: ProvidersSetEnabledRequestV21;
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

/**
 * The item a save becomes. `os` is null for a kind with no per-OS rows.
 * `value` is null for a delete. `canonicalValue` is
 * {@link canonicalSettingValue} of `value`, null for a delete: the form the
 * app remembers and compares a held value against.
 */
export const settingsItemEditSchema = lazySchema(() =>
  z.object({
    kind: environmentItemKindSchema,
    key: z.string().min(1).max(3072),
    os: environmentOsSchema.nullable(),
    operation: settingsProposalOperationSchema,
    value: settingValueSchema.nullable(),
    canonicalValue: z.string().nullable(),
  }),
);
export type SettingsItemEdit = z.infer<typeof settingsItemEditSchema>;

/**
 * Why a save has no mapping from its request alone.
 *
 * - `merges_host_state`: the item's value is the request merged into what
 *   the host holds (a received row, its own config or policy file).
 * - `key_from_host_state`: the item's key is found in the host's own
 *   records (its managed entries, its profile store).
 * - `os_from_host_row`: the item has per-OS rows and the request names no
 *   OS; the host proposes against the OS row it received.
 */
export const SETTINGS_SAVE_UNMAPPED_REASONS = [
  "merges_host_state",
  "key_from_host_state",
  "os_from_host_row",
] as const;
export type SettingsSaveUnmappedReason =
  (typeof SETTINGS_SAVE_UNMAPPED_REASONS)[number];

export type SettingsSaveMapping =
  | { readonly kind: "proposal"; readonly edit: SettingsItemEdit }
  /** The save changes this host only and proposes nothing. */
  | { readonly kind: "local_only" }
  | { readonly kind: "unmapped"; readonly reason: SettingsSaveUnmappedReason };

const LOCAL_ONLY: SettingsSaveMapping = { kind: "local_only" };

function unmapped(reason: SettingsSaveUnmappedReason): SettingsSaveMapping {
  return { kind: "unmapped", reason };
}

function put(
  kind: string,
  key: string,
  os: SettingsItemEdit["os"],
  value: SettingValue,
): SettingsSaveMapping {
  return {
    kind: "proposal",
    edit: {
      kind,
      key,
      os,
      operation: "put",
      value,
      canonicalValue: canonicalSettingValue(value),
    },
  };
}

function remove(
  kind: string,
  key: string,
  os: SettingsItemEdit["os"],
): SettingsSaveMapping {
  return {
    kind: "proposal",
    edit: {
      kind,
      key,
      os,
      operation: "delete",
      value: null,
      canonicalValue: null,
    },
  };
}

/**
 * The one canonical text of an item value: JSON with every object's keys in
 * code-unit order at every depth and no whitespace. Two values that are the
 * same JSON give the same text whatever order their keys were written or
 * stored in.
 */
export function canonicalSettingValue(value: SettingValue): string {
  return JSON.stringify(sortedKeys(value));
}

function sortedKeys(value: SettingValue): SettingValue {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value === null || typeof value !== "object") return value;
  const sorted: Record<string, SettingValue> = {};
  const keys = Object.keys(value).sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  for (const key of keys) {
    const child = value[key];
    if (child !== undefined) sorted[key] = sortedKeys(child);
  }
  return sorted;
}

/** The item a save becomes, from its request alone. */
export function settingsSaveItemEdit(save: SettingsSave): SettingsSaveMapping {
  switch (save.method) {
    case "config.shell.set":
    case "config.shell.add":
    case "config.shell.remove":
    case "config.shell.revertArgs":
    case "providers.usePackVersion":
    case "providers.setPackPolicy":
      return unmapped("merges_host_state");
    case "config.shell.reset":
    case "config.env.delete":
    case "providers.deleteEnvOverride":
      return unmapped("os_from_host_row");
    case "config.env.set":
    case "providers.setEnvOverride":
      // A null value masks an inherited variable on this host only.
      return save.request.value === null
        ? LOCAL_ONLY
        : unmapped("os_from_host_row");
    case "config.browser.set":
      return put("browser_agent_access", "browser", null, {
        enabled: save.request.agentAccess,
      });
    case "config.agentMemories.set":
      return put("agent_memory", "memory", null, {
        enabled: save.request.enabled,
      });
    case "providers.setEnabled": {
      const action = save.request.profileAction;
      if (action === null || action.type === "acknowledgeAmbientDrift")
        return LOCAL_ONLY;
      return unmapped(
        action.type === "remove" ? "key_from_host_state" : "merges_host_state",
      );
    }
    case "providers.fallbackPolicy.set":
      return put(
        "fallback_policy",
        "fallback",
        null,
        settingValueSchema.parse(
          JSON.parse(JSON.stringify({ document: save.request.policy })),
        ),
      );
    case "providers.nativeMutate":
      return unmapped("key_from_host_state");
    case "environment.setup.put":
      return put("setup_script", "setup", save.request.os, {
        text: save.request.text,
      });
    case "environment.agentDefinitions.put":
      return put("agent_definition", save.request.name, null, {
        text: save.request.text,
      });
    case "environment.agentDefinitions.delete":
      return remove("agent_definition", save.request.name, null);
  }
}
