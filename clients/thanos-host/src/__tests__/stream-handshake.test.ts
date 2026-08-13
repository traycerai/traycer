import { afterEach, describe, expect, it } from "vitest";
import { buildStreamManifest } from "@traycer/protocol/framework/stream-compat";
import {
  hostStreamFatalErrorFrameSchema,
  hostStreamOpenAckFrameSchema,
} from "@traycer/protocol/framework/stream-ws-protocol";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
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

describe("local /stream handshake", () => {
  it("accepts a bearer and replies openAck with the stream registry manifest", async () => {
    const server = await startLoopbackRpc();
    listening = server;
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/stream`);
    await waitForWebSocketOpen(ws);
    const firstFrame = waitForTextFrame(ws);
    ws.send(
      JSON.stringify({
        kind: "open",
        token: "thanos-test-token",
        manifest: {},
      }),
    );

    const parsed = hostStreamOpenAckFrameSchema.parse(
      JSON.parse(await firstFrame),
    );
    expect(parsed.kind).toBe("openAck");
    expect(parsed.manifest).toEqual(buildStreamManifest(hostStreamRpcRegistry));
    expect(parsed.manifest["epic.subscribe"]).toBeDefined();
    expect(parsed.capabilities).toEqual([]);
    expect(parsed.hostCredentialState).toBe(null);
    ws.close();
  });

  it("rejects an empty open token with fatalError UNAUTHORIZED", async () => {
    const server = await startLoopbackRpc();
    listening = server;
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/stream`);
    await waitForWebSocketOpen(ws);
    const firstFrame = waitForTextFrame(ws);
    ws.send(JSON.stringify({ kind: "open", token: "", manifest: {} }));

    const parsed = hostStreamFatalErrorFrameSchema.parse(
      JSON.parse(await firstFrame),
    );
    expect(parsed.kind).toBe("fatalError");
    expect(parsed.details.code).toBe("UNAUTHORIZED");
    expect(parsed.details.reason).toBe("missing bearer");
    ws.close();
  });

  it("rejects subscribe after openAck with E_HOST_UNSUPPORTED", async () => {
    const server = await startLoopbackRpc();
    listening = server;
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/stream`);
    await waitForWebSocketOpen(ws);
    const ackFrame = waitForTextFrame(ws);
    ws.send(
      JSON.stringify({
        kind: "open",
        token: "thanos-test-token",
        manifest: {},
      }),
    );
    const ack = hostStreamOpenAckFrameSchema.parse(JSON.parse(await ackFrame));
    expect(ack.kind).toBe("openAck");

    const fatalFrame = waitForTextFrame(ws);
    ws.send(
      JSON.stringify({
        kind: "subscribe",
        method: "epic.subscribe",
        schemaVersion: { major: 1, minor: 0 },
        params: {},
      }),
    );
    const parsed = hostStreamFatalErrorFrameSchema.parse(
      JSON.parse(await fatalFrame),
    );
    expect(parsed.kind).toBe("fatalError");
    expect(parsed.details.code).toBe("E_HOST_UNSUPPORTED");
    ws.close();
  });
});
