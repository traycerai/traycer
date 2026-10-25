import { useCallback, useMemo } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { z } from "zod";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { EnvironmentDescriptorV11 } from "@traycer/protocol/host/environment/contracts";
import { configurationRoleOf } from "@/components/settings/environment/configuration-source";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import type { ConfigurationItem } from "@/hooks/environment/team/use-configuration-items-query";
import {
  useHostQueriesWithResponseMap,
  type HostRequestSpec,
} from "@/hooks/host/use-host-queries";
import { usePoolTierHostClient } from "@/hooks/host/use-pool-tier";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";
import type { SandboxConfigurationDefaults } from "@/lib/sandboxes/sandbox-stage-model";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";

const METHOD = "environment.configuration.items";

/** The item every reader and the defaults card address. */
export const SANDBOX_DEFAULTS_KIND = "sandbox_defaults";
export const SANDBOX_DEFAULTS_KEY = "sandbox";

/** The item's value as authn validates it (`items.ts`); anything else reads as none. */
const sandboxDefaultsValueSchema = z.strictObject({
  os: z.enum(["linux", "windows"]),
  cpus: z.number().positive(),
  memoryMb: z.number().int().positive(),
  diskMb: z.number().int().positive(),
  idleMinutes: z.number().int().min(2),
  restingMinutes: z.number().int().min(1).nullable(),
});

/** A configuration's defaults as last read, with the revision a save quotes. */
export interface ConfigurationSandboxDefaults {
  /** `null`: none set, so a create takes the spec's. */
  readonly defaults: SandboxConfigurationDefaults | null;
  /** `null` when there is no item yet: a save creates it. */
  readonly revision: number | null;
}

function sandboxDefaultsOf(
  items: readonly ConfigurationItem[],
): ConfigurationSandboxDefaults {
  const item = items.find(
    (row) =>
      row.kind === SANDBOX_DEFAULTS_KIND && row.key === SANDBOX_DEFAULTS_KEY,
  );
  if (item === undefined) return { defaults: null, revision: null };
  const parsed = sandboxDefaultsValueSchema.safeParse(item.value);
  return {
    defaults: parsed.success ? parsed.data : null,
    revision: item.revision,
  };
}

export type SandboxDefaultsRead =
  | { readonly kind: "pending" }
  | { readonly kind: "failed"; readonly retry: () => void }
  | { readonly kind: "ready"; readonly value: ConfigurationSandboxDefaults };

/**
 * Each configuration's sandbox defaults, by environment id, from its
 * `sandbox_defaults` item on the configuration pool. One read per
 * environment, shared by the defaults card and the composer's New rows; a
 * save's reread (`useConfigurationItemMutations`) refreshes both.
 */
export function useSandboxDefaults(
  environmentIds: readonly string[],
): ReadonlyMap<string, SandboxDefaultsRead> {
  const client = usePoolTierHostClient(useHostClient());
  const viewerId = useCloudChatViewerId();
  const authorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  const idsKey = environmentIds.join("\n");
  const ids = useMemo(
    () => idsKey.split("\n").filter((id) => id.length > 0),
    [idsKey],
  );
  const requests = useMemo(
    (): ReadonlyArray<HostRequestSpec<HostRpcRegistry, typeof METHOD>> =>
      ids.map((environmentId) => ({
        method: METHOD,
        params: { environmentId },
      })),
    [ids],
  );
  const combine = useCallback(
    (
      results: Array<
        UseQueryResult<ConfigurationSandboxDefaults, HostRpcError>
      >,
    ): ReadonlyMap<string, SandboxDefaultsRead> =>
      new Map(
        ids.map((environmentId, index): [string, SandboxDefaultsRead] => {
          const result = results[index];
          if (result.status === "error") {
            return [
              environmentId,
              {
                kind: "failed",
                retry: () => {
                  void result.refetch();
                },
              },
            ];
          }
          return [
            environmentId,
            result.data === undefined
              ? { kind: "pending" }
              : { kind: "ready", value: result.data },
          ];
        }),
      ),
    [ids],
  );
  return useHostQueriesWithResponseMap<
    HostRpcRegistry,
    typeof METHOD,
    ConfigurationSandboxDefaults,
    ReadonlyMap<string, SandboxDefaultsRead>
  >({
    client,
    requests,
    cacheKeyIdentity: viewerId,
    options: { enabled: viewerId.length > 0 && authorized },
    preflight: cloudVerdictPreflight(METHOD),
    mapResponse: ({ response }) => sandboxDefaultsOf(response.items),
    combine,
  });
}

/** A configuration's environment as the account's list names it, with the viewer's role. */
export interface SandboxDefaultsEnvironment {
  readonly environmentId: string;
  readonly role: "owner" | "admin" | "editor" | "viewer";
}

/**
 * The environments a configuration's defaults live in: Personal's and each
 * team's, by `personal` or team id. A configuration absent from the list
 * (not answered yet, or never set up) has none; `enabled` false reads none.
 */
export function useSandboxDefaultsEnvironments(
  enabled: boolean,
): ReadonlyMap<string, SandboxDefaultsEnvironment> {
  const list = useEnvironmentListQuery(useHostClient(), enabled);
  return useMemo(
    () =>
      new Map(
        (list.data?.environments ?? []).map(
          (descriptor: EnvironmentDescriptorV11) => [
            descriptor.ownerKind === "user" ? "personal" : descriptor.ownerId,
            {
              environmentId: descriptor.environmentId,
              role: configurationRoleOf(descriptor),
            },
          ],
        ),
      ),
    [list.data],
  );
}

/**
 * One configuration's defaults, by `personal` or team id: its environment
 * (`null` when it has none) and the read of its item (`null` with no
 * environment, so a create takes the spec's).
 */
export function useConfigurationSandboxDefaults(configurationKey: string): {
  readonly environment: SandboxDefaultsEnvironment | null;
  readonly read: SandboxDefaultsRead | null;
} {
  const environment =
    useSandboxDefaultsEnvironments(true).get(configurationKey) ?? null;
  const reads = useSandboxDefaults(
    environment === null ? [] : [environment.environmentId],
  );
  return {
    environment,
    read:
      environment === null
        ? null
        : (reads.get(environment.environmentId) ?? { kind: "pending" }),
  };
}

/**
 * Every configuration's defaults as a lookup by `personal` or team id: `null`
 * while unread, unset or unreadable, so a create takes the spec's. `enabled`
 * false reads nothing (a picker that stages nothing).
 */
export function useSandboxDefaultsLookup(
  enabled: boolean,
): (configurationKey: string) => SandboxConfigurationDefaults | null {
  const environments = useSandboxDefaultsEnvironments(enabled);
  const reads = useSandboxDefaults(
    enabled
      ? [...environments.values()].map((entry) => entry.environmentId)
      : [],
  );
  return useCallback(
    (configurationKey: string): SandboxConfigurationDefaults | null => {
      const environment = environments.get(configurationKey);
      const read =
        environment === undefined
          ? undefined
          : reads.get(environment.environmentId);
      return read !== undefined && read.kind === "ready"
        ? read.value.defaults
        : null;
    },
    [environments, reads],
  );
}
