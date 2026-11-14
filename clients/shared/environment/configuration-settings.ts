/**
 * `environment.configuration.items*`, `.revision`, `.mcpServers.*`,
 * `.policy.put`, `environment.history` and `environment.plans.*` as the app's
 * own calls to authn's environment routes (`environment-cloud.ts`). Each
 * function answers exactly what the host's and the pool's forwarder answered
 * for the same method (`packages/common/src/environments/configuration-
 * forwarding/settings.ts` in the internal repository), so a screen reads the
 * same shape whether a host served it or authn did.
 */
import type { z } from "zod";
import {
  environmentConfigurationRevisionResponseSchema,
  environmentHistoryResponseSchema,
  type environmentConfigurationMcpServerDeleteRequestSchema,
  type environmentConfigurationMcpServerSetEnabledRequestSchema,
  type EnvironmentConfigurationItemDeleteRequest,
  type EnvironmentConfigurationItemPutRequest,
  type EnvironmentConfigurationItemWriteResponse,
  type EnvironmentConfigurationItemsResponse,
  type EnvironmentConfigurationMcpServerPutRequestV11,
  type EnvironmentConfigurationMcpServerPutResponseV11,
  type EnvironmentConfigurationMcpServersListResponse,
  type EnvironmentConfigurationPolicyPutRequest,
  type EnvironmentConfigurationRevisionResponse,
  type EnvironmentConfigurationWriteResponse,
  type EnvironmentHistoryRequest,
  type EnvironmentHistoryResponse,
  type EnvironmentPlansListResponse,
  type EnvironmentPlansUnlinkResponse,
} from "@traycer/protocol/host/environment/configuration-contracts";
import {
  ITEM_ROUTE_KINDS,
  authnHarnessConnectionsResponseSchema,
  authnHarnessDisconnectResponseSchema,
  authnItemConflictSchema,
  authnItemWriteResponseSchema,
  authnItemsResponseSchema,
  authnMcpServerDeleteResponseSchema,
  authnMcpServerItemValueSchema,
  authnMcpServerResponseSchema,
  authnMcpServersResponseSchema,
  authnSecretsListSchema,
  type AuthnHarnessConnection,
  type AuthnMcpServer,
} from "./authn-environment-schemas";
import {
  EnvironmentCloudError,
  environmentPath,
  errorBodyCode,
  isSuccess,
  parseSettings,
  sendSettings,
  type EnvironmentAnswer,
  type EnvironmentCloud,
} from "./environment-cloud";

function mutationOutcome(answer: EnvironmentAnswer): {
  outcome: "saved" | "forbidden" | "refused";
  reason: string | null;
} {
  if (answer.status === 403) return { outcome: "forbidden", reason: null };
  if (isSuccess(answer)) return { outcome: "saved", reason: null };
  return { outcome: "refused", reason: errorBodyCode(answer.body) };
}

// ── items ───────────────────────────────────────────────────────────────────

/** Authoritative even with zero hosts; never derived from a host or item rows. */
export async function readConfigurationRevision(
  cloud: EnvironmentCloud,
  environmentId: string,
): Promise<EnvironmentConfigurationRevisionResponse> {
  return parseSettings(
    await sendSettings(
      cloud,
      "GET",
      `${environmentPath(environmentId)}/revision`,
      null,
    ),
    environmentConfigurationRevisionResponseSchema,
  );
}

export async function readConfigurationItems(
  cloud: EnvironmentCloud,
  environmentId: string,
): Promise<EnvironmentConfigurationItemsResponse> {
  const pages = await Promise.all(
    ITEM_ROUTE_KINDS.map(async (kind) => {
      const answer = await sendSettings(
        cloud,
        "GET",
        `${environmentPath(environmentId)}/items?kind=${encodeURIComponent(kind)}`,
        null,
      );
      // An authn older than this app has no route for a newer kind yet: that
      // kind has no rows, and every other kind still reads.
      if (
        answer.status === 400 &&
        errorBodyCode(answer.body) === "kind_not_item_route"
      ) {
        return { items: [] };
      }
      return parseSettings(answer, authnItemsResponseSchema);
    }),
  );
  return { items: pages.flatMap((page) => page.items) };
}

