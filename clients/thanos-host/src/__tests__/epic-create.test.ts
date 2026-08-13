import { afterEach, describe, expect, it } from "vitest";
import { MutableBearerLease } from "@traycer-clients/shared/auth/bearer-source";
import type { HostRequestAuthority } from "@traycer-clients/shared/host-transport/host-messenger";
import { WsRpcClient } from "@traycer-clients/shared/host-transport/ws-rpc-client";
import { createWhatwgWebSocketFactory } from "@traycer-clients/shared/host-transport/whatwg-ws-factory";
import {
  createEpicResponseSchema,
  listTasksResponseSchema,
  type CreateEpicRequest,
} from "@traycer/protocol/host/epic/unary-schemas";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import type { ListeningRpcServer } from "../rpc-server";
import { startLoopbackRpc } from "./loopback-rpc";

const CREATE_EPIC_REQUEST: CreateEpicRequest = {
  epic: {
    id: "thanos-epic-1",
    title: "Thanos local epic",
    initialUserPrompt: "create a local epic",
    ticketCount: 0,
    specCount: 0,
    storyCount: 0,
    reviewCount: 0,
    status: "draft",
    createdAt: 0,
    updatedAt: 0,
    createdBy: "thanos-local",
    version: "2.0.0",
  },
  repoIdentifiers: [],
  workspaces: [],
  chat: null,
};

const LIST_CLOUD_TASKS_REQUEST = {
  limit: 20,
  filters: null,
  sort: "recent",
  extensionPhaseVersion: "1.0.0",
  extensionEpicVersion: "2.0.0",
} as const;

let listening: ListeningRpcServer | null = null;

afterEach(() => {
  listening?.stop();
  listening = null;
});

describe("epic.create", () => {
  it("echoes the request epic id and lists it afterward", async () => {
    const server = await startLoopbackRpc();
    listening = server;
    const lease = new MutableBearerLease("thanos-test-token", "thanos-local");
    const client = new WsRpcClient({
      registry: hostRpcRegistry,
      requestId: () => crypto.randomUUID(),
      webSocketFactory: createWhatwgWebSocketFactory(),
      dialTimeoutMs: 5_000,
      frameTimeoutMs: 5_000,
      hostAttestationWindowMs: 0,
    });
    const authority: HostRequestAuthority = {
      endpoint: {
        hostId: "thanos-local",
        websocketUrl: `ws://127.0.0.1:${server.port}/rpc`,
      },
      bearer: lease,
      abortSignal: new AbortController().signal,
    };

    const created = createEpicResponseSchema.parse(
      await client.requestWithResponseTimeout(
        "epic.create",
        CREATE_EPIC_REQUEST,
        5_000,
        authority,
      ),
    );

    expect(created.task?.epic?.light?.id).toBe("thanos-epic-1");

    const listed = listTasksResponseSchema.parse(
      await client.requestWithResponseTimeout(
        "epic.listTasks",
        LIST_CLOUD_TASKS_REQUEST,
        5_000,
        authority,
      ),
    );

    expect(listed.tasks.map((row) => row.epic?.light?.id)).toContain(
      "thanos-epic-1",
    );
  });
});
