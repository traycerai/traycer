/**
 * A configuration's settings read and written through the server pool, for a
 * team configuration as for Personal: the caller names the environment, and
 * the host forwards to that environment's authn routes on the caller's
 * session.
 *
 * `environment.configuration.items` / `.items.put` / `.items.delete` - the
 * item rows, compare-and-set per address on each row's own revision.
 * `environment.configuration.mcpServers.list` / `.put` / `.delete` - the
 * environment's MCP server declarations, a server with its credential.
 * `environment.configuration.skills.upload` / `.list` / `.remove` /
 * `.setProviders` / `.setPolicy` / `.update` / `.restoreBundled` / `.state` /
 * `.import` - the environment's skills, on the host that serves it.
 * `environment.configuration.policy.put` - the approval policy.
 * `environment.configuration.guide.get` / `.set` / `.reset` - the agent
 * selection guide. `environment.plans.list` / `.unlinkPreview` / `.unlink` -
 * the plans linked into a configuration.
 * `environment.history` - what happened to a configuration, or to one thing
 * in it.
 *
 * Every answer is value-free of secrets: the item routes serve no `secret`
 * row, a credential travels only in a request, and no answer carries one
 * back. Optional capabilities with `degrade: { kind: "unsupported" }`.
 */
import { z } from "zod";
import {
  defineRpcContract,
  defineUpgradePath,
} from "@traycer/protocol/framework/index";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import {
  environmentItemKindSchema,
  environmentOsSchema,
} from "@traycer/protocol/host/environment-schemas";
import { providerSkillInspectCandidateSchema } from "@traycer/protocol/host/provider-native-schemas";

const environmentIdSchema = lazySchema(() => z.string().min(1));
const itemKeySchema = lazySchema(() => z.string().min(1).max(3072));
const itemRevisionSchema = lazySchema(() => z.number().int().nonnegative());

/** The apply-plane position, independent of host delivery and item inventory. */
export const environmentConfigurationRevisionResponseSchema = lazySchema(() =>
  z.object({ revision: z.string().regex(/^(0|[1-9][0-9]{0,18})$/) }),
);
export type EnvironmentConfigurationRevisionResponse = z.infer<
  typeof environmentConfigurationRevisionResponseSchema
>;

export const environmentConfigurationRevisionV10 = defineRpcContract({
  method: "environment.configuration.revision",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: lazySchema(() =>
    z.object({ environmentId: environmentIdSchema }),
  ),
  responseSchema: environmentConfigurationRevisionResponseSchema,
});

// ── environment.configuration.items ─────────────────────────────────────────

export const environmentConfigurationItemsRequestSchema = lazySchema(() =>
  z.object({ environmentId: environmentIdSchema }),
);
export type EnvironmentConfigurationItemsRequest = z.infer<
  typeof environmentConfigurationItemsRequestSchema
>;

/** Known `writtenBy.source` values: live, offline, migration, undo. */
export const ENVIRONMENT_ITEM_WRITTEN_BY_SOURCES = [
  "live",
  "offline",
  "migration",
  "undo",
] as const;

/**
 * One item row as authn's items route answers it. `os` is null for a kind
 * with no per-OS rows; `revision` is the row's own, the one a write quotes;
 * `writtenBy` is who wrote it last (`live` with no host is the dashboard).
 */
export const environmentConfigurationItemSchema = lazySchema(() =>
  z.object({
    kind: environmentItemKindSchema,
    key: itemKeySchema,
    os: environmentOsSchema.nullable(),
    value: z.json(),
    revision: itemRevisionSchema,
    updatedAt: z.number().int().nonnegative(),
    writtenBy: z.object({
      source: z.string().min(1).max(32),
      hostId: z.string().min(1).nullable(),
      hostName: z.string().max(256).nullable(),
    }),
  }),
);
export type EnvironmentConfigurationItem = z.infer<
  typeof environmentConfigurationItemSchema
>;

export const environmentConfigurationItemsResponseSchema = lazySchema(() =>
  z.object({ items: z.array(environmentConfigurationItemSchema) }),
);
export type EnvironmentConfigurationItemsResponse = z.infer<
  typeof environmentConfigurationItemsResponseSchema
>;

export const environmentConfigurationItemsV10 = defineRpcContract({
  method: "environment.configuration.items",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentConfigurationItemsRequestSchema,
  responseSchema: environmentConfigurationItemsResponseSchema,
});

/**
 * `environment.configuration.items.put@1.0`: one row, against the revision
 * the editor read; `revision` null creates.
 */
export const environmentConfigurationItemPutRequestSchema = lazySchema(() =>
  z.object({
    environmentId: environmentIdSchema,
    kind: environmentItemKindSchema,
    key: itemKeySchema,
    os: environmentOsSchema.nullable(),
    value: z.json(),
    revision: itemRevisionSchema.nullable(),
  }),
);
export type EnvironmentConfigurationItemPutRequest = z.infer<
  typeof environmentConfigurationItemPutRequestSchema
>;

/** `environment.configuration.items.delete@1.0`: the same address and revision. */
export const environmentConfigurationItemDeleteRequestSchema = lazySchema(() =>
  z.object({
    environmentId: environmentIdSchema,
    kind: environmentItemKindSchema,
    key: itemKeySchema,
    os: environmentOsSchema.nullable(),
    revision: itemRevisionSchema.nullable(),
  }),
);
export type EnvironmentConfigurationItemDeleteRequest = z.infer<
  typeof environmentConfigurationItemDeleteRequestSchema
>;

/**
 * The answer to a put or a delete. `saved` with the address's new revision,
 * null for a delete authn answers with no revision; `conflict` when the row moved since the revision the editor read, with the
 * row as it stands and who changed it (`changedBy` a person's or a host's
 * name, null when there is none to show), or `current: null` when the row is
 * gone; `forbidden` for a reader who may not write this configuration.
 */
export const environmentConfigurationItemWriteResponseSchema = lazySchema(() =>
  z.discriminatedUnion("outcome", [
    z.object({
      outcome: z.literal("saved"),
      revision: itemRevisionSchema.nullable(),
    }),
    z.object({
      outcome: z.literal("conflict"),
      current: z
        .object({
          revision: itemRevisionSchema,
          changedBy: z.string().nullable(),
          changedAt: z.number().int().nonnegative(),
        })
        .nullable(),
    }),
    z.object({ outcome: z.literal("forbidden") }),
  ]),
);
export type EnvironmentConfigurationItemWriteResponse = z.infer<
  typeof environmentConfigurationItemWriteResponseSchema
>;