async function itemWriteOutcome(
  cloud: EnvironmentCloud,
  environmentId: string,
  kind: string,
  key: string,
  answer: EnvironmentAnswer,
): Promise<EnvironmentConfigurationItemWriteResponse> {
  if (answer.status === 403) return { outcome: "forbidden" };
  if (answer.status === 409) {
    const conflict = authnItemConflictSchema.safeParse(answer.body);
    if (conflict.success) {
      const current = conflict.data.current;
      if (current === null) return { outcome: "conflict", current: null };
      let changedBy: string | null = null;
      try {
        const query = new URLSearchParams({ subject: `${kind}:${key}` });
        const history = parseSettings(
          await sendSettings(
            cloud,
            "GET",
            `${environmentPath(environmentId)}/history?${query.toString()}`,
            null,
          ),
          environmentHistoryResponseSchema,
        );
        const matching = history.entries.filter(
          (entry) => entry.at === current.updatedAt && entry.actor !== null,
        );
        if (matching.length === 1)
          changedBy = matching[0]?.actor?.label ?? null;
      } catch {
        // A missing actor label must not hide the authoritative conflict.
      }
      return {
        outcome: "conflict",
        current: {
          revision: current.revision,
          changedBy,
          changedAt: current.updatedAt,
        },
      };
    }
  }
  if (answer.status === 204) return { outcome: "saved", revision: null };
  const written = parseSettings(answer, authnItemWriteResponseSchema);
  return { outcome: "saved", revision: written.revision };
}

export async function putConfigurationItem(
  cloud: EnvironmentCloud,
  request: EnvironmentConfigurationItemPutRequest,
): Promise<EnvironmentConfigurationItemWriteResponse> {
  const { environmentId, kind, ...body } = request;
  return itemWriteOutcome(
    cloud,
    environmentId,
    kind,
    body.key,
    await sendSettings(
      cloud,
      "PUT",
      `${environmentPath(environmentId)}/items/${encodeURIComponent(kind)}`,
      { ...body, upload: null },
    ),
  );
}

export async function deleteConfigurationItem(
  cloud: EnvironmentCloud,
  request: EnvironmentConfigurationItemDeleteRequest,
): Promise<EnvironmentConfigurationItemWriteResponse> {
  const { environmentId, kind, ...body } = request;
  return itemWriteOutcome(
    cloud,
    environmentId,
    kind,
    body.key,
    await sendSettings(
      cloud,
      "DELETE",
      `${environmentPath(environmentId)}/items/${encodeURIComponent(kind)}`,
      { ...body, upload: null },
    ),
  );
}

// ── MCP servers ─────────────────────────────────────────────────────────────

/** An environment's `mcp_server` item: which server row it installs, and where. */
interface McpServerItem {
  readonly key: string;
  readonly revision: number;
  readonly mcpServerId: string;
  readonly toolToggles: Readonly<
    Record<string, Readonly<Record<string, boolean>>>
  >;
  readonly offFor: readonly string[];
}

async function readMcpServerItems(
  cloud: EnvironmentCloud,
  environmentId: string,
): Promise<McpServerItem[]> {
  const page = parseSettings(
    await sendSettings(
      cloud,
      "GET",
      `${environmentPath(environmentId)}/items?kind=mcp_server`,
      null,
    ),
    authnItemsResponseSchema,
  );
  return page.items.flatMap((row) => {
    const value = authnMcpServerItemValueSchema.safeParse(row.value);
    return value.success
      ? [
          {
            key: row.key,
            revision: row.revision,
            mcpServerId: value.data.mcpServerId,
            toolToggles: value.data.toolToggles,
            offFor: value.data.offFor ?? [],
          },
        ]
      : [];
  });
}

/** What a list reads of a secret a server names. */
interface ListedSecret {
  readonly name: string;
  readonly kind: string;
}

/**
 * Whether a bound secret is the server's own copy, which authn writes as an
 * `mcp_credential` named after the server and revokes with it; a picked
 * secret is only unbound.
 */
function ownCopyOf(server: AuthnMcpServer, secret: ListedSecret): boolean {
  const prefix = `MCP_${server.id.replace(/-/g, "").toUpperCase()}_`;
  return secret.kind === "mcp_credential" && secret.name.startsWith(prefix);
}

/** A server's credential as a list shows it: which secret holds it, never its value. */
function listedCredential(
  server: AuthnMcpServer,
  secrets: ReadonlyMap<string, ListedSecret>,
): {
  kind: "none" | "secret" | "oauth";
  secretId: string | null;
  secretName: string | null;
  owned: boolean;
} {
  // The applier's order: custom headers, else the PAT.
  const held = server.credentials.customHeaders.present
    ? server.credentials.customHeaders
    : server.credentials.pat;
  if (held.present) {
    // A value still in the row goes with the server.
    if (held.secretId === null) {
      return { kind: "secret", secretId: null, secretName: null, owned: true };
    }
    const secret = secrets.get(held.secretId);
    return {
      kind: "secret",
      secretId: held.secretId,
      secretName: secret?.name ?? null,
      owned: secret !== undefined && ownCopyOf(server, secret),
    };
  }
  if (server.credentials.oauth.present) {
    return { kind: "oauth", secretId: null, secretName: null, owned: false };
  }
  return { kind: "none", secretId: null, secretName: null, owned: false };
}

