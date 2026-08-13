import { afterEach, describe, expect, it } from "vitest";
import { MutableBearerLease } from "@traycer-clients/shared/auth/bearer-source";
import type { HostRequestAuthority } from "@traycer-clients/shared/host-transport/host-messenger";
import { WsRpcClient } from "@traycer-clients/shared/host-transport/ws-rpc-client";
import { createWhatwgWebSocketFactory } from "@traycer-clients/shared/host-transport/whatwg-ws-factory";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { hostFrameSchema } from "@traycer/protocol/framework/ws-protocol";
import type { ListeningRpcServer } from "../rpc-server";
import { startLoopbackRpc } from "./loopback-rpc";

let listening: ListeningRpcServer | null = null;

afterEach(() => {
  listening?.stop();
  listening = null;
});

function waitForWebSocketOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new Error("WebSocket error before open"));
    };
    const cleanup = (): void => {
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
    };
    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
  });
}

function waitForTextFrame(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent): void => {
      cleanup();
      const data: unknown = event.data;
      resolve(typeof data === "string" ? data : String(data));
    };
    const onError = (): void => {
      cleanup();
      reject(new Error("WebSocket error while waiting for a frame"));
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("WebSocket closed before a frame arrived"));
    };
    const cleanup = (): void => {
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onClose);
    };
    ws.addEventListener("message", onMessage);
    ws.addEventListener("error", onError);
    ws.addEventListener("close", onClose);
  });
}

describe("local /rpc handshake", () => {
  it("accepts a bearer and answers host.status through WsRpcClient", async () => {
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

    const status = await client.requestWithResponseTimeout(
      "host.status",
      {},
      5_000,
      authority,
    );

    expect(status.ready).toBe(true);
    expect(status.hostVersion.length).toBeGreaterThan(0);
    expect(status.busy).toBe(false);
  });

  it("rejects an empty open token with fatalError UNAUTHORIZED", async () => {
    const server = await startLoopbackRpc();
    listening = server;
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/rpc`);
    await waitForWebSocketOpen(ws);
    const firstFrame = waitForTextFrame(ws);
    ws.send(JSON.stringify({ kind: "open", token: "", manifest: {} }));

    const parsed = hostFrameSchema.parse(JSON.parse(await firstFrame));
    expect(parsed.kind).toBe("fatalError");
    if (parsed.kind !== "fatalError") {
      throw new Error("expected fatalError frame");
    }
    expect(parsed.details.code).toBe("UNAUTHORIZED");
    ws.close();
  });

  it("omits busy fields when host.status is requested at 1.0", async () => {
    const server = await startLoopbackRpc();
    listening = server;
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/rpc`);
    await waitForWebSocketOpen(ws);
    const ackFrame = waitForTextFrame(ws);
    ws.send(
      JSON.stringify({
        kind: "open",
        token: "thanos-test-token",
        manifest: {},
      }),
    );
    const ack = hostFrameSchema.parse(JSON.parse(await ackFrame));
    expect(ack.kind).toBe("openAck");

    const responseFrame = waitForTextFrame(ws);
    ws.send(
      JSON.stringify({
        kind: "request",
        requestId: "status-v10",
        method: "host.status",
        schemaVersion: { major: 1, minor: 0 },
        params: {},
      }),
    );
    const response = hostFrameSchema.parse(JSON.parse(await responseFrame));
    expect(response.kind).toBe("response");
    if (response.kind !== "response") {
      throw new Error("expected response frame");
    }
    expect(response.error).toBeNull();
    expect(response.result).toEqual({
      ready: true,
      hostVersion: "0.0.0-thanos",
      protocolVersion: { major: 1, minor: 1 },
    });
    ws.close();
  });
});
