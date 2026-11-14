import {
  environmentConfigurationItemDeleteRequestSchema,
  environmentConfigurationItemPutRequestSchema,
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

function itemServerRows(
  items: ReadonlyArray<{
    readonly kind: string;
    readonly key: string;
    readonly value: unknown;
    readonly revision: number;
  }>,
): unknown[] {
  return items.flatMap((item) => {
    if (item.kind !== "mcp_server" || typeof item.value !== "object") {
      return [];
    }
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
        toolToggles: {},
        credentials: {
          pat: { present: false, secretId: null },
          customHeaders: { present: false, secretId: null },
          oauth: { present: false },
        },
      },
    ];
  });
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
  context.calls.push({
    method: "environment.configuration.items.put",
    params: parsed.data,
  });
  const handler = context.handlers["environment.configuration.items.put"];
  if (handler === undefined) {
    return answer(
      { item: null, replayed: false, revision: parsed.data.revision ?? 1 },
      200,
    );
  }
  return writeAnswer(await handler(parsed.data));
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
    const listed = await itemsFor(context.handlers, environmentId);
    return answer(
      { items: listed.items.filter((item) => item.kind === kind) },
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
    return answer({ connections: [] }, 200);
  }
  if (request.method !== "GET")
    return answer({ error: "Unknown secret route." }, 404);
  const handler = context.handlers["environment.secrets.list"];
  if (handler === undefined) return answer({ secrets: [], removed: [] }, 200);
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
  if (resource === "mcp-servers" && request.method === "GET") {
    context.calls.push({
      method: "environment.configuration.mcpServers.list",
      params: { environmentId },
    });
    const listed = await itemsFor(context.handlers, environmentId);
    return answer({ servers: itemServerRows(listed.items) }, 200);
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
