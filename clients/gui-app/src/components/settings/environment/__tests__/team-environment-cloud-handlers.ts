import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { EnvironmentDirectoryResult } from "@traycer-clients/shared/host-client/environment-directory";
import type {
  EnvironmentTransportRequest,
  EnvironmentTransportAnswer,
} from "@traycer-clients/shared/environment/environment-cloud";
import {
  environmentConfigurationItemPutRequestSchema,
  environmentConfigurationItemDeleteRequestSchema,
  environmentConfigurationPolicyPutRequestSchema,
  environmentHistoryRequestSchema,
  type EnvironmentConfigurationItemWriteResponse,
  type EnvironmentHistoryResponse,
  type EnvironmentConfigurationMcpServersListResponse,
} from "@traycer/protocol/host/environment/configuration-contracts";
import {
  environmentSecretsCreateRequestSchemaV11,
  environmentSecretsVerifyRequestSchemaV11,
  environmentSecretsReplaceValueRequestSchemaV11,
  environmentSecretsUndoRequestSchemaV11,
  environmentSecretsConsentRequestSchemaV11,
  type EnvironmentSecret,
  type EnvironmentSecretsListResponseV12,
} from "@traycer/protocol/host/environment-schemas";
import type {
  AuthnMcpServer,
  AuthnSecretRow,
} from "@traycer-clients/shared/environment/authn-environment-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import type { EnvironmentDescriptorV11 } from "@traycer/protocol/host/environment/contracts";
import type { ConfigurationSource } from "@/components/settings/environment/configuration-source";
import {
  environmentMembersInviteRequestSchema,
  environmentMembersSetRoleRequestSchema,
} from "@traycer/protocol/host/environment/contracts";
import { jsonEnvironmentAnswer } from "../../../../../__tests__/create-fake-runner-host";
import { z } from "zod";
import { RETIRED_SECRET_CREATE_FIELDS } from "@traycer/protocol/host/released-wire-rows";
import { SANDBOX_PLAINTEXT_DISCLOSURE_VERSION } from "@traycer/protocol/host/secret-intake-catalogue";

function planConnectionStatus(
  status: "linked" | "empty" | "pending" | "expired",
): "connected" | "absent" | "pending" | "expired" {
  if (status === "linked") return "connected";
  if (status === "empty") return "absent";
  return status;
}

function appliedItemStatus(state: string): "applied" | "failed" | "pending" {
  if (state === "applied") return "applied";
  if (state === "not_applied") return "failed";
  return "pending";
}

export function authnMcpServer(
  server: EnvironmentConfigurationMcpServersListResponse["servers"][number],
): AuthnMcpServer {
  const hasSecret = server.credential.kind === "secret";
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
      pat: { present: hasSecret, secretId: server.credential.secretId },
      customHeaders: { present: false, secretId: null },
      oauth: { present: server.credential.kind === "oauth" },
    },
  };
}

export function authnSecret(secret: EnvironmentSecret): AuthnSecretRow {
  return {
    id: secret.secretId,
    name: secret.name,
    kind: secret.kind,
    protocol: secret.protocol ?? secret.kind,
    hosts: secret.destinations,
    currentVersionId: secret.currentVersionId ?? secret.secretId,
    updatedAt: secret.updatedAt,
    variables: [],
  };
}

export function authnSecretsList(response: EnvironmentSecretsListResponseV12) {
  return {
    secrets: response.secrets.map((secret) => ({
      ...authnSecret(secret),
      variables: secret.variables.map((name) => ({ name })),
    })),
    removed: response.removed,
  };
}

export type TeamEnvironmentCloudResponses = Map<
  string,
  (
    request: EnvironmentTransportRequest,
  ) => EnvironmentTransportAnswer | Promise<EnvironmentTransportAnswer>
>;

export interface TeamEnvironmentCloudCall {
  readonly method: string;
  readonly params: unknown;
}