/** The `mcp-servers` route body of a put's credential. */
function credentialBody(
  credential: EnvironmentConfigurationMcpServerPutRequestV11["credential"],
  creating: boolean,
): Record<string, unknown> {
  switch (credential.kind) {
    case "unchanged":
      return creating ? { pat: null, customHeaders: null } : {};
    case "none":
      return { pat: null, customHeaders: null };
    case "pat":
      return { pat: credential.pat, customHeaders: null };
    case "headers":
      return { pat: null, customHeaders: credential.headers };
    case "secret":
      return creating
        ? { pat: null, customHeaders: null, patSecretId: credential.secretId }
        : { customHeaders: null, patSecretId: credential.secretId };
  }
}

/** The `mcp_server` item value; `offFor` omitted when empty, as released hosts parse it. */
function mcpServerItemValue(
  mcpServerId: string,
  toolToggles: EnvironmentConfigurationMcpServerPutRequestV11["toolToggles"],
  offFor: readonly string[],
): Record<string, unknown> {
  return offFor.length === 0
    ? { mcpServerId, toolToggles }
    : { mcpServerId, toolToggles, offFor: [...offFor] };
}

export async function listConfigurationMcpServers(
  cloud: EnvironmentCloud,
  environmentId: string,
): Promise<EnvironmentConfigurationMcpServersListResponse> {
  const path = environmentPath(environmentId);
  const [listed, items, secrets] = await Promise.all([
    sendSettings(cloud, "GET", `${path}/mcp-servers`, null).then((answer) =>
      parseSettings(answer, authnMcpServersResponseSchema),
    ),
    readMcpServerItems(cloud, environmentId),
    sendSettings(cloud, "GET", `${path}/secrets`, null).then((answer) =>
      parseSettings(answer, authnSecretsListSchema),
    ),
  ]);
  const secretsById = new Map(
    secrets.secrets.map((secret) => [
      secret.id,
      { name: secret.name, kind: secret.kind },
    ]),
  );
  return {
    servers: listed.servers.map((server) => {
      const item = items.find((row) => row.mcpServerId === server.id);
      return {
        serverId: server.id,
        name: server.name,
        transport: server.transport,
        url: server.url,
        command: server.command,
        args: server.args,
        env: server.env,
        credential: listedCredential(server, secretsById),
        item:
          item === undefined
            ? null
            : {
                key: item.key,
                revision: item.revision,
                toolToggles: item.toolToggles,
                offFor: [...item.offFor],
              },
      };
    }),
  };
}