export const environmentConfigurationItemsPutV10 = defineRpcContract({
  method: "environment.configuration.items.put",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentConfigurationItemPutRequestSchema,
  responseSchema: environmentConfigurationItemWriteResponseSchema,
});

export const environmentConfigurationItemsDeleteV10 = defineRpcContract({
  method: "environment.configuration.items.delete",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentConfigurationItemDeleteRequestSchema,
  responseSchema: environmentConfigurationItemWriteResponseSchema,
});

// ── mcpServers.put / skills.upload / policy.put ─────────────────────────────

/**
 * The answer to an MCP server, skill or policy write: `saved`, `forbidden`
 * for a reader who may not write it, or `refused` by authn with its code in
 * `reason` (a stale policy version, a team-only policy, an invalid body).
 * `reason` is null unless `refused`.
 */
export const environmentConfigurationWriteResponseSchema = lazySchema(() =>
  z.object({
    outcome: z.enum(["saved", "forbidden", "refused"]),
    reason: z.string().min(1).max(64).nullable(),
  }),
);
export type EnvironmentConfigurationWriteResponse = z.infer<
  typeof environmentConfigurationWriteResponseSchema
>;

/**
 * An MCP server's credential on a write: `unchanged` keeps what the server
 * holds (a read never returns it), `none` removes it, `pat` and `headers` set
 * it; authn stores it as a broker secret. A `stdio` server carries `none` or
 * `unchanged`.
 */
export const environmentMcpServerCredentialSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("unchanged") }),
    z.object({ kind: z.literal("none") }),
    z.object({ kind: z.literal("pat"), pat: z.string().min(1).max(4096) }),
    z.object({
      kind: z.literal("headers"),
      headers: z.record(z.string().min(1).max(256), z.string().max(8192)),
    }),
  ]),
);
export type EnvironmentMcpServerCredential = z.infer<
  typeof environmentMcpServerCredentialSchema
>;

/**
 * `environment.configuration.mcpServers.put@1.0`: authn's `mcp-servers`
 * route body, the declaration plus its credential. `serverId` null creates;
 * otherwise the declaration replaces the named server's. An `http` server
 * names its `url`, a `stdio` server its `command`; `env` names the variables
 * it reads, never their values; `toolToggles` is per harness id, each tool's
 * on or off.
 */
export const environmentConfigurationMcpServerPutRequestSchema = lazySchema(
  () =>
    z.object({
      environmentId: environmentIdSchema,
      serverId: z.string().min(1).nullable(),
      name: z.string().min(1).max(128),
      transport: z.enum(["http", "stdio"]),
      url: z.string().min(1).max(2048).nullable(),
      command: z.string().min(1).max(1024).nullable(),
      args: z.array(z.string().max(4096)).max(64),
      env: z.array(z.string().min(1).max(128)).max(64),
      toolToggles: z.record(
        z.string().min(1).max(64),
        z.record(z.string().min(1).max(256), z.boolean()),
      ),
      credential: environmentMcpServerCredentialSchema,
    }),
);
export type EnvironmentConfigurationMcpServerPutRequest = z.infer<
  typeof environmentConfigurationMcpServerPutRequestSchema
>;

export const environmentConfigurationMcpServersPutV10 = defineRpcContract({
  method: "environment.configuration.mcpServers.put",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentConfigurationMcpServerPutRequestSchema,
  responseSchema: environmentConfigurationWriteResponseSchema,
});

/** authn's cap on one skill folder's archive, in bytes. */
export const ENVIRONMENT_SKILL_ARCHIVE_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Why a write to an environment skill was refused when its update policy
 * (`auto-update` or `frozen`) takes no edit: a skill upload's `reason`, and
 * the `detail` of a provider-native `edit`'s `unsupported_action` refusal
 * inside such a skill.
 */
export const ENVIRONMENT_SKILL_READ_ONLY_REASON = "read_only";

/**
 * `environment.configuration.skills.upload@1.0`: authn's `skill-content`
 * route body, a skill folder as a gzipped tar in standard base64, and the
 * skill's name. The host uploads the archive and writes the `skill` item that
 * names it.
 */
export const environmentConfigurationSkillUploadRequestSchema = lazySchema(() =>
  z.object({
    environmentId: environmentIdSchema,
    name: z.string().min(1).max(128),
    archive: z
      .base64()
      .max(Math.ceil(ENVIRONMENT_SKILL_ARCHIVE_MAX_BYTES / 3) * 4),
  }),
);
export type EnvironmentConfigurationSkillUploadRequest = z.infer<
  typeof environmentConfigurationSkillUploadRequestSchema
>;

/**
 * A skill upload's answer: the write answer, plus `not_served` when the asked
 * host does not serve that environment's room (the client asks one that does).
 * A refusal's `reason` is `invalid_name`, `not_ready`, `too_large`,
 * `invalid_archive`, or {@link ENVIRONMENT_SKILL_READ_ONLY_REASON} for an
 * upload over a skill whose policy takes no edit.
 */
export const environmentConfigurationSkillUploadResponseSchema = lazySchema(
  () =>
    z.object({
      outcome: z.enum(["saved", "forbidden", "refused", "not_served"]),
      reason: z.string().min(1).max(64).nullable(),
    }),
);
export type EnvironmentConfigurationSkillUploadResponse = z.infer<
  typeof environmentConfigurationSkillUploadResponseSchema
>;

export const environmentConfigurationSkillsUploadV10 = defineRpcContract({
  method: "environment.configuration.skills.upload",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentConfigurationSkillUploadRequestSchema,
  responseSchema: environmentConfigurationSkillUploadResponseSchema,
});

// ── mcpServers.list / put@1.1 / delete ──────────────────────────────────────

/**
 * Known `reason` codes of a refused MCP server write, beside authn's own:
 * `name_taken` (another server of the environment has this name),
 * `stdio_credential` (a `stdio` server carries a credential other than
 * `none` or `unchanged`: the broker cannot bind one), `secret_not_bindable`
 * (a picked secret is of another environment, not brokered, not live, has no
 * header swap, is another server's own credential, or is not sent to the
 * server's address), `secret_destination_mismatch` (an edit moves the url off
 * the picked secret's address without a new credential).
 */
export const ENVIRONMENT_MCP_SERVER_REFUSAL_REASONS = [
  "name_taken",
  "stdio_credential",
  "secret_not_bindable",
  "secret_destination_mismatch",
] as const;

/**
 * A server's credential, never its value: `secret` names the broker secret
 * holding it (both null while authn still holds it in the row; custom
 * headers win over a PAT, as the applier reads them), `oauth` a sign-in the
 * row keeps sealed. `owned` is a secret added with this server, deleted with
 * it; a picked one is only unbound and stays on Secrets.
 */
