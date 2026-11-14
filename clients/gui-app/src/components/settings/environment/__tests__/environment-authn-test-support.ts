import {
  environmentConfigurationMcpServerPutRequestSchemaV11,
  environmentConfigurationItemDeleteRequestSchema,
  environmentConfigurationItemPutRequestSchema,
  type EnvironmentConfigurationMcpServerPutRequestV11,
  type EnvironmentMcpServerDeclaration,
  type EnvironmentConfigurationItemWriteResponse,
} from "@traycer/protocol/host/environment/configuration-contracts";
import type { CloudBearerSource } from "@traycer-clients/shared/auth/bearer-source";
import type { EnvironmentTransportAnswer } from "@traycer-clients/shared/environment/environment-cloud";
import {
  fetchEnvironmentTransport,
  type EnvironmentCloud,
  type EnvironmentHttpMethod,
  type EnvironmentTransportRequest,
} from "@traycer-clients/shared/environment/environment-cloud";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { vi } from "vitest";

const AUTHN_BASE_URL = "https://authn.example.test";
const BEARER = "environment-test-bearer";

interface FakeAuthnCall {
  readonly method: string;
  readonly params: unknown;
}

interface RouteContext {
  readonly handlers: MockHandlerMap<HostRpcRegistry>;
  readonly calls: FakeAuthnCall[];
  readonly historyActors: Map<
    string,
    { readonly at: number; readonly label: string | null }
  >;
  readonly mcpServerLists: Map<
    string,
    Promise<EnvironmentMcpServerDeclaration[]>
  >;
  readonly recordItemsRead: (environmentId: string) => void;
}

export interface FakeEnvironmentAuthn {
  readonly cloud: EnvironmentCloud;
  readonly paramsOf: (method: string) => unknown[];
  readonly restore: () => void;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function requestBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(init.body);
    return parsed;
  } catch {
    return null;
  }
}

function environmentMethod(
  method: string | undefined,
): EnvironmentHttpMethod | null {
  if (method === undefined || method === "GET") return "GET";
  if (method === "POST") return "POST";
  if (method === "PUT") return "PUT";
  if (method === "PATCH") return "PATCH";
  if (method === "DELETE") return "DELETE";
  return null;
}

function objectBody(body: unknown): Record<string, unknown> | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const record: Record<string, unknown> = {};
  for (const key of Object.keys(body)) {
    record[key] = Reflect.get(body, key);
  }
  return record;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function itemsFor(
  handlers: MockHandlerMap<HostRpcRegistry>,
  environmentId: string,
) {
  const handler = handlers["environment.configuration.items"];
  return handler === undefined ? { items: [] } : handler({ environmentId });
}

function legacyMcpServers(
  environmentId: string,
  context: RouteContext,
): Promise<EnvironmentMcpServerDeclaration[]> {
  const held = context.mcpServerLists.get(environmentId);
  if (held !== undefined) return held;
  const handler = context.handlers["environment.configuration.mcpServers.list"];
  const pending = Promise.resolve()
    .then(() =>
      handler === undefined ? { servers: [] } : handler({ environmentId }),
    )
    .then((listed) => listed.servers)
    .catch((error: unknown) => {
      context.mcpServerLists.delete(environmentId);
      throw error;
    });
  context.calls.push({
    method: "environment.configuration.mcpServers.list",
    params: { environmentId },
  });
  context.mcpServerLists.set(environmentId, pending);
  return pending;
}

function authnServerRow(server: EnvironmentMcpServerDeclaration) {
  return {
    id: server.serverId,
    name: server.name,
    transport: server.transport,
    url: server.url,
    command: server.command,
    args: server.args,
    env: server.env,
    toolToggles: server.item?.toolToggles ?? {},
    credentials: {
      pat: {
        present: server.credential.kind === "secret",
        secretId:
          server.credential.kind === "secret"
            ? server.credential.secretId
            : null,
      },
      customHeaders: { present: false, secretId: null },
      oauth: { present: server.credential.kind === "oauth" },
    },
  };
}

function authnServerRowsFromItems(
  items: ReadonlyArray<{
    readonly kind: string;
    readonly key: string;
    readonly value: unknown;
  }>,
): unknown[] {
  return items.flatMap((item) => {
    if (item.kind !== "mcp_server") return [];
    const value = objectBody(item.value);
    if (value === null || typeof value.mcpServerId !== "string") return [];
    return [
      {
        id: value.mcpServerId,
        name: item.key,
        transport: "http",
        url: "https://mcp.example.test",
        command: null,
        args: [],
        env: [],
        toolToggles: objectBody(value.toolToggles) ?? {},
        credentials: {
          pat: { present: false, secretId: null },
          customHeaders: { present: false, secretId: null },
          oauth: { present: false },
        },
      },
    ];
  });
}