export async function putConfigurationMcpServer(
  cloud: EnvironmentCloud,
  request: EnvironmentConfigurationMcpServerPutRequestV11,
): Promise<EnvironmentConfigurationMcpServerPutResponseV11> {
  const { environmentId, serverId, credential, offFor, ...body } = request;
  // The broker binds a credential to an http destination; a stdio server
  // has none to bind it to.
  if (
    body.transport === "stdio" &&
    credential.kind !== "none" &&
    credential.kind !== "unchanged"
  ) {
    return { outcome: "refused", reason: "stdio_credential", serverId: null };
  }
  const path = environmentPath(environmentId);
  const items = await readMcpServerItems(cloud, environmentId);
  const held =
    serverId === null
      ? undefined
      : items.find((row) => row.mcpServerId === serverId);
  if (
    items.some((row) => row.key === body.name && row.mcpServerId !== serverId)
  ) {
    return { outcome: "refused", reason: "name_taken", serverId: null };
  }
  if (serverId !== null) {
    // An edit is one request: authn writes the row and its item, and a
    // rename's old key, in one commit, so a refused edit changes nothing, its
    // credential included. A server switched off has no item and stays off:
    // its row alone is written, keeping the tool switches it was switched
    // off with.
    const { toolToggles, ...definition } = body;
    const answer = await sendSettings(
      cloud,
      "PATCH",
      `${path}/mcp-servers/${encodeURIComponent(serverId)}`,
      held === undefined
        ? { ...definition, ...credentialBody(credential, false) }
        : {
            ...body,
            ...credentialBody(credential, false),
            item: {
              key: body.name,
              value: mcpServerItemValue(serverId, toolToggles, offFor),
              revision: held.key === body.name ? held.revision : null,
              retire:
                held.key === body.name
                  ? null
                  : { key: held.key, revision: held.revision },
            },
          },
    );
    if (answer.status === 403) {
      return { outcome: "forbidden", reason: null, serverId: null };
    }
    if (!isSuccess(answer)) {
      return {
        outcome: "refused",
        reason:
          errorBodyCode(answer.body) ??
          (answer.status === 409 ? "revision_conflict" : "item_refused"),
        serverId: null,
      };
    }
    return {
      outcome: "saved",
      reason: null,
      serverId: parseSettings(answer, authnMcpServerResponseSchema).server.id,
    };
  }
  const answer = await sendSettings(cloud, "POST", `${path}/mcp-servers`, {
    ...body,
    ...credentialBody(credential, true),
  });
  const written = mutationOutcome(answer);
  if (written.outcome !== "saved") return { ...written, serverId: null };
  const saved = parseSettings(answer, authnMcpServerResponseSchema).server;
  // The row reaches hosts only through its item: a row whose item cannot be
  // written goes with it, and authn revokes the credentials it stored for the
  // row with it.
  const rollBack = async (): Promise<void> => {
    try {
      await sendSettings(
        cloud,
        "DELETE",
        `${path}/mcp-servers/${encodeURIComponent(saved.id)}`,
        null,
      );
    } catch {
      // The refusal below is what the person reads; a failed rollback leaves
      // a row with no item, which reaches no host.
    }
  };
  let itemAnswer: EnvironmentAnswer;
  try {
    itemAnswer = await sendSettings(cloud, "PUT", `${path}/items/mcp_server`, {
      key: body.name,
      os: null,
      value: mcpServerItemValue(saved.id, body.toolToggles, offFor),
      revision: null,
      upload: null,
    });
  } catch (error) {
    await rollBack();
    throw error;
  }
  if (isSuccess(itemAnswer)) {
    return { outcome: "saved", reason: null, serverId: saved.id };
  }
  await rollBack();
  return {
    outcome: "refused",
    reason:
      itemAnswer.status === 409
        ? "name_taken"
        : (errorBodyCode(itemAnswer.body) ?? "item_refused"),
    serverId: null,
  };
}

export async function deleteConfigurationMcpServer(
  cloud: EnvironmentCloud,
  request: z.infer<typeof environmentConfigurationMcpServerDeleteRequestSchema>,
): Promise<EnvironmentConfigurationWriteResponse> {
  const path = environmentPath(request.environmentId);
  const items = await readMcpServerItems(cloud, request.environmentId);
  // The item first: its removal retires the server on every host, and a row
  // with no item reaches none.
  for (const item of items.filter(
    (row) => row.mcpServerId === request.serverId,
  )) {
    const removed = mutationOutcome(
      await sendSettings(cloud, "DELETE", `${path}/items/mcp_server`, {
        key: item.key,
        os: null,
        revision: item.revision,
        upload: null,
      }),
    );
    if (removed.outcome !== "saved") return removed;
  }
  const answer = await sendSettings(
    cloud,
    "DELETE",
    `${path}/mcp-servers/${encodeURIComponent(request.serverId)}`,
    null,
  );
  const outcome = mutationOutcome(answer);
  if (outcome.outcome === "saved") {
    parseSettings(answer, authnMcpServerDeleteResponseSchema);
  }
  return outcome;
}

export async function setConfigurationMcpServerEnabled(
  cloud: EnvironmentCloud,
  request: z.infer<
    typeof environmentConfigurationMcpServerSetEnabledRequestSchema
  >,
): Promise<EnvironmentConfigurationWriteResponse> {
  const path = environmentPath(request.environmentId);
  const items = await readMcpServerItems(cloud, request.environmentId);
  const held = items.find((row) => row.mcpServerId === request.serverId);
  if (!request.enabled) {
    if (held === undefined) return { outcome: "saved", reason: null };
    // A tool switch writes the item alone: the row keeps them while the
    // server is off, for the switch that puts it back.
    const kept = mutationOutcome(
      await sendSettings(
        cloud,
        "PATCH",
        `${path}/mcp-servers/${encodeURIComponent(request.serverId)}`,
        { toolToggles: held.toolToggles },
      ),
    );
    if (kept.outcome !== "saved") return kept;
    return mutationOutcome(
      await sendSettings(cloud, "DELETE", `${path}/items/mcp_server`, {
        key: held.key,
        os: null,
        revision: held.revision,
        upload: null,
      }),
    );
  }
  if (held !== undefined) return { outcome: "saved", reason: null };
  const server = parseSettings(
    await sendSettings(cloud, "GET", `${path}/mcp-servers`, null),
    authnMcpServersResponseSchema,
  ).servers.find((row) => row.id === request.serverId);
  if (server === undefined) {
    return { outcome: "refused", reason: "mcp_server_not_found" };
  }
  if (items.some((row) => row.key === server.name)) {
    return { outcome: "refused", reason: "name_taken" };
  }
  const answer = await sendSettings(cloud, "PUT", `${path}/items/mcp_server`, {
    key: server.name,
    os: null,
    value: mcpServerItemValue(server.id, server.toolToggles, []),
    revision: null,
    upload: null,
  });
  if (answer.status === 409) {
    return { outcome: "refused", reason: "name_taken" };
  }
  return mutationOutcome(answer);
}