export const environmentMcpServerCredentialStateSchema = lazySchema(() =>
  z.object({
    kind: z.enum(["none", "secret", "oauth"]),
    secretId: z.string().min(1).nullable(),
    secretName: z.string().min(1).nullable(),
    owned: z.boolean(),
  }),
);

/**
 * The server's `mcp_server` item: the row hosts apply. `offFor` holds the
 * harness ids the server is switched off for, `toolToggles` each harness's
 * tools.
 */
export const environmentMcpServerItemStateSchema = lazySchema(() =>
  z.object({
    key: itemKeySchema,
    revision: itemRevisionSchema,
    toolToggles: z.record(z.string(), z.record(z.string(), z.boolean())),
    offFor: z.array(z.string().min(1).max(64)),
  }),
);

/**
 * One server as the environment holds it: authn's declaration and its item.
 * `item` null is a server with no `mcp_server` item, which reaches no host.
 */
export const environmentMcpServerDeclarationSchema = lazySchema(() =>
  z.object({
    serverId: z.string().min(1),
    name: z.string().min(1).max(128),
    transport: z.enum(["http", "stdio"]),
    url: z.string().nullable(),
    command: z.string().nullable(),
    args: z.array(z.string()),
    env: z.array(z.string()),
    credential: environmentMcpServerCredentialStateSchema,
    item: environmentMcpServerItemStateSchema.nullable(),
  }),
);
export type EnvironmentMcpServerDeclaration = z.infer<
  typeof environmentMcpServerDeclarationSchema
>;

/** `environment.configuration.mcpServers.list@1.0`: the environment's servers, oldest first. */
export const environmentConfigurationMcpServersListRequestSchema = lazySchema(
  () => z.object({ environmentId: environmentIdSchema }),
);
export const environmentConfigurationMcpServersListResponseSchema = lazySchema(
  () => z.object({ servers: z.array(environmentMcpServerDeclarationSchema) }),
);
export type EnvironmentConfigurationMcpServersListResponse = z.infer<
  typeof environmentConfigurationMcpServersListResponseSchema
>;

export const environmentConfigurationMcpServersListV10 = defineRpcContract({
  method: "environment.configuration.mcpServers.list",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentConfigurationMcpServersListRequestSchema,
  responseSchema: environmentConfigurationMcpServersListResponseSchema,
});

/**
 * An MCP server's credential on a `put@1.1`: the 1.0 kinds, plus `secret`,
 * an existing broker secret of the environment bound as the server's PAT
 * without a copy.
 */
export const environmentMcpServerCredentialSchemaV11 = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("unchanged") }),
    z.object({ kind: z.literal("none") }),
    z.object({ kind: z.literal("pat"), pat: z.string().min(1).max(4096) }),
    z.object({
      kind: z.literal("headers"),
      headers: z.record(z.string().min(1).max(256), z.string().max(8192)),
    }),
    z.object({ kind: z.literal("secret"), secretId: z.string().min(1) }),
  ]),
);
export type EnvironmentMcpServerCredentialV11 = z.infer<
  typeof environmentMcpServerCredentialSchemaV11
>;

/**
 * `environment.configuration.mcpServers.put@1.1`: the 1.0 body with the
 * `secret` credential and `offFor`, the harness ids the server is off for
 * (`[]`: every provider). The host keeps the server's `mcp_server` item with
 * it: a create puts one under the server's name (a name already taken
 * refuses the create, `name_taken`, and leaves no server behind), an update
 * of a server with an item puts the new toggles and `offFor` at the item's
 * revision, a rename moves the item to the new name. An update of a server
 * with no item (switched off by `setEnabled`) updates the server only: it
 * writes no item, so the server stays off with the tool toggles it kept, and
 * the request's `toolToggles` and `offFor` are ignored.
 */
export const environmentConfigurationMcpServerPutRequestSchemaV11 = lazySchema(
  () =>
    z.object({
      environmentId: environmentIdSchema,
      serverId: z.string().min(1).nullable(),
      name: z.string().min(1).max(128),
      transport: z.enum(["http", "stdio"]),
      url: z.string().min(1).max(2048).nullable(),
      command: z.string().min(1).max(1024).nullable(),
      args: z.array(z.string().max(4096)).max(64),
      env: z.array(z.string().min(1).max(128)).max(64),
      toolToggles: z.record(
        z.string().min(1).max(64),
        z.record(z.string().min(1).max(256), z.boolean()),
      ),
      offFor: z.array(z.string().min(1).max(64)).max(64),
      credential: environmentMcpServerCredentialSchemaV11,
    }),
);
export type EnvironmentConfigurationMcpServerPutRequestV11 = z.infer<
  typeof environmentConfigurationMcpServerPutRequestSchemaV11
>;

/** A put@1.1 answer: the write answer and the server's id once `saved`. */
export const environmentConfigurationMcpServerPutResponseSchemaV11 = lazySchema(
  () =>
    z.object({
      outcome: z.enum(["saved", "forbidden", "refused"]),
      reason: z.string().min(1).max(64).nullable(),
      serverId: z.string().min(1).nullable(),
    }),
);
export type EnvironmentConfigurationMcpServerPutResponseV11 = z.infer<
  typeof environmentConfigurationMcpServerPutResponseSchemaV11
>;

export const environmentConfigurationMcpServersPutV11 = defineRpcContract({
  method: "environment.configuration.mcpServers.put",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: environmentConfigurationMcpServerPutRequestSchemaV11,
  responseSchema: environmentConfigurationMcpServerPutResponseSchemaV11,
});

/**
 * A 1.0 request is every provider's (`offFor: []`); a 1.0 host names no id
 * and writes no item, and a request sent to one never carries `secret`.
 */
export const environmentConfigurationMcpServersPutUpgradeV10ToV11 =
  defineUpgradePath<
    typeof environmentConfigurationMcpServersPutV10,
    typeof environmentConfigurationMcpServersPutV11
  >({
    from: environmentConfigurationMcpServersPutV10.schemaVersion,
    to: environmentConfigurationMcpServersPutV11.schemaVersion,
    upgradeRequest: (request) => ({ ...request, offFor: [] }),
    upgradeResponse: (response) => ({ ...response, serverId: null }),
  });

/**
 * `environment.configuration.mcpServers.delete@1.0`: removes the server's
 * `mcp_server` item (so every host takes it out of its providers), then the
 * server and its credential.
 */