async function legacyMcpItems(
  environmentId: string,
  context: RouteContext,
): Promise<unknown[]> {
  const servers = await legacyMcpServers(environmentId, context);
  return servers.flatMap((server) =>
    server.item === null
      ? []
      : [
          {
            kind: "mcp_server",
            key: server.item.key,
            os: null,
            value: {
              mcpServerId: server.serverId,
              toolToggles: server.item.toolToggles,
              offFor: server.item.offFor,
            },
            revision: server.item.revision,
            updatedAt: 0,
            writtenBy: { source: "test", hostId: null, hostName: null },
          },
        ],
  );
}

function statusForWrite(outcome: string): number {
  if (outcome === "saved") return 200;
  if (outcome === "forbidden") return 403;
  return 400;
}

function authnPlanStatus(status: string): string {
  if (status === "linked") return "connected";
  if (status === "empty") return "absent";
  return status;
}

function authnServerFromPut(
  request: EnvironmentConfigurationMcpServerPutRequestV11,
): unknown {
  return {
    id: request.serverId ?? "server-created",
    name: request.name,
    transport: request.transport,
    url: request.url,
    command: request.command,
    args: request.args,
    env: request.env,
    toolToggles: request.toolToggles,
    credentials: {
      pat: {
        present:
          request.credential.kind === "pat" ||
          request.credential.kind === "secret",
        secretId:
          request.credential.kind === "secret"
            ? request.credential.secretId
            : null,
      },
      customHeaders: {
        present: request.credential.kind === "headers",
        secretId: null,
      },
      oauth: { present: false },
    },
  };
}

function answer(body: unknown, status: number): EnvironmentTransportAnswer {
  return { status, text: JSON.stringify(body) };
}

function writeAnswer(
  result: EnvironmentConfigurationItemWriteResponse,
): EnvironmentTransportAnswer {
  if (result.outcome === "forbidden") {
    return answer({ error: "Forbidden." }, 403);
  }
  if (result.outcome === "conflict") {
    return answer({ code: "revision_conflict", current: null }, 409);
  }
  if (result.revision === null) return { status: 204, text: null };
  return answer(
    { item: null, replayed: false, revision: result.revision },
    200,
  );
}

async function routeItemPut(
  request: EnvironmentTransportRequest,
  environmentId: string,
  kind: string,
  context: RouteContext,
): Promise<EnvironmentTransportAnswer> {
  const parsed = environmentConfigurationItemPutRequestSchema.safeParse({
    ...objectBody(request.body),
    environmentId,
    kind,
  });
  if (!parsed.success) return answer({ error: "Invalid item request." }, 400);
  if (kind === "mcp_server") {
    const value = objectBody(parsed.data.value);
    const serverId = value?.mcpServerId;
    const servers = await legacyMcpServers(environmentId, context);
    const reenabled =
      typeof serverId === "string" &&
      servers.some(
        (server) => server.serverId === serverId && server.item === null,
      );
    if (reenabled) {
      const enabledHandler =
        context.handlers["environment.configuration.mcpServers.setEnabled"];
      context.calls.push({
        method: "environment.configuration.mcpServers.setEnabled",
        params: { environmentId, serverId, enabled: true },
      });
      if (enabledHandler !== undefined) {
        const result = await enabledHandler({
          environmentId,
          serverId,
          enabled: true,
        });
        if (result.outcome !== "saved") {
          return answer(
            { code: result.reason ?? "item_refused" },
            statusForWrite(result.outcome),
          );
        }
      }
      context.mcpServerLists.delete(environmentId);
      return answer(
        { item: null, replayed: false, revision: parsed.data.revision ?? 1 },
        200,
      );
    }
  }
  context.calls.push({
    method: "environment.configuration.items.put",
    params: parsed.data,
  });
  const handler = context.handlers["environment.configuration.items.put"];
  if (handler === undefined) {
    context.mcpServerLists.delete(environmentId);
    return answer(
      { item: null, replayed: false, revision: parsed.data.revision ?? 1 },
      200,
    );
  }
  const result = await handler(parsed.data);
  if (result.outcome === "conflict" && result.current !== null) {
    const subject = `${kind}:${parsed.data.key}`;
    context.historyActors.set(subject, {
      at: result.current.changedAt,
      label: result.current.changedBy,
    });
    return answer(
      {
        code: "revision_conflict",
        current: {
          kind,
          key: parsed.data.key,
          os: parsed.data.os,
          value: parsed.data.value,
          revision: result.current.revision,
          updatedAt: result.current.changedAt,
          writtenBy: { source: "test", hostId: null, hostName: null },
        },
      },
      409,
    );
  }
  if (result.outcome === "saved") context.mcpServerLists.delete(environmentId);
  return writeAnswer(result);
}