/** Adapts the existing protocol fixtures at the authn transport boundary. */
export function createTeamEnvironmentCloudHandlers(
  handlers: MockHandlerMap<HostRpcRegistry>,
  source: ConfigurationSource,
) {
  const calls: TeamEnvironmentCloudCall[] = [];
  const requests: EnvironmentTransportRequest[] = [];
  const responses: TeamEnvironmentCloudResponses = new Map();
  const declarationToggles = new Map<string, AuthnMcpServer["toolToggles"]>();
  const conflictHistory = new Map<string, EnvironmentHistoryResponse>();
  let environments: readonly EnvironmentDescriptorV11[] = [];

  function viewerRole(environmentId: string): "admin" | "editor" | "viewer" {
    const row = environments.find(
      (environment) => environment.environmentId === environmentId,
    );
    const role =
      row?.effectiveRole ??
      (source.kind === "pool" ? source.effectiveRole : null);
    if (role === "owner" || role === "admin") return "admin";
    return role ?? "viewer";
  }
  async function invoke<Method extends keyof HostRpcRegistry & string>(
    method: Method,
    params: RequestOfMethod<HostRpcRegistry, Method>,
  ): Promise<ResponseOfMethod<HostRpcRegistry, Method> | undefined> {
    calls.push({ method, params });
    return handlers[method]?.(params);
  }
  async function listEnvironments(): Promise<EnvironmentDirectoryResult | null> {
    const response = await invoke("environment.list", {});
    if (response === undefined) return null;
    environments = response.environments;
    return { kind: "ok", list: response };
  }
  const readRoutes = new Map<
    string,
    (
      environmentId: string,
      url: URL,
    ) => Promise<EnvironmentTransportAnswer | null>
  >([
    [
      "items",
      async (environmentId, url) => {
        const response = await invoke("environment.configuration.items", {
          environmentId,
        });
        const kind = url.searchParams.get("kind");
        if (kind === "mcp_server" && response === undefined) {
          const servers = await handlers[
            "environment.configuration.mcpServers.list"
          ]?.({ environmentId });
          if (servers === undefined) return null;
          return jsonEnvironmentAnswer({
            items: servers.servers.flatMap((server) =>
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
                      updatedAt: 1,
                      writtenBy: {
                        source: "live",
                        hostId: null,
                        hostName: null,
                      },
                    },
                  ],
            ),
          });
        }
        return response === undefined
          ? null
          : jsonEnvironmentAnswer({
              items: response.items.filter((item) => item.kind === kind),
            });
      },
    ],
    [
      "revision",
      async (environmentId) => {
        const response = await invoke("environment.configuration.revision", {
          environmentId,
        });
        return response === undefined
          ? null
          : jsonEnvironmentAnswer({ revision: response.revision });
      },
    ],
    [
      "mcp-servers",
      async (environmentId) => {
        const response = await invoke(
          "environment.configuration.mcpServers.list",
          { environmentId },
        );
        return response === undefined
          ? null
          : jsonEnvironmentAnswer({
              servers: response.servers.map((server) => {
                const row = authnMcpServer(server);
                return {
                  ...row,
                  toolToggles:
                    declarationToggles.get(
                      JSON.stringify([environmentId, row.id]),
                    ) ?? row.toolToggles,
                };
              }),
            });
      },
    ],
    [
      "secrets",
      async (environmentId) => {
        const response = await invoke("environment.secrets.list", {
          environmentId,
        });
        if (response === undefined) return null;
        return jsonEnvironmentAnswer(authnSecretsList(response));
      },
    ],
    [
      "secrets/harness-connections",
      async (environmentId) => {
        const response = await invoke("environment.plans.list", {
          environmentId,
        });
        if (response === undefined) return null;
        return jsonEnvironmentAnswer({
          connections: response.plans.map((plan) => ({
            profileId: plan.profileId,
            harnessId: plan.harness,
            bindingVersion: plan.bindingVersion ?? null,
            kind: plan.harness === "api_key" ? "api_key" : "harness",
            status: planConnectionStatus(plan.status),
            linkedBy:
              plan.linkedBy === null
                ? null
                : {
                    displayName: plan.linkedBy.name,
                    you: plan.linkedBy.you,
                  },
          })),
        });
      },
    ],
    [
      "hosts",
      async (environmentId, url) => {
        if (!url.searchParams.has("include")) return null;
        const response = await invoke("environment.host.list", {
          environmentId,
        });
        if (response === undefined) return null;
        return jsonEnvironmentAnswer({
          hosts: response.hosts.map((host) => ({
            hostId: host.hostId,
            hostName: host.hostLabel,
            hostPlatform: host.hostPlatform,
            enrolledByUserId: host.enrolledByUserId,
            hostKind: host.kind,
            boundAt: host.boundAt,
            reportedAt: host.lastReportedAt,
            online: host.reachable,
            purgePending: false,
            hasLocalRow: host.hasLocalRow,
            items: host.applied.map((item) => {
              const separator = item.itemKey.indexOf(":");
              return {
                kind:
                  separator < 0
                    ? item.itemKey
                    : item.itemKey.slice(0, separator),
                key: separator < 0 ? "" : item.itemKey.slice(separator + 1),
                status: appliedItemStatus(item.state),
                code: item.reason ?? "ok",
              };
            }),
          })),
        });
      },
    ],
    [
      "history",
      async (environmentId, url) => {
        const subject = url.searchParams.get("subject");
        const separator = subject?.indexOf(":") ?? -1;
        const params = environmentHistoryRequestSchema.parse({
          environmentId,
          subject:
            subject === null
              ? null
              : {
                  kind: subject.slice(0, separator),
                  key: subject.slice(separator + 1),
                },
        });
        const response = await invoke("environment.history", params);
        return jsonEnvironmentAnswer(
          response ??
            conflictHistory.get(`${environmentId}:${subject}`) ?? {
              entries: [],
              readerScope: "full",
              hostStates: [],
            },
        );
      },
    ],
    [
      "members",
      async (environmentId) => {
        const response = await invoke("environment.members", {
          environmentId,
          cursor: null,
        });
        if (response === undefined) return null;
        return jsonEnvironmentAnswer({
          members: response.members.map((member) => ({
            id: member.userId,
            email: member.email ?? "",
            user: {
              id: member.userId,
              name: member.displayName,
              avatarUrl: member.avatarUrl,
            },
            effectiveRole: member.effectiveRole,
            linkedPlan: member.linkedPlan,
            inviteState: member.inviteState ?? "accepted",
            invitedAddress: member.invitedAddress,
          })),
          viewer: {
            effectiveRole: viewerRole(environmentId),
            legacyRoleNoticeSeenAt:
              response.legacyRoleNoticeSeenAt === null
                ? null
                : new Date(response.legacyRoleNoticeSeenAt).toISOString(),
            legacyMembers: response.legacyMembers,
          },
        });
      },
    ],
    [
      "members/seats",
      async (environmentId) => {
        const response = await invoke("environment.members.seats", {
          environmentId,
        });
        return response === undefined ? null : jsonEnvironmentAnswer(response);
      },
    ],
  ]);

  async function onRequest(
    request: EnvironmentTransportRequest,
  ): Promise<EnvironmentTransportAnswer | null> {
    requests.push(request);
    const url = new URL(request.url);
    const response = responses.get(`${request.method} ${url.pathname}`);
    if (response !== undefined) return response(request);
    if (request.method !== "GET") return answerWrite(request);
    const match = /\/api\/v3\/environments\/([^/]+)\/(.+)$/u.exec(url.pathname);
    if (match === null) return null;
    const environmentId = decodeURIComponent(match[1]);
    const route = match[2];
    const read = readRoutes.get(route);
    return read === undefined
      ? answerSecret(request, environmentId, route)
      : read(environmentId, url);
  }

  function itemWriteAnswer(
    params: {
      readonly environmentId: string;
      readonly kind: string;
      readonly key: string;
      readonly os: string | null;
    },
    response: EnvironmentConfigurationItemWriteResponse,
  ): EnvironmentTransportAnswer {
    if (response.outcome === "forbidden") return { status: 403, text: "{}" };
    if (response.outcome === "saved") {
      if (response.revision === null) return { status: 204, text: "" };
      return jsonEnvironmentAnswer({
        item: null,
        replayed: false,
        revision: response.revision,
      });
    }
    const current = response.current;
    if (current === null)
      return {
        status: 409,
        text: JSON.stringify({ code: "revision_conflict", current: null }),
      };
    // The protocol fixture's conflict combines the row and its history actor;
    // authn sends those in separate answers, both read by the real consumer.
    conflictHistory.set(
      `${params.environmentId}:${params.kind}:${params.key}`,
      {
        entries: [
          {
            at: current.changedAt,
            actor:
              current.changedBy === null
                ? null
                : {
                    label: current.changedBy,
                    tombstoned: false,
                  },
            operation: "put",
            outcome: "saved",
          },
        ],
        readerScope: "full",
        hostStates: [],
      },
    );
    return {
      status: 409,
      text: JSON.stringify({
        code: "revision_conflict",
        current: {
          kind: params.kind,
          key: params.key,
          os: params.os,
          value: null,
          revision: current.revision,
          updatedAt: current.changedAt,
          writtenBy: { source: "live", hostId: null, hostName: null },
        },
      }),
    };
  }

  const memberWrites = new Map<
    string,
    (
      environmentId: string,
      body: Record<string, unknown>,
    ) => Promise<EnvironmentTransportAnswer | null>
  >([
    [
      "members/notice-seen",
      async (environmentId) => {
        const response = await invoke("environment.members.noticeSeen", {
          environmentId,
        });
        return response === undefined
          ? null
          : jsonEnvironmentAnswer({
              legacyRoleNoticeSeenAt: "2026-11-15T00:00:00.000Z",
            });
      },
    ],
    [
      "members",
      async (environmentId, body) => {
        const member = z
          .object({
            members: z
              .array(z.object({ email: z.string(), role: z.string() }))
              .length(1),
          })
          .parse(body).members[0];
        const response = await invoke(
          "environment.members.invite",
          environmentMembersInviteRequestSchema.parse({
            environmentId,
            email: member.email,
            role: member.role.toLowerCase(),
          }),
        );
        if (response === undefined) return null;
        if (response.outcome === "forbidden")
          return { status: 403, text: "{}" };
        if (response.outcome === "seat_limit")
          return { status: 409, text: JSON.stringify({ code: "seat_limit" }) };
        return jsonEnvironmentAnswer({});
      },
    ],
    [
      "members/seats",
      async (environmentId, body) => {
        const member = z
          .object({
            members: z
              .array(
                z.object({
                  id: z.string(),
                  role: z.string().optional(),
                  remove: z.boolean().optional(),
                }),
              )
              .length(1),
          })
          .parse(body).members[0];
        const response =
          member.remove === true
            ? await invoke("environment.members.remove", {
                environmentId,
                userId: member.id,
              })
            : await invoke(
                "environment.members.setRole",
                environmentMembersSetRoleRequestSchema.parse({
                  environmentId,
                  userId: member.id,
                  role: member.role?.toLowerCase(),
                }),
              );
        if (response === undefined) return null;
        if (response.outcome === "forbidden")
          return { status: 403, text: "{}" };
        if (response.outcome === "last_admin")
          return { status: 409, text: JSON.stringify({ code: "last_admin" }) };
        if (response.outcome === "plan_required")
          return {
            status: 404,
            text: JSON.stringify({ code: "subscription_not_found" }),
          };
        return jsonEnvironmentAnswer({
          receiptId: response.outcome === "pending" ? response.receiptId : null,
        });
      },
    ],
    [
      "members/removal-preview",
      async (environmentId, body) => {
        const memberIds = z
          .object({ memberIds: z.array(z.string()).length(1) })
          .parse(body).memberIds;
        const response = await invoke("environment.members.removePreview", {
          environmentId,
          userId: memberIds[0] ?? "",
        });
        return response === undefined
          ? null
          : jsonEnvironmentAnswer({
              sandboxesToRekey: response.paidSandboxes.length,
            });
      },
    ],
  ]);
  async function answerItemWrite(
    request: EnvironmentTransportRequest,
    environmentId: string,
    route: string,
    body: Record<string, unknown>,
  ): Promise<EnvironmentTransportAnswer | null> {
    const kind = decodeURIComponent(route.slice("items/".length));
    if (request.method === "PUT") {
      const params = environmentConfigurationItemPutRequestSchema.parse({
        environmentId,
        kind,
        ...body,
      });
      const response = await invoke(
        "environment.configuration.items.put",
        params,
      );
      return response === undefined ? null : itemWriteAnswer(params, response);
    }
    if (request.method === "DELETE") {
      const params = environmentConfigurationItemDeleteRequestSchema.parse({
        environmentId,
        kind,
        ...body,
      });
      const response = await invoke(
        "environment.configuration.items.delete",
        params,
      );
      return response === undefined ? null : itemWriteAnswer(params, response);
    }

    return null;
  }

  async function answerMcpWrite(
    request: EnvironmentTransportRequest,
    environmentId: string,
    route: string,
    body: Record<string, unknown>,
  ): Promise<EnvironmentTransportAnswer | null> {
    if (
      route.startsWith("mcp-servers/") &&
      request.method === "PATCH" &&
      Object.keys(body).length === 1 &&
      "toolToggles" in body
    ) {
      const serverId = decodeURIComponent(route.slice("mcp-servers/".length));
      declarationToggles.set(
        JSON.stringify([environmentId, serverId]),
        z
          .record(z.string(), z.record(z.string(), z.boolean()))
          .parse(body.toolToggles),
      );
      return jsonEnvironmentAnswer({});
    }
    if (route.startsWith("mcp-servers/") && request.method === "DELETE") {
      const response = await invoke(
        "environment.configuration.mcpServers.delete",
        {
          environmentId,
          serverId: decodeURIComponent(route.slice("mcp-servers/".length)),
        },
      );
      if (response === undefined) return null;
      if (response.outcome === "forbidden") return { status: 403, text: "{}" };
      if (response.outcome === "refused")
        return { status: 400, text: JSON.stringify({ code: response.reason }) };
      declarationToggles.delete(
        JSON.stringify([
          environmentId,
          decodeURIComponent(route.slice("mcp-servers/".length)),
        ]),
      );
      return jsonEnvironmentAnswer({ deleted: true });
    }

    return null;
  }

  async function answerPolicyWrite(
    environmentId: string,
    body: Record<string, unknown>,
  ): Promise<EnvironmentTransportAnswer | null> {
    const response = await invoke(
      "environment.configuration.policy.put",
      environmentConfigurationPolicyPutRequestSchema.parse({
        environmentId,
        ...body,
      }),
    );
    if (response === undefined) return null;
    if (response.outcome === "forbidden") return { status: 403, text: "{}" };
    if (response.outcome === "refused")
      return { status: 400, text: JSON.stringify({ code: response.reason }) };
    return jsonEnvironmentAnswer({});
  }

  async function answerPlanWrite(
    environmentId: string,
    route: string,
    body: Record<string, unknown>,
  ): Promise<EnvironmentTransportAnswer | null> {
    const response = await invoke("environment.plans.unlink", {
      environmentId,
      profileId: decodeURIComponent(
        route.slice("secrets/harness-connections/".length),
      ),
      expectedBindingVersion: z
        .number()
        .int()
        .nullable()
        .parse(body.expectedBindingVersion),
    });
    if (response === undefined) return null;
    if (response.outcome === "forbidden") return { status: 403, text: "{}" };
    return jsonEnvironmentAnswer({
      disconnected: response.outcome === "unlinked",
    });
  }

  async function answerWrite(
    request: EnvironmentTransportRequest,
  ): Promise<EnvironmentTransportAnswer | null> {
    const url = new URL(request.url);
    const match = /\/api\/v3\/environments\/([^/]+)\/(.+)$/u.exec(url.pathname);
    if (match === null) return null;
    const environmentId = decodeURIComponent(match[1]);
    const route = match[2];
    const body =
      request.body === null
        ? {}
        : z.record(z.string(), z.unknown()).parse(request.body);
    if (route.startsWith("items/"))
      return answerItemWrite(request, environmentId, route, body);
    if (route.startsWith("mcp-servers/"))
      return answerMcpWrite(request, environmentId, route, body);
    if (route === "policy" && request.method === "PUT")
      return answerPolicyWrite(environmentId, body);
    if (
      route.startsWith("secrets/harness-connections/") &&
      request.method === "DELETE"
    )
      return answerPlanWrite(environmentId, route, body);
    const memberWrite = memberWrites.get(route);
    if (memberWrite !== undefined && request.method === "POST")
      return memberWrite(environmentId, body);
    return answerSecret(request, environmentId, route);
  }

  const secretRoutes = new Map<
    string,
    (context: {
      readonly environmentId: string;
      readonly secretId: string;
      readonly versionId: string;
      readonly route: string;
      readonly body: Record<string, unknown>;
    }) => Promise<EnvironmentTransportAnswer | null>
  >([
    [
      "POST:create",
      async ({ environmentId, body }) => {
        const response = await invoke(
          "environment.secrets.create",
          environmentSecretsCreateRequestSchemaV11.parse({
            ...body,
            environmentId,
            ...RETIRED_SECRET_CREATE_FIELDS,
            plaintextConsent:
              body.plaintextConsent === true
                ? { disclosureVersion: SANDBOX_PLAINTEXT_DISCLOSURE_VERSION }
                : null,
          }),
        );
        if (response === undefined) return null;
        if (response.outcome === "refused")
          return { status: 422, text: JSON.stringify({ code: response.code }) };
        if (response.outcome !== "created")
          throw new Error(
            `authn create fixture cannot answer ${response.outcome}`,
          );
        return jsonEnvironmentAnswer({ secret: authnSecret(response.secret) });
      },
    ],
    [
      "POST:verify",
      async ({ environmentId, body, route, secretId }) => {
        const params = environmentSecretsVerifyRequestSchemaV11.parse(
          route === "secrets/verify"
            ? { ...body, environmentId, target: "candidate" }
            : { environmentId, target: "secret", secretId },
        );
        const response = await invoke("environment.secrets.verify", params);
        return response === undefined ? null : jsonEnvironmentAnswer(response);
      },
    ],
    [
      "PATCH:value",
      async ({ environmentId, secretId, body }) => {
        const response = await invoke(
          "environment.secrets.replaceValue",
          environmentSecretsReplaceValueRequestSchemaV11.parse({
            ...body,
            environmentId,
            secretId,
          }),
        );
        if (response === undefined) return null;
        if (response.outcome === "stale")
          return {
            status: 409,
            text: JSON.stringify({
              code: "secret_version_stale",
              currentVersionId: response.currentVersionId,
              changedBy: response.changedBy,
            }),
          };
        if (response.outcome !== "accepted")
          throw new Error(
            `authn replace fixture cannot answer ${response.outcome}`,
          );
        return jsonEnvironmentAnswer({
          rotation: {
            rotationId: response.rotationId,
            versionId: response.versionId,
          },
        });
      },
    ],
    [
      "POST:undo",
      async ({ environmentId, secretId, body, versionId }) => {
        const response = await invoke(
          "environment.secrets.undo",
          environmentSecretsUndoRequestSchemaV11.parse({
            ...body,
            environmentId,
            secretId,
            versionId,
          }),
        );
        return response === undefined ? null : jsonEnvironmentAnswer(response);
      },
    ],
    [
      "POST:consent",
      async ({ environmentId, secretId, body }) => {
        const response = await invoke(
          "environment.secrets.consent",
          environmentSecretsConsentRequestSchemaV11.parse({
            ...body,
            environmentId,
            secretId,
            disclosure: "plaintext_gateway",
            scope: "secret",
          }),
        );
        return response === undefined ? null : jsonEnvironmentAnswer(response);
      },
    ],
    [
      "GET:versions",
      async ({ environmentId, secretId }) => {
        const response = await invoke("environment.secrets.versions", {
          environmentId,
          secretId,
        });
        return response === undefined ? null : jsonEnvironmentAnswer(response);
      },
    ],
    [
      "GET:rotation",
      async ({ environmentId, secretId }) => {
        const response = await invoke("environment.secrets.rotation", {
          environmentId,
          secretId,
        });
        return response === undefined ? null : jsonEnvironmentAnswer(response);
      },
    ],
    [
      "POST:destroy",
      async ({ environmentId, secretId, versionId }) => {
        const response = await invoke("environment.secrets.destroy", {
          environmentId,
          secretId,
          versionId,
        });
        return response === undefined ? null : jsonEnvironmentAnswer(response);
      },
    ],
  ]);

  async function answerSecret(
    request: EnvironmentTransportRequest,
    environmentId: string,
    route: string,
  ): Promise<EnvironmentTransportAnswer | null> {
    if (route !== "secrets" && !route.startsWith("secrets/")) return null;
    const parts = route.split("/").map(decodeURIComponent);
    let action = parts[2] ?? "value";
    if (route === "secrets") action = "create";
    if (route === "secrets/verify") action = "verify";
    if (action === "versions" && request.method === "POST")
      action = parts[4] ?? "";
    const respond = secretRoutes.get(`${request.method}:${action}`);
    if (respond === undefined) return null;
    return respond({
      environmentId,
      secretId: parts[1] ?? "",
      versionId: parts[3] ?? "",
      route,
      body:
        request.body === null
          ? {}
          : z.record(z.string(), z.unknown()).parse(request.body),
    });
  }

  return { calls, requests, responses, onRequest, listEnvironments };
}