export const environmentConfigurationMcpServerDeleteRequestSchema = lazySchema(
  () =>
    z.object({
      environmentId: environmentIdSchema,
      serverId: z.string().min(1),
    }),
);

export const environmentConfigurationMcpServersDeleteV10 = defineRpcContract({
  method: "environment.configuration.mcpServers.delete",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentConfigurationMcpServerDeleteRequestSchema,
  responseSchema: environmentConfigurationWriteResponseSchema,
});

/**
 * `environment.configuration.mcpServers.setEnabled@1.0`: switches a server on
 * or off for every host. Off keeps its tool toggles on the server and takes
 * its `mcp_server` item away; on puts the item back with them, on for every
 * provider.
 */
export const environmentConfigurationMcpServerSetEnabledRequestSchema =
  lazySchema(() =>
    z.object({
      environmentId: environmentIdSchema,
      serverId: z.string().min(1),
      enabled: z.boolean(),
    }),
  );

export const environmentConfigurationMcpServersSetEnabledV10 =
  defineRpcContract({
    method: "environment.configuration.mcpServers.setEnabled",
    schemaVersion: { major: 1, minor: 0 } as const,
    requestSchema: environmentConfigurationMcpServerSetEnabledRequestSchema,
    responseSchema: environmentConfigurationWriteResponseSchema,
  });

// ── skills.list / remove / setProviders ─────────────────────────────────────

/** Why a served skill write was refused. */
const environmentSkillRefusalSchema = lazySchema(() =>
  z.enum(["not_ready", "not_found", "invalid_name"]).nullable(),
);

/**
 * One skill in the environment's skills: its folder name, its description,
 * where it came from (`bundled`: Traycer seeded it; `room`: written or added
 * in Settings), whether a person changed a bundled one, and the provider ids
 * (the Providers rail's) it is switched off for. The `@1.0` row, frozen when
 * `@1.1` opened.
 */
export const environmentSkillSchema = lazySchema(() =>
  z.object({
    name: z.string().min(1).max(128),
    description: z.string().nullable(),
    origin: z.enum(["bundled", "room"]),
    edited: z.boolean(),
    offFor: z.array(z.string().min(1).max(64)),
  }),
);
export type EnvironmentSkill = z.infer<typeof environmentSkillSchema>;

/**
 * `environment.configuration.skills.list@1.0`: the skills of the environment
 * the asked host serves, with the revision of the switches (null while none
 * was written), or `not_served` with none on any other host.
 */
export const environmentConfigurationSkillsListRequestSchema = lazySchema(() =>
  z.object({ environmentId: environmentIdSchema }),
);
export const environmentConfigurationSkillsListResponseSchema = lazySchema(() =>
  z.discriminatedUnion("outcome", [
    z.object({
      outcome: z.literal("listed"),
      revision: z.string().min(1).nullable(),
      skills: z.array(environmentSkillSchema),
    }),
    z.object({ outcome: z.literal("not_served") }),
  ]),
);
export type EnvironmentConfigurationSkillsListResponse = z.infer<
  typeof environmentConfigurationSkillsListResponseSchema
>;

export const environmentConfigurationSkillsListV10 = defineRpcContract({
  method: "environment.configuration.skills.list",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentConfigurationSkillsListRequestSchema,
  responseSchema: environmentConfigurationSkillsListResponseSchema,
});

/** `environment.configuration.skills.remove@1.0`: one skill out of the environment, on its serving host. */
export const environmentConfigurationSkillRemoveRequestSchema = lazySchema(() =>
  z.object({
    environmentId: environmentIdSchema,
    name: z.string().min(1).max(128),
  }),
);
export const environmentConfigurationSkillRemoveResponseSchema = lazySchema(
  () =>
    z.object({
      outcome: z.enum(["removed", "not_served", "forbidden", "refused"]),
      reason: environmentSkillRefusalSchema,
    }),
);
export type EnvironmentConfigurationSkillRemoveResponse = z.infer<
  typeof environmentConfigurationSkillRemoveResponseSchema
>;

export const environmentConfigurationSkillsRemoveV10 = defineRpcContract({
  method: "environment.configuration.skills.remove",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentConfigurationSkillRemoveRequestSchema,
  responseSchema: environmentConfigurationSkillRemoveResponseSchema,
});

/**
 * `environment.configuration.skills.setProviders@1.0`: the provider ids one
 * skill is switched off for, replacing the list, against the switches'
 * revision the editor read (null: none written yet), on its serving host.
 * `stale` answers the current revision: the editor lists again.
 */
export const environmentConfigurationSkillSetProvidersRequestSchema =
  lazySchema(() =>
    z.object({
      environmentId: environmentIdSchema,
      name: z.string().min(1).max(128),
      offFor: z.array(z.string().min(1).max(64)).max(64),
      revision: z.string().min(1).nullable(),
    }),
  );
export const environmentConfigurationSkillSetProvidersResponseSchema =
  lazySchema(() =>
    z.object({
      outcome: z.enum(["saved", "stale", "not_served", "forbidden", "refused"]),
      revision: z.string().min(1).nullable(),
      reason: environmentSkillRefusalSchema,
    }),
  );
export type EnvironmentConfigurationSkillSetProvidersResponse = z.infer<
  typeof environmentConfigurationSkillSetProvidersResponseSchema
>;

export const environmentConfigurationSkillsSetProvidersV10 = defineRpcContract({
  method: "environment.configuration.skills.setProviders",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentConfigurationSkillSetProvidersRequestSchema,
  responseSchema: environmentConfigurationSkillSetProvidersResponseSchema,
});

// ── skills.list@1.1 / setPolicy / update / restoreBundled ───────────────────

/**
 * A skill's update policy: `auto-update` follows upstream and takes no local
 * edit, `evolve` takes edits and leaves upstream to a manual update, `frozen`
 * takes neither.
 */
export const ENVIRONMENT_SKILL_POLICIES = [
  "auto-update",
  "evolve",
  "frozen",
] as const;

export const environmentSkillPolicySchema = lazySchema(() =>
  z.enum(ENVIRONMENT_SKILL_POLICIES),
);
export type EnvironmentSkillPolicy = z.infer<
  typeof environmentSkillPolicySchema
>;

/**
 * One skill on `skills.list@1.1`: the `@1.0` row, plus the policy in force
 * (for a skill with nothing to follow, neither bundled nor installed from a
 * source, `auto-update` or no entry reads as `evolve`, while `evolve` and
 * `frozen` hold as written), its version (the build for a bundled skill, the
 * installed commit for one from a source, `null` otherwise), whether a newer
 * upstream is there that the policy holds back, and where a skill from a
 * source came from.
 */