async function routeItemDelete(
  request: EnvironmentTransportRequest,
  environmentId: string,
  kind: string,
  context: RouteContext,
): Promise<EnvironmentTransportAnswer> {
  const parsed = environmentConfigurationItemDeleteRequestSchema.safeParse({
    ...objectBody(request.body),
    environmentId,
    kind,
  });
  if (!parsed.success) return answer({ error: "Invalid item request." }, 400);
  if (kind === "mcp_server") return { status: 204, text: null };
  context.calls.push({
    method: "environment.configuration.items.delete",
    params: parsed.data,
  });
  const handler = context.handlers["environment.configuration.items.delete"];
  if (handler === undefined) return { status: 204, text: null };
  return writeAnswer(await handler(parsed.data));
}

async function routeItems(
  request: EnvironmentTransportRequest,
  url: URL,
  environmentId: string,
  context: RouteContext,
): Promise<EnvironmentTransportAnswer> {
  if (request.method === "GET") {
    const kind = url.searchParams.get("kind");
    context.recordItemsRead(environmentId);
    const itemHandler = context.handlers["environment.configuration.items"];
    const items =
      itemHandler === undefined
        ? await legacyMcpItems(environmentId, context)
        : (await itemsFor(context.handlers, environmentId)).items;
    return answer(
      { items: items.filter((item) => objectBody(item)?.kind === kind) },
      200,
    );
  }
  const kind = url.pathname.split("/").at(6);
  if (kind === undefined) return answer({ error: "Invalid item route." }, 404);
  if (request.method === "PUT") {
    return routeItemPut(
      request,
      environmentId,
      decodeURIComponent(kind),
      context,
    );
  }
  if (request.method === "DELETE") {
    return routeItemDelete(
      request,
      environmentId,
      decodeURIComponent(kind),
      context,
    );
  }
  return answer({ error: "Unsupported item method." }, 405);
}

async function listMcpServers(
  environmentId: string,
  context: RouteContext,
): Promise<EnvironmentTransportAnswer> {
  const servers = await legacyMcpServers(environmentId, context);
  if (servers.length > 0) {
    return answer({ servers: servers.map(authnServerRow) }, 200);
  }
  const itemHandler = context.handlers["environment.configuration.items"];
  if (itemHandler === undefined) return answer({ servers: [] }, 200);
  context.recordItemsRead(environmentId);
  const listed = await itemsFor(context.handlers, environmentId);
  return answer({ servers: authnServerRowsFromItems(listed.items) }, 200);
}

async function setMcpServerEnabled(
  environmentId: string,
  serverId: string,
  context: RouteContext,
): Promise<EnvironmentTransportAnswer> {
  const enabledHandler =
    context.handlers["environment.configuration.mcpServers.setEnabled"];
  context.calls.push({
    method: "environment.configuration.mcpServers.setEnabled",
    params: { environmentId, serverId, enabled: false },
  });
  if (enabledHandler !== undefined) {
    const result = await enabledHandler({
      environmentId,
      serverId,
      enabled: false,
    });
    if (result.outcome !== "saved") {
      return answer(
        { code: result.reason ?? "item_refused" },
        statusForWrite(result.outcome),
      );
    }
  }
  context.mcpServerLists.delete(environmentId);
  return answer({ outcome: "saved" }, 200);
}

async function putMcpServer(
  request: EnvironmentTransportRequest,
  environmentId: string,
  serverId: string | null,
  context: RouteContext,
): Promise<EnvironmentTransportAnswer> {
  const body = objectBody(request.body) ?? {};
  const parsed = environmentConfigurationMcpServerPutRequestSchemaV11.safeParse(
    {
      ...body,
      environmentId,
      serverId,
      offFor: body.offFor ?? [],
      credential: body.credential ?? { kind: "unchanged" },
    },
  );
  if (!parsed.success)
    return answer({ error: "Invalid MCP server request." }, 400);
  const handler = context.handlers["environment.configuration.mcpServers.put"];
  context.calls.push({
    method: "environment.configuration.mcpServers.put",
    params: parsed.data,
  });
  const result =
    handler === undefined
      ? { outcome: "saved" as const, reason: null }
      : await handler(parsed.data);
  if (result.outcome !== "saved") {
    return answer(
      { code: result.reason ?? "item_refused" },
      statusForWrite(result.outcome),
    );
  }
  context.mcpServerLists.delete(environmentId);
  return answer({ server: authnServerFromPut(parsed.data) }, 200);
}