// ── policy, history ─────────────────────────────────────────────────────────

export async function putConfigurationPolicy(
  cloud: EnvironmentCloud,
  request: EnvironmentConfigurationPolicyPutRequest,
): Promise<EnvironmentConfigurationWriteResponse> {
  return mutationOutcome(
    await sendSettings(
      cloud,
      "PUT",
      `${environmentPath(request.environmentId)}/policy`,
      { body: request.body, policyVersion: request.policyVersion },
    ),
  );
}

export async function readConfigurationHistory(
  cloud: EnvironmentCloud,
  request: EnvironmentHistoryRequest,
): Promise<EnvironmentHistoryResponse> {
  const query = new URLSearchParams();
  if (request.subject !== null) {
    query.set("subject", `${request.subject.kind}:${request.subject.key}`);
  }
  const history = parseSettings(
    await sendSettings(
      cloud,
      "GET",
      `${environmentPath(request.environmentId)}/history${query.size === 0 ? "" : `?${query.toString()}`}`,
      null,
    ),
    environmentHistoryResponseSchema,
  );
  // The contract answers newest first; authn lists them oldest first.
  // `toSorted` is stable, so entries of one time keep authn's order.
  return {
    ...history,
    entries: history.entries.toSorted((a, b) => b.at - a.at),
  };
}

// ── plans ───────────────────────────────────────────────────────────────────

function planStatus(
  connection: AuthnHarnessConnection,
): "linked" | "pending" | "expired" | "empty" {
  switch (connection.status) {
    case "connected":
    case "staged":
      return "linked";
    case "pending":
      return "pending";
    case "expired":
    case "failed":
      return "expired";
    case "absent":
      return "empty";
  }
}

async function planConnections(
  cloud: EnvironmentCloud,
  environmentId: string,
): Promise<AuthnHarnessConnection[]> {
  return parseSettings(
    await sendSettings(
      cloud,
      "GET",
      `${environmentPath(environmentId)}/secrets/harness-connections`,
      null,
    ),
    authnHarnessConnectionsResponseSchema,
  ).connections;
}

export async function listConfigurationPlans(
  cloud: EnvironmentCloud,
  environmentId: string,
): Promise<EnvironmentPlansListResponse> {
  const connections = await planConnections(cloud, environmentId);
  return {
    plans: connections
      .filter((connection) => connection.kind !== "api_key")
      .map((connection) => ({
        profileId: connection.profileId,
        bindingVersion: connection.bindingVersion ?? null,
        harness: connection.harnessId,
        status: planStatus(connection),
        linkedBy:
          connection.linkedBy === null
            ? null
            : {
                name: connection.linkedBy.displayName,
                you: connection.linkedBy.you,
              },
      })),
  };
}

export async function unlinkConfigurationPlan(
  cloud: EnvironmentCloud,
  environmentId: string,
  profileId: string,
  expectedBindingVersion: number | null,
): Promise<EnvironmentPlansUnlinkResponse> {
  const answer = await sendSettings(
    cloud,
    "DELETE",
    `${environmentPath(environmentId)}/secrets/harness-connections/${encodeURIComponent(profileId)}`,
    { expectedBindingVersion },
  );
  if (answer.status === 409)
    throw new EnvironmentCloudError(
      "invalid",
      "The provider connection changed. Refresh and try again.",
    );
  if (answer.status === 403) return { outcome: "forbidden" };
  if (answer.status === 404) return { outcome: "not_linked" };
  const result = parseSettings(answer, authnHarnessDisconnectResponseSchema);
  return { outcome: result.disconnected ? "unlinked" : "not_linked" };
}