export const environmentSkillSchemaV11 = lazySchema(() =>
  z.object({
    name: z.string().min(1).max(128),
    description: z.string().nullable(),
    origin: z.enum(["bundled", "room"]),
    edited: z.boolean(),
    offFor: z.array(z.string().min(1).max(64)),
    policy: environmentSkillPolicySchema,
    version: z.string().min(1).max(256).nullable(),
    updateAvailable: z.boolean(),
    upstream: z
      .object({
        source: z.string().min(1).max(2048),
        ref: z.string().min(1).max(256),
      })
      .nullable(),
  }),
);
export type EnvironmentSkillV11 = z.infer<typeof environmentSkillSchemaV11>;

/**
 * `environment.configuration.skills.list@1.1`: the `@1.0` answer with each
 * skill's policy and version, the policies' revision (null while none was
 * written), which `setPolicy` quotes, and the bundled skills a person
 * removed, which `restoreBundled` seeds again.
 */
export const environmentConfigurationSkillsListResponseSchemaV11 = lazySchema(
  () =>
    z.discriminatedUnion("outcome", [
      z.object({
        outcome: z.literal("listed"),
        revision: z.string().min(1).nullable(),
        policyRevision: z.string().min(1).nullable(),
        skills: z.array(environmentSkillSchemaV11),
        deletedBundled: z.array(z.string().min(1).max(128)),
      }),
      z.object({ outcome: z.literal("not_served") }),
    ]),
);
export type EnvironmentConfigurationSkillsListResponseV11 = z.infer<
  typeof environmentConfigurationSkillsListResponseSchemaV11
>;

export const environmentConfigurationSkillsListV11 = defineRpcContract({
  method: "environment.configuration.skills.list",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: environmentConfigurationSkillsListRequestSchema,
  responseSchema: environmentConfigurationSkillsListResponseSchemaV11,
});

/**
 * A `@1.0` answer from a tier that predates the policies, as it behaves: a
 * bundled skill nobody changed takes each build (`auto-update`), an edited
 * one and the configuration's own are kept as they are (`evolve`). It names
 * no version, update, source or removal.
 */
export const environmentConfigurationSkillsListUpgradeV10ToV11 =
  defineUpgradePath<
    typeof environmentConfigurationSkillsListV10,
    typeof environmentConfigurationSkillsListV11
  >({
    from: environmentConfigurationSkillsListV10.schemaVersion,
    to: environmentConfigurationSkillsListV11.schemaVersion,
    upgradeRequest: (request) => request,
    upgradeResponse: (response) =>
      response.outcome === "not_served"
        ? response
        : {
            outcome: "listed",
            revision: response.revision,
            policyRevision: null,
            skills: response.skills.map((skill) => ({
              ...skill,
              policy:
                skill.origin === "bundled" && !skill.edited
                  ? "auto-update"
                  : "evolve",
              version: null,
              updateAvailable: false,
              upstream: null,
            })),
            deletedBundled: [],
          },
  });

/**
 * `environment.configuration.skills.setPolicy@1.0`: one skill's update
 * policy, against the policies' revision the editor read (null: none written
 * yet), on its serving tier. Freezing pins the skill at its files as they
 * are. `stale` answers the current revision: the editor lists again.
 * `not_ready` while the configuration takes no write yet or holds no
 * policies yet; `policies_unreadable` while the policies it holds cannot be
 * read, which no retry clears.
 */
export const environmentConfigurationSkillSetPolicyRequestSchema = lazySchema(
  () =>
    z.object({
      environmentId: environmentIdSchema,
      name: z.string().min(1).max(128),
      policy: environmentSkillPolicySchema,
      revision: z.string().min(1).nullable(),
    }),
);
export type EnvironmentConfigurationSkillSetPolicyRequest = z.infer<
  typeof environmentConfigurationSkillSetPolicyRequestSchema
>;

export const environmentConfigurationSkillSetPolicyResponseSchema = lazySchema(
  () =>
    z.object({
      outcome: z.enum(["saved", "stale", "not_served", "forbidden", "refused"]),
      revision: z.string().min(1).nullable(),
      reason: z
        .enum(["not_ready", "not_found", "invalid_name", "policies_unreadable"])
        .nullable(),
    }),
);
export type EnvironmentConfigurationSkillSetPolicyResponse = z.infer<
  typeof environmentConfigurationSkillSetPolicyResponseSchema
>;

export const environmentConfigurationSkillsSetPolicyV10 = defineRpcContract({
  method: "environment.configuration.skills.setPolicy",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentConfigurationSkillSetPolicyRequestSchema,
  responseSchema: environmentConfigurationSkillSetPolicyResponseSchema,
});

/**
 * `environment.configuration.skills.update@1.0`: one skill replaced by its
 * upstream's current version, on the host that serves the environment.
 * Under `evolve` a skill with local changes needs `confirm`, else it is
 * refused `has_edits`; under `frozen` the skill is pinned again at that
 * version; under `auto-update` the skill already follows it. `applied` once
 * the skill holds it, `nothing_to_apply` when it already does or nothing
 * newer can be applied here, `stale` when the skill or the policies changed
 * under the update (the editor lists again). `no_upstream`: the skill has no
 * source this host can update it from. `fetch_failed`: its source could not
 * be reached or no longer holds it.
 */
export const environmentConfigurationSkillUpdateRequestSchema = lazySchema(() =>
  z.object({
    environmentId: environmentIdSchema,
    name: z.string().min(1).max(128),
    confirm: z.boolean(),
  }),
);
export type EnvironmentConfigurationSkillUpdateRequest = z.infer<
  typeof environmentConfigurationSkillUpdateRequestSchema
>;

export const environmentConfigurationSkillUpdateResponseSchema = lazySchema(
  () =>
    z.object({
      outcome: z.enum([
        "applied",
        "nothing_to_apply",
        "stale",
        "not_served",
        "forbidden",
        "refused",
      ]),
      reason: z
        .enum([
          "not_ready",
          "not_found",
          "invalid_name",
          "has_edits",
          "no_upstream",
          "fetch_failed",
        ])
        .nullable(),
    }),
);
export type EnvironmentConfigurationSkillUpdateResponse = z.infer<
  typeof environmentConfigurationSkillUpdateResponseSchema
>;

export const environmentConfigurationSkillsUpdateV10 = defineRpcContract({
  method: "environment.configuration.skills.update",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentConfigurationSkillUpdateRequestSchema,
  responseSchema: environmentConfigurationSkillUpdateResponseSchema,
});