async function deleteMcpServer(
  environmentId: string,
  serverId: string,
  context: RouteContext,
): Promise<EnvironmentTransportAnswer> {
  const decodedId = decodeURIComponent(serverId);
  const handler =
    context.handlers["environment.configuration.mcpServers.delete"];
  context.calls.push({
    method: "environment.configuration.mcpServers.delete",
    params: { environmentId, serverId: decodedId },
  });
  const result =
    handler === undefined
      ? { outcome: "saved" as const, reason: null }
      : await handler({ environmentId, serverId: decodedId });
  if (result.outcome !== "saved") {
    return answer(
      { code: result.reason ?? "item_refused" },
      statusForWrite(result.outcome),
    );
  }
  context.mcpServerLists.delete(environmentId);
  return answer({ deleted: true }, 200);
}

async function routeMcpServers(
  request: EnvironmentTransportRequest,
  path: readonly string[],
  environmentId: string,
  context: RouteContext,
): Promise<EnvironmentTransportAnswer> {
  const serverId = path.at(6);
  if (request.method === "GET") return listMcpServers(environmentId, context);
  if (request.method === "POST" && serverId === undefined) {
    return putMcpServer(request, environmentId, null, context);
  }
  if (request.method === "PATCH" && serverId !== undefined) {
    const body = objectBody(request.body);
    if (
      body !== null &&
      Object.keys(body).length === 1 &&
      "toolToggles" in body
    ) {
      return setMcpServerEnabled(
        environmentId,
        decodeURIComponent(serverId),
        context,
      );
    }
    return putMcpServer(
      request,
      environmentId,
      decodeURIComponent(serverId),
      context,
    );
  }
  if (request.method === "DELETE" && serverId !== undefined) {
    return deleteMcpServer(environmentId, serverId, context);
  }
  return answer({ error: "Unknown MCP server route." }, 404);
}

async function routeRevision(
  environmentId: string,
  context: RouteContext,
): Promise<EnvironmentTransportAnswer> {
  context.calls.push({
    method: "environment.configuration.revision",
    params: { environmentId },
  });
  const handler = context.handlers["environment.configuration.revision"];
  return answer(
    handler === undefined ? { revision: 0 } : await handler({ environmentId }),
    200,
  );
}

async function routeSecrets(
  path: readonly string[],
  request: EnvironmentTransportRequest,
  environmentId: string,
  context: RouteContext,
): Promise<EnvironmentTransportAnswer> {
  if (path.at(6) === "harness-connections") {
    context.calls.push({
      method: "environment.plans.list",
      params: { environmentId },
    });
    const handler = context.handlers["environment.plans.list"];
    if (handler === undefined) return answer({ connections: [] }, 200);
    const listed = await handler({ environmentId });
    return answer(
      {
        connections: listed.plans.map((plan) => ({
          profileId: plan.profileId,
          harnessId: plan.harness,
          bindingVersion: plan.bindingVersion,
          kind: "oauth",
          status: authnPlanStatus(plan.status),
          linkedBy:
            plan.linkedBy === null
              ? null
              : {
                  displayName: plan.linkedBy.name,
                  you: plan.linkedBy.you,
                },
        })),
      },
      200,
    );
  }
  if (request.method !== "GET")
    return answer({ error: "Unknown secret route." }, 404);
  const secretId = path.at(6);
  const action = path.at(7);
  if (secretId !== undefined && action === "versions") {
    const handler = context.handlers["environment.secrets.versions"];
    if (handler === undefined) {
      return answer({ versions: [], removal: null }, 200);
    }
    const decodedId = decodeURIComponent(secretId);
    context.calls.push({
      method: "environment.secrets.versions",
      params: { environmentId, secretId: decodedId },
    });
    return answer(await handler({ environmentId, secretId: decodedId }), 200);
  }
  if (secretId !== undefined && action === "rotation") {
    const handler = context.handlers["environment.secrets.rotation"];
    if (handler === undefined) {
      return answer({ rotation: null, lastVerify: null }, 200);
    }
    const decodedId = decodeURIComponent(secretId);
    context.calls.push({
      method: "environment.secrets.rotation",
      params: { environmentId, secretId: decodedId },
    });
    return answer(await handler({ environmentId, secretId: decodedId }), 200);
  }
  const handler = context.handlers["environment.secrets.list"];
  if (handler === undefined) {
    const servers = await legacyMcpServers(environmentId, context);
    return answer(
      {
        secrets: servers.flatMap((server) =>
          server.credential.kind === "secret" &&
          server.credential.secretId !== null &&
          server.credential.secretName !== null
            ? [
                {
                  id: server.credential.secretId,
                  name: server.credential.secretName,
                  kind: server.credential.owned ? "mcp_credential" : "secret",
                  protocol: "http",
                  hosts: [],
                  currentVersionId: "test-version",
                  updatedAt: 0,
                  variables: [],
                },
              ]
            : [],
        ),
        removed: [],
      },
      200,
    );
  }
  context.calls.push({
    method: "environment.secrets.list",
    params: { environmentId },
  });
  const listed = await handler({ environmentId });
  return answer(
    {
      secrets: listed.secrets.map((secret) => ({
        id: secret.secretId,
        name: secret.name,
        kind: secret.kind,
        protocol: secret.protocol,
        hosts: secret.destinations,
        currentVersionId: secret.currentVersionId,
        updatedAt: secret.updatedAt,
        variables: secret.variables.map((name) => ({ name })),
      })),
      removed: listed.removed,
    },
    200,
  );
}

