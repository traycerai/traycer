import { afterEach, describe, expect, it } from "vitest";
import { MutableBearerLease } from "@traycer-clients/shared/auth/bearer-source";
import type { HostRequestAuthority } from "@traycer-clients/shared/host-transport/host-messenger";
import { WsRpcClient } from "@traycer-clients/shared/host-transport/ws-rpc-client";
import { createWhatwgWebSocketFactory } from "@traycer-clients/shared/host-transport/whatwg-ws-factory";
import { listTasksResponseSchema } from "@traycer/protocol/host/epic/unary-schemas";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import type { ListeningRpcServer } from "../rpc-server";
import { startLoopbackRpc } from "./loopback-rpc";

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

describe("epic.listTasks", () => {
  it("returns an empty catalog after handshake", async () => {
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

    const result = await client.requestWithResponseTimeout(
      "epic.listTasks",
      LIST_CLOUD_TASKS_REQUEST,
      5_000,
      authority,
    );

    expect(listTasksResponseSchema.parse(result)).toEqual({
      tasks: [],
      hasMore: false,
    });
  });
});