/**
 * `environment.configuration.skills.restoreBundled@1.0`: a bundled skill a
 * person removed, seeded again at this build's version under `auto-update`,
 * on the host that serves the environment. `not_found` for a name this build
 * ships no skill of, `not_deleted` for one still there; `stale` when the
 * room changed under the restore.
 */
export const environmentConfigurationSkillRestoreBundledRequestSchema =
  lazySchema(() =>
    z.object({
      environmentId: environmentIdSchema,
      name: z.string().min(1).max(128),
    }),
  );

export const environmentConfigurationSkillRestoreBundledResponseSchema =
  lazySchema(() =>
    z.object({
      outcome: z.enum([
        "restored",
        "stale",
        "not_served",
        "forbidden",
        "refused",
      ]),
      reason: z
        .enum(["not_ready", "not_found", "invalid_name", "not_deleted"])
        .nullable(),
    }),
  );
export type EnvironmentConfigurationSkillRestoreBundledResponse = z.infer<
  typeof environmentConfigurationSkillRestoreBundledResponseSchema
>;

export const environmentConfigurationSkillsRestoreBundledV10 =
  defineRpcContract({
    method: "environment.configuration.skills.restoreBundled",
    schemaVersion: { major: 1, minor: 0 } as const,
    requestSchema: environmentConfigurationSkillRestoreBundledRequestSchema,
    responseSchema: environmentConfigurationSkillRestoreBundledResponseSchema,
  });

// ── skills.state / import ────────────────────────────────────────────────────

/**
 * `environment.configuration.skills.state@1.0`: what the host that serves
 * the environment knows of its skills and the server pool cannot: each
 * skill's version and whether a newer upstream is there that its policy
 * holds back, and the built-ins a person removed that this host can restore.
 * `refresh` checks every skill's source first, rather than answering what
 * the last check found; only a caller who may edit the environment asks
 * for one (`forbidden` otherwise). `not_served` on any other host.
 */
export const environmentConfigurationSkillsStateRequestSchema = lazySchema(() =>
  z.object({
    environmentId: environmentIdSchema,
    refresh: z.boolean(),
  }),
);
export type EnvironmentConfigurationSkillsStateRequest = z.infer<
  typeof environmentConfigurationSkillsStateRequestSchema
>;

export const environmentSkillServedStateSchema = lazySchema(() =>
  z.object({
    name: z.string().min(1).max(128),
    version: z.string().min(1).max(256).nullable(),
    updateAvailable: z.boolean(),
  }),
);
export type EnvironmentSkillServedState = z.infer<
  typeof environmentSkillServedStateSchema
>;

export const environmentConfigurationSkillsStateResponseSchema = lazySchema(
  () =>
    z.discriminatedUnion("outcome", [
      z.object({
        outcome: z.literal("listed"),
        skills: z.array(environmentSkillServedStateSchema),
        deletedBundled: z.array(z.string().min(1).max(128)),
      }),
      z.object({ outcome: z.literal("not_served") }),
      z.object({ outcome: z.literal("forbidden") }),
    ]),
);
export type EnvironmentConfigurationSkillsStateResponse = z.infer<
  typeof environmentConfigurationSkillsStateResponseSchema
>;

export const environmentConfigurationSkillsStateV10 = defineRpcContract({
  method: "environment.configuration.skills.state",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentConfigurationSkillsStateRequestSchema,
  responseSchema: environmentConfigurationSkillsStateResponseSchema,
});

/** The most skills one import installs. */
export const ENVIRONMENT_SKILL_IMPORT_MAX_SKILLS = 64;

/**
 * `environment.configuration.skills.import@1.0`: skills from a public source
 * installed into the environment, on the host that serves it, in two steps.
 * `inspect` reads the source (GitHub's `owner/repo`, or an `https` URL of a
 * repository or a tree in it, with no credentials) and
 * answers each skill it holds at the commit it resolved, with a token bound
 * to that commit; `install` writes the chosen ones (by name) into the
 * environment's skills, each following its source (`auto-update`), together
 * or not at all.
 */
/**
 * The inspect token the `inspected` answer hands out and the `install` step
 * hands back: one schema on both ends, so a token the host issues always
 * round-trips.
 */
const environmentSkillImportTokenSchema = z.string().min(1).max(128);

export const environmentConfigurationSkillImportRequestSchema = lazySchema(() =>
  z.discriminatedUnion("step", [
    z.object({
      step: z.literal("inspect"),
      environmentId: environmentIdSchema,
      source: z.string().min(1).max(2048),
    }),
    z.object({
      step: z.literal("install"),
      environmentId: environmentIdSchema,
      token: environmentSkillImportTokenSchema,
      names: z
        .array(z.string().min(1).max(128))
        .min(1)
        .max(ENVIRONMENT_SKILL_IMPORT_MAX_SKILLS),
    }),
  ]),
);
export type EnvironmentConfigurationSkillImportRequest = z.infer<
  typeof environmentConfigurationSkillImportRequestSchema
>;

/**
 * Why an import was refused:
 * - `not_ready`: the configuration takes no write yet;
 * - `invalid_source`: not a public `https` source (another transport, a
 *   local path, credentials in the URL), or one holding two skills of one
 *   name;
 * - `fetch_failed`: the source could not be reached or read;
 * - `expired`: the token is unknown or its source moved since: inspect again;
 * - `not_found`: a chosen name is not one the source holds;
 * - `invalid_name`: a chosen skill's name is not one a skill may have;
 * - `exists`: the environment holds a skill of a chosen name: remove it first;
 * - `bundled_name`: a chosen name is a built-in skill's;
 * - `too_large`: the chosen skills are over the upload cap
 *   ({@link ENVIRONMENT_SKILL_ARCHIVE_MAX_BYTES}).
 */
export const ENVIRONMENT_SKILL_IMPORT_REFUSAL_REASONS = [
  "not_ready",
  "invalid_source",
  "fetch_failed",
  "expired",
  "not_found",
  "invalid_name",
  "exists",
  "bundled_name",
  "too_large",
] as const;
export type EnvironmentSkillImportRefusalReason =
  (typeof ENVIRONMENT_SKILL_IMPORT_REFUSAL_REASONS)[number];

/**
 * An import's answer: `inspected` with the token and the source's skills
 * (`installed`: the environment holds one of that name), `installed` with
 * the names written, `stale` when the environment changed under the install
 * (inspect is still good: install again). A refusal of a name names it.
 */