async function routeRequest(
  request: EnvironmentTransportRequest,
  context: RouteContext,
): Promise<EnvironmentTransportAnswer> {
  const url = new URL(request.url);
  const path = url.pathname.split("/");
  const environmentId = path.at(4);
  const resource = path.at(5);
  if (environmentId === undefined || resource === undefined) {
    return answer({ error: "Unknown environment route." }, 404);
  }
  if (resource === "items") {
    return routeItems(request, url, environmentId, context);
  }
  if (resource === "revision" && request.method === "GET") {
    return routeRevision(environmentId, context);
  }
  if (resource === "history" && request.method === "GET") {
    const subject = url.searchParams.get("subject");
    const actor =
      subject === null ? undefined : context.historyActors.get(subject);
    return answer(
      {
        entries:
          actor === undefined
            ? []
            : [
                {
                  at: actor.at,
                  actor:
                    actor.label === null
                      ? null
                      : { label: actor.label, tombstoned: false },
                  operation: "put",
                  outcome: "saved",
                },
              ],
        readerScope: "full",
        hostStates: [],
      },
      200,
    );
  }
  if (resource === "mcp-servers") {
    return routeMcpServers(request, path, environmentId, context);
  }
  if (resource === "secrets") {
    return routeSecrets(path, request, environmentId, context);
  }
  return answer({ error: "Unknown environment route." }, 404);
}

export function createFakeEnvironmentAuthn(
  handlers: MockHandlerMap<HostRpcRegistry>,
): FakeEnvironmentAuthn {
  const calls: FakeAuthnCall[] = [];
  const historyActors = new Map<
    string,
    { readonly at: number; readonly label: string | null }
  >();
  const mcpServerLists = new Map<
    string,
    Promise<EnvironmentMcpServerDeclaration[]>
  >();
  let itemReadBatchOpen = false;
  const recordItemsRead = (environmentId: string): void => {
    if (itemReadBatchOpen) return;
    itemReadBatchOpen = true;
    calls.push({
      method: "environment.configuration.items",
      params: { environmentId },
    });
    queueMicrotask(() => {
      itemReadBatchOpen = false;
    });
  };
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const url = new URL(requestUrl(input));
      const method = environmentMethod(init?.method);
      if (method === null)
        return jsonResponse({ error: "Unsupported method." }, 405);
      const request: EnvironmentTransportRequest = {
        url: url.href,
        method,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: requestBody(init),
        signal: init?.signal ?? new AbortController().signal,
      };
      try {
        const result = await routeRequest(request, {
          handlers,
          calls,
          historyActors,
          mcpServerLists,
          recordItemsRead,
        });
        return result.status === 204
          ? new Response(null, { status: 204 })
          : new Response(result.text, { status: result.status });
      } catch {
        return jsonResponse(
          { error: "Cloud service is temporarily unavailable." },
          503,
        );
      }
    });
  const bearer: CloudBearerSource = {
    kind: "cloud",
    getBearerToken: () => BEARER,
  };
  return {
    cloud: {
      authnBaseUrl: AUTHN_BASE_URL,
      bearer,
      transport: fetchEnvironmentTransport,
      onOriginSignIn: () => true,
    },
    paramsOf: (method) =>
      calls.filter((call) => call.method === method).map((call) => call.params),
    restore: () => fetchSpy.mockRestore(),
  };
}
