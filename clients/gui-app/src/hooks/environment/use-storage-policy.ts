import { z } from "zod";
import type { UseQueryResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import type { ConfigurationItem } from "@/hooks/environment/team/use-configuration-items-query";
import { useHostQueryWithResponseMap } from "@/hooks/host/use-host-query";
import { usePoolTierHostClient } from "@/hooks/host/use-pool-tier";
import {
  useSandboxDefaultsEnvironments,
  type SandboxDefaultsEnvironment,
} from "@/hooks/sandboxes/use-sandbox-defaults";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import type { EnvironmentPick } from "@/lib/settings-environment-pages";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";

const METHOD = "environment.configuration.items";

/** The item the Storage page writes. */
export const STORAGE_POLICY_KIND = "storage_policy";
export const STORAGE_POLICY_KEY = "storage";

/** An age window in whole units, or `null` for none. */
const ageWindowSchema = z.number().int().positive().nullable();

/**
 * The item's value as authn validates it (`items.ts`): the idle window in
 * days, the archived-chat window in hours. `artifacts` is retired: values
 * saved before its removal carry it, so it still parses, and it is dropped
 * here so a save never writes it back.
 */
export const storagePolicyValueSchema = z
  .strictObject({
    chats: z.boolean(),
    artifacts: z.boolean().optional(),
    idleTaskDays: ageWindowSchema,
    archivedChatHours: ageWindowSchema,
  })
  .transform(({ chats, idleTaskDays, archivedChatHours }) => ({
    chats,
    idleTaskDays,
    archivedChatHours,
  }));

export type StoragePolicyValue = z.infer<typeof storagePolicyValueSchema>;

/** What the hosts apply while no item is set. */
export const STORAGE_POLICY_DEFAULTS: StoragePolicyValue = {
  chats: true,
  idleTaskDays: null,
  archivedChatHours: 4,
};

/** The item the File edit snapshots row writes. */
export const SNAPSHOT_POLICY_KIND = "snapshot_policy";
export const SNAPSHOT_POLICY_KEY = "snapshots";

/**
 * The item's value as authn validates it (`items.ts`): a snapshot is removed
 * once every chat naming it has been quiet for `quietChatDays`; `null` never
 * removes one.
 */
export const snapshotPolicyValueSchema = z.strictObject({
  quietChatDays: z
    .union([z.literal(7), z.literal(30), z.literal(90)])
    .nullable(),
});

export type SnapshotPolicyValue = z.infer<typeof snapshotPolicyValueSchema>;

/** What the hosts apply while no item is set. */
export const SNAPSHOT_POLICY_DEFAULTS: SnapshotPolicyValue = {
  quietChatDays: 7,
};

/** One item as last read, with the revision a save quotes. */
export interface ConfigurationPolicyItem<V> {
  /**
   * What the configuration's hosts apply: the defaults when no item is set,
   * and nothing removed for a value the hosts cannot read, since they then
   * clean up nothing.
   */
  readonly value: V;
  /** `null` when there is no item yet: a save creates it. */
  readonly revision: number | null;
}

/** A configuration's storage items as last read. */
export interface ConfigurationStoragePolicy {
  readonly storage: ConfigurationPolicyItem<StoragePolicyValue>;
  readonly snapshots: ConfigurationPolicyItem<SnapshotPolicyValue>;
}

/** An unparsable item: a host reads it as nothing to clean. */
const NOTHING_CLEANABLE: StoragePolicyValue = {
  chats: false,
  idleTaskDays: null,
  archivedChatHours: null,
};

/** An unparsable item: a host removes no snapshot. */
const NO_SNAPSHOT_REMOVED: SnapshotPolicyValue = { quietChatDays: null };

/** Where an item is, how its value parses, and what it reads as without one. */
interface PolicyItemSpec<V> {
  readonly kind: string;
  readonly key: string;
  readonly schema: z.ZodType<V>;
  readonly defaults: V;
  /** What a value that does not parse reads as. */
  readonly unreadable: V;
}

function policyItemOf<V>(
  items: readonly ConfigurationItem[],
  spec: PolicyItemSpec<V>,
): ConfigurationPolicyItem<V> {
  const item = items.find(
    (row) => row.kind === spec.kind && row.key === spec.key,
  );
  if (item === undefined) return { value: spec.defaults, revision: null };
  const parsed = spec.schema.safeParse(item.value);
  return {
    value: parsed.success ? parsed.data : spec.unreadable,
    revision: item.revision,
  };
}

function storagePolicyOf(
  items: readonly ConfigurationItem[],
): ConfigurationStoragePolicy {
  return {
    storage: policyItemOf(items, {
      kind: STORAGE_POLICY_KIND,
      key: STORAGE_POLICY_KEY,
      schema: storagePolicyValueSchema,
      defaults: STORAGE_POLICY_DEFAULTS,
      unreadable: NOTHING_CLEANABLE,
    }),
    snapshots: policyItemOf(items, {
      kind: SNAPSHOT_POLICY_KIND,
      key: SNAPSHOT_POLICY_KEY,
      schema: snapshotPolicyValueSchema,
      defaults: SNAPSHOT_POLICY_DEFAULTS,
      unreadable: NO_SNAPSHOT_REMOVED,
    }),
  };
}

/**
 * The picked configuration's environment: Personal's, or the team's the pick
 * names. `null` while the account's list has not answered.
 */
function environmentOfPick(
  environments: ReadonlyMap<string, SandboxDefaultsEnvironment>,
  pick: Exclude<EnvironmentPick, { readonly kind: "local" }>,
): SandboxDefaultsEnvironment | null {
  if (pick.kind === "unresolved") return null;
  if (pick.kind === "personal") return environments.get("personal") ?? null;
  for (const environment of environments.values()) {
    if (environment.environmentId === pick.environmentId) return environment;
  }
  return null;
}

/**
 * The picked configuration's storage policy: its environment (`null` when
 * there is none, so there is nothing to set) and the read of its
 * `storage_policy` and `snapshot_policy` items, with the sandbox defaults' road
 * (`useConfigurationSandboxDefaults`): the environment from the account's
 * list, its items on the viewer's session.
 */
export function useConfigurationStoragePolicy(
  pick: Exclude<EnvironmentPick, { readonly kind: "local" }>,
): {
  readonly environment: SandboxDefaultsEnvironment | null;
  readonly read: UseQueryResult<ConfigurationStoragePolicy, HostRpcError>;
} {
  const environment = environmentOfPick(
    useSandboxDefaultsEnvironments(true),
    pick,
  );
  const client = usePoolTierHostClient(useHostClient());
  const viewerId = useCloudChatViewerId();
  const authorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  const read = useHostQueryWithResponseMap<
    HostRpcRegistry,
    typeof METHOD,
    ConfigurationStoragePolicy
  >({
    cacheKeyIdentity: [viewerId, STORAGE_POLICY_KIND],
    client,
    method: METHOD,
    params: { environmentId: environment?.environmentId ?? "" },
    preflight: cloudVerdictPreflight(METHOD),
    mapResponse: ({ response }) => storagePolicyOf(response.items),
    options: {
      enabled: environment !== null && viewerId.length > 0 && authorized,
    },
  });
  return { environment, read };
}