export const environmentConfigurationSkillImportResponseSchema = lazySchema(
  () =>
    z.discriminatedUnion("outcome", [
      z.object({
        outcome: z.literal("inspected"),
        token: environmentSkillImportTokenSchema,
        commitSha: z.string().regex(/^[0-9a-f]{40}$/),
        candidates: z.array(providerSkillInspectCandidateSchema),
      }),
      z.object({
        outcome: z.literal("installed"),
        names: z.array(z.string().min(1).max(128)),
      }),
      z.object({
        outcome: z.literal("refused"),
        reason: z.enum(ENVIRONMENT_SKILL_IMPORT_REFUSAL_REASONS),
        name: z.string().min(1).max(128).nullable(),
      }),
      z.object({ outcome: z.literal("stale") }),
      z.object({ outcome: z.literal("not_served") }),
      z.object({ outcome: z.literal("forbidden") }),
    ]),
);
export type EnvironmentConfigurationSkillImportResponse = z.infer<
  typeof environmentConfigurationSkillImportResponseSchema
>;

export const environmentConfigurationSkillsImportV10 = defineRpcContract({
  method: "environment.configuration.skills.import",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentConfigurationSkillImportRequestSchema,
  responseSchema: environmentConfigurationSkillImportResponseSchema,
});

/** authn's cap on a team policy document, in bytes. */
export const ENVIRONMENT_POLICY_MAX_BYTES = 64 * 1024;

/**
 * `environment.configuration.policy.put@1.0`: authn's `policy` route body, the
 * policy document against the version the editor read (a decimal revision),
 * null to write the first one.
 */
export const environmentConfigurationPolicyPutRequestSchema = lazySchema(() =>
  z.object({
    environmentId: environmentIdSchema,
    body: z.string().max(ENVIRONMENT_POLICY_MAX_BYTES),
    policyVersion: z
      .string()
      .regex(/^(0|[1-9][0-9]{0,18})$/)
      .nullable(),
  }),
);
export type EnvironmentConfigurationPolicyPutRequest = z.infer<
  typeof environmentConfigurationPolicyPutRequestSchema
>;

export const environmentConfigurationPolicyPutV10 = defineRpcContract({
  method: "environment.configuration.policy.put",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentConfigurationPolicyPutRequestSchema,
  responseSchema: environmentConfigurationWriteResponseSchema,
});

// ── environment.plans.* ─────────────────────────────────────────────────────

/**
 * One plan linked into a configuration: the profile it signs in, the harness
 * it is for, its state, and who linked it (`you` when the reader did), null
 * when nobody is on record. Never a token.
 */
export const environmentPlanSchema = lazySchema(() =>
  z.object({
    profileId: z.string().min(1),
    harness: z.string().min(1).max(64),
    status: z.enum(["linked", "pending", "expired", "empty"]),
    linkedBy: z.object({ name: z.string(), you: z.boolean() }).nullable(),
  }),
);
export type EnvironmentPlan = z.infer<typeof environmentPlanSchema>;

export const environmentPlansListRequestSchema = lazySchema(() =>
  z.object({ environmentId: environmentIdSchema }),
);
export type EnvironmentPlansListRequest = z.infer<
  typeof environmentPlansListRequestSchema
>;

export const environmentPlansListResponseSchema = lazySchema(() =>
  z.object({ plans: z.array(environmentPlanSchema) }),
);
export type EnvironmentPlansListResponse = z.infer<
  typeof environmentPlansListResponseSchema
>;

export const environmentPlansListV10 = defineRpcContract({
  method: "environment.plans.list",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentPlansListRequestSchema,
  responseSchema: environmentPlansListResponseSchema,
});

const environmentPlanTargetRequestSchema = lazySchema(() =>
  z.object({
    environmentId: environmentIdSchema,
    profileId: z.string().min(1),
  }),
);

/**
 * `environment.plans.unlinkPreview@1.0`: what unlinking a plan stops, for the
 * confirm: the turns running on it on `localHostId`, the serving host (both
 * null when it holds no facts for that configuration), and the names of what
 * keeps working without it.
 */
export const environmentPlansUnlinkPreviewRequestSchema =
  environmentPlanTargetRequestSchema;
export type EnvironmentPlansUnlinkPreviewRequest = z.infer<
  typeof environmentPlansUnlinkPreviewRequestSchema
>;

export const environmentPlansUnlinkPreviewResponseSchema = lazySchema(() =>
  z.object({
    activeTurns: z.number().int().nonnegative().nullable(),
    localHostId: z.string().min(1).nullable(),
    keepsWorking: z.array(z.string()),
  }),
);
export type EnvironmentPlansUnlinkPreviewResponse = z.infer<
  typeof environmentPlansUnlinkPreviewResponseSchema
>;

export const environmentPlansUnlinkPreviewV10 = defineRpcContract({
  method: "environment.plans.unlinkPreview",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentPlansUnlinkPreviewRequestSchema,
  responseSchema: environmentPlansUnlinkPreviewResponseSchema,
});

/** `environment.plans.unlink@1.0`: `not_linked` is a profile with no plan. */
export const environmentPlansUnlinkRequestSchema =
  environmentPlanTargetRequestSchema;
export type EnvironmentPlansUnlinkRequest = z.infer<
  typeof environmentPlansUnlinkRequestSchema
>;

export const environmentPlansUnlinkResponseSchema = lazySchema(() =>
  z.object({ outcome: z.enum(["unlinked", "forbidden", "not_linked"]) }),
);
export type EnvironmentPlansUnlinkResponse = z.infer<
  typeof environmentPlansUnlinkResponseSchema
>;

export const environmentPlansUnlinkV10 = defineRpcContract({
  method: "environment.plans.unlink",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentPlansUnlinkRequestSchema,
  responseSchema: environmentPlansUnlinkResponseSchema,
});

// ── environment.configuration.guide.* ───────────────────────────────────────

/**
 * A team's agent selection guide, held in its configuration's room.
 * `revision` is the room's opaque version of the text, quoted back by a set.
 */
export const environmentConfigurationGuideGetRequestSchema = lazySchema(() =>
  z.object({ environmentId: environmentIdSchema }),
);
export type EnvironmentConfigurationGuideGetRequest = z.infer<
  typeof environmentConfigurationGuideGetRequestSchema
>;

/**
 * `not_served` on every guide method: the asked host does not serve that
 * environment's room, so the client asks a host that does.
 */
export const environmentConfigurationGuideGetResponseSchema = lazySchema(() =>
  z.discriminatedUnion("outcome", [
    z.object({
      outcome: z.literal("ok"),
      text: z.string(),
      revision: z.string().min(1),
    }),
    z.object({ outcome: z.literal("not_served") }),
  ]),
);
export type EnvironmentConfigurationGuideGetResponse = z.infer<
  typeof environmentConfigurationGuideGetResponseSchema
