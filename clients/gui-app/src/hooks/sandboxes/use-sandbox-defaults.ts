import { useCallback, useMemo } from "react";
import {
  queryOptions,
  useQueries,
  type UseQueryResult,
} from "@tanstack/react-query";
import { z } from "zod";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  EnvironmentDescriptorV11,
  GrantedEnvironmentRole,
} from "@traycer/protocol/host/environment/contracts";
import { configurationRoleOf } from "@/components/settings/environment/configuration-source";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import type { ConfigurationItem } from "@/hooks/environment/team/use-configuration-items-query";
import {
  environmentCloudQueryKey,
  beginEnvironmentCloudOperation,
  useEnvironmentCloud,
} from "@/hooks/environment/use-environment-cloud";
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
  /** `null`: none set, so a create takes the built-in defaults. */
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
 * `sandbox_defaults` item, read by the app itself from authn on the
 * viewer's sign-in. One read per environment, shared by the defaults card and
 * the composer's New rows; a save's reread (`useConfigurationItemMutations`)
 * refreshes both.
 */
export function useSandboxDefaults(
  environmentIds: readonly string[],
): ReadonlyMap<string, SandboxDefaultsRead> {
  const viewerId = useCloudChatViewerId();
  const authorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  const cloud = useEnvironmentCloud();
  const idsKey = environmentIds.join("\n");
  const ids = useMemo(
    () => idsKey.split("\n").filter((id) => id.length > 0),
    [idsKey],
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
  return useQueries({
    queries: ids.map((environmentId) =>
      // `cloud` is the sign-in of the viewer the key already names; adding it
      // would refetch on its identity alone.
      // eslint-disable-next-line @tanstack/query/exhaustive-deps
      queryOptions<ConfigurationSandboxDefaults, HostRpcError>({
        queryKey: environmentCloudQueryKey(
          METHOD,
          { environmentId },
          viewerId,
          [],
        ),
        queryFn: async (): Promise<ConfigurationSandboxDefaults> =>
          sandboxDefaultsOf(
            (
              await beginEnvironmentCloudOperation(cloud)(METHOD, {
                environmentId,
              })
            ).items,
          ),
        enabled: cloud !== null && viewerId.length > 0 && authorized,
      }),
    ),
    combine,
  });
}

/** A configuration's environment as the account's list names it, with the reader's role. */
export interface SandboxDefaultsEnvironment {
  readonly environmentId: string;
  /** `null` for a role that authorizes nothing. */
  readonly role: GrantedEnvironmentRole | null;
}

/**
 * The environments a configuration's defaults live in: Personal's and each
 * team's, by `personal` or team id. A configuration absent from the list
 * (not answered yet, or never set up) has none; `enabled` false reads none.
 */
export function useSandboxDefaultsEnvironments(
  enabled: boolean,
): ReadonlyMap<string, SandboxDefaultsEnvironment> {
  const list = useEnvironmentListQuery(enabled);
  return useMemo(
    () =>
      new Map(
        (list.data?.environments ?? []).map(
          (descriptor: EnvironmentDescriptorV11) => {
            const role = configurationRoleOf(descriptor);
            return [
              descriptor.ownerKind === "user" ? "personal" : descriptor.ownerId,
              {
                environmentId: descriptor.environmentId,
                role: role === "viewer" ? null : role,
              },
            ];
          },
        ),
      ),
    [list.data],
  );
}

/**
 * One configuration's defaults, by `personal` or team id: its environment
 * (`null` when it has none) and the read of its item (`null` with no
 * environment, so a create takes the built-in defaults).
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
 * while unread, unset or unreadable, so a create takes the built-in defaults. `enabled`
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