>;

export const environmentConfigurationGuideGetV10 = defineRpcContract({
  method: "environment.configuration.guide.get",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentConfigurationGuideGetRequestSchema,
  responseSchema: environmentConfigurationGuideGetResponseSchema,
});

/**
 * `environment.configuration.guide.get@1.1`: `unset` when the configuration's
 * room holds no guide yet. Agents get the generated default until a host
 * writes it or someone saves one; `revision` is the empty text's, so a `set`
 * quoting it writes the first guide. A `@1.0` caller is answered
 * `not_served` instead, so it asks a host as before (the minor is
 * projection-gated in the registry).
 */
export const environmentConfigurationGuideGetResponseSchemaV11 = lazySchema(
  () =>
    z.discriminatedUnion("outcome", [
      z.object({
        outcome: z.literal("ok"),
        text: z.string(),
        revision: z.string().min(1),
      }),
      z.object({ outcome: z.literal("not_served") }),
      z.object({ outcome: z.literal("unset"), revision: z.string().min(1) }),
    ]),
);
export type EnvironmentConfigurationGuideGetResponseV11 = z.infer<
  typeof environmentConfigurationGuideGetResponseSchemaV11
>;

export const environmentConfigurationGuideGetV11 = defineRpcContract({
  method: "environment.configuration.guide.get",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: environmentConfigurationGuideGetRequestSchema,
  responseSchema: environmentConfigurationGuideGetResponseSchemaV11,
});

export const environmentConfigurationGuideGetUpgradeV10ToV11 =
  defineUpgradePath<
    typeof environmentConfigurationGuideGetV10,
    typeof environmentConfigurationGuideGetV11
  >({
    from: environmentConfigurationGuideGetV10.schemaVersion,
    to: environmentConfigurationGuideGetV11.schemaVersion,
    upgradeRequest: (request) => request,
    upgradeResponse: (response) => response,
  });

/** `set` against the revision read; `conflict` when the text moved since. */
export const environmentConfigurationGuideSetRequestSchema = lazySchema(() =>
  z.object({
    environmentId: environmentIdSchema,
    text: z.string(),
    revision: z.string().min(1),
  }),
);
export type EnvironmentConfigurationGuideSetRequest = z.infer<
  typeof environmentConfigurationGuideSetRequestSchema
>;

export const environmentConfigurationGuideSetResponseSchema = lazySchema(() =>
  z.object({ outcome: z.enum(["set", "conflict", "not_served"]) }),
);
export type EnvironmentConfigurationGuideSetResponse = z.infer<
  typeof environmentConfigurationGuideSetResponseSchema
>;

export const environmentConfigurationGuideSetV10 = defineRpcContract({
  method: "environment.configuration.guide.set",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentConfigurationGuideSetRequestSchema,
  responseSchema: environmentConfigurationGuideSetResponseSchema,
});

/** Back to the default guide. */
export const environmentConfigurationGuideResetRequestSchema = lazySchema(() =>
  z.object({ environmentId: environmentIdSchema }),
);
export type EnvironmentConfigurationGuideResetRequest = z.infer<
  typeof environmentConfigurationGuideResetRequestSchema
>;

export const environmentConfigurationGuideResetResponseSchema = lazySchema(() =>
  z.object({ outcome: z.enum(["reset", "not_served"]) }),
);
export type EnvironmentConfigurationGuideResetResponse = z.infer<
  typeof environmentConfigurationGuideResetResponseSchema
>;

export const environmentConfigurationGuideResetV10 = defineRpcContract({
  method: "environment.configuration.guide.reset",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentConfigurationGuideResetRequestSchema,
  responseSchema: environmentConfigurationGuideResetResponseSchema,
});

// ── environment.history ─────────────────────────────────────────────────────

/**
 * What a history reads about, beyond the item kinds: a secret, a member, the
 * team's plan, the move, and a host's settings. Open, like the item kinds.
 */
export const ENVIRONMENT_HISTORY_SUBJECT_EXTRA_KINDS = [
  "secret",
  "member",
  "plan",
  "move",
  "host_settings",
] as const;

/** The whole configuration's history when `subject` is null. */
export const environmentHistoryRequestSchema = lazySchema(() =>
  z.object({
    environmentId: environmentIdSchema,
    subject: z
      .object({ kind: environmentItemKindSchema, key: z.string().min(1) })
      .nullable(),
  }),
);
export type EnvironmentHistoryRequest = z.infer<
  typeof environmentHistoryRequestSchema
>;

/**
 * One event. `actor` is who did it, `tombstoned` once that person's account
 * is gone (the label is then what remains of them), null for the system;
 * `operation` and `outcome` are open codes.
 */
export const environmentHistoryEntrySchema = lazySchema(() =>
  z.object({
    at: z.number().int().nonnegative(),
    actor: z.object({ label: z.string(), tombstoned: z.boolean() }).nullable(),
    operation: z.string().min(1).max(64),
    outcome: z.string().min(1).max(64),
  }),
);
export type EnvironmentHistoryEntry = z.infer<
  typeof environmentHistoryEntrySchema
>;

/**
 * How one host of the configuration stands on the subject: `state` an open
 * code with its `reason`, as of `at`, and when the host last reported. Both
 * times are null for a host that has not reported yet; neither is ever
 * filled in for it.
 */
export const environmentHistoryHostStateSchema = lazySchema(() =>
  z.object({
    hostId: z.string().min(1),
    hostName: z.string(),
    state: z.string().min(1).max(32),
    reason: z.string().min(1).max(64).nullable(),
    at: z.number().int().nonnegative().nullable(),
    lastReportedAt: z.number().int().nonnegative().nullable(),
  }),
);
export type EnvironmentHistoryHostState = z.infer<
  typeof environmentHistoryHostStateSchema
>;

/**
 * `entries` newest first; `readerScope` is how much of them this reader may
 * see: `full`, `own` (only the reader's own events), or `status_only` (no
 * entries; the client draws no history). `hostStates` is one row per host of
 * the configuration, for every scope.
 */
export const environmentHistoryResponseSchema = lazySchema(() =>
  z.object({
    entries: z.array(environmentHistoryEntrySchema),
    readerScope: z.enum(["full", "own", "status_only"]),
    hostStates: z.array(environmentHistoryHostStateSchema),
  }),
);
export type EnvironmentHistoryResponse = z.infer<
  typeof environmentHistoryResponseSchema
>;

export const environmentHistoryV10 = defineRpcContract({
  method: "environment.history",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentHistoryRequestSchema,
  responseSchema: environmentHistoryResponseSchema,
});
