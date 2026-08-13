import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { MutableBearerLease } from "@traycer-clients/shared/auth/bearer-source";
import type { HostRequestAuthority } from "@traycer-clients/shared/host-transport/host-messenger";
import { WsRpcClient } from "@traycer-clients/shared/host-transport/ws-rpc-client";
import { createWhatwgWebSocketFactory } from "@traycer-clients/shared/host-transport/whatwg-ws-factory";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { hostFrameSchema } from "@traycer/protocol/framework/ws-protocol";
import {
  startRpcServer,
  type ListeningRpcServer,
} from "../rpc-server";

const WORKER_ADVERTISE_TIMEOUT_MS = 10_000;

let listening: ListeningRpcServer | null = null;

afterEach(() => {
  listening?.stop();
  listening = null;
});

function hasBunServe(): boolean {
  const bunValue: unknown = Reflect.get(globalThis, "Bun");
  if (typeof bunValue !== "object" || bunValue === null) {
    return false;
  }
  return typeof Reflect.get(bunValue, "serve") === "function";
}

async function startLoopbackRpc(): Promise<ListeningRpcServer> {
  listening = hasBunServe()
    ? startRpcServer({ hostname: "127.0.0.1", port: 0 })
    : await startRpcServerInBunWorker();
  return listening;
}

type AdvertisedServer = {
  readonly url: string;
  readonly port: number;
};

async function startRpcServerInBunWorker(): Promise<ListeningRpcServer> {
  const rpcServerPath = fileURLToPath(new URL("../rpc-server.ts", import.meta.url));
  const script = [
    `import { startRpcServer } from ${JSON.stringify(rpcServerPath)};`,
    "const listening = startRpcServer({",
    '  hostname: "127.0.0.1",',
    "  port: 0,",
    "});",
    'process.stdout.write(JSON.stringify({ url: listening.url, port: listening.port }) + "\\n");',
  ].join("\n");

  const child = spawn("bun", ["-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  const advertised = await readChildAdvertisement(child);
  return {
    url: advertised.url,
    port: advertised.port,
    stop: () => {
      child.kill("SIGTERM");
    },
  };
}

function readChildAdvertisement(child: ChildProcess): Promise<AdvertisedServer> {
  return new Promise((resolve, reject) => {
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (stdout === null || stderr === null) {
      reject(new Error("Thanos host worker is missing stdio pipes"));
      return;
    }

    let stdoutText = "";
    let stderrText = "";
    let settled = false;

    const settle = (next: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      stdout.off("data", onStdout);
      stderr.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
      next();
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      settle(() => {
        reject(
          new Error(
            `Timed out starting Thanos host worker: ${stderrText.trim()}`,
          ),
        );
      });
    }, WORKER_ADVERTISE_TIMEOUT_MS);

    const onStdout = (chunk: Buffer | string): void => {
      stdoutText += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const newline = stdoutText.indexOf("\n");
      if (newline === -1) {
        return;
      }
      const line = stdoutText.slice(0, newline);
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (cause) {
        settle(() => {
          reject(
            new Error(`Invalid Thanos host worker advertisement: ${line}`, {
              cause,
            }),
          );
        });
        return;
      }
      if (!isAdvertisedServer(parsed)) {
        settle(() => {
          reject(
            new Error(`Invalid Thanos host worker advertisement: ${line}`),
          );
        });
        return;
      }
      const advertised = parsed;
      settle(() => {
        resolve(advertised);
      });
    };

    const onStderr = (chunk: Buffer | string): void => {
      stderrText += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    };

    const onError = (cause: Error): void => {
      settle(() => {
        reject(new Error("Failed to spawn Thanos host worker", { cause }));
      });
    };

    const onExit = (code: number | null, signal: string | null): void => {
      settle(() => {
        reject(
          new Error(
            `Thanos host worker exited before advertising (code=${String(code)}, signal=${String(signal)}): ${stderrText.trim()}`,
          ),
        );
      });
    };

    stdout.on("data", onStdout);
    stderr.on("data", onStderr);
    child.on("error", onError);
    child.on("exit", onExit);
  });
}

function isAdvertisedServer(value: unknown): value is AdvertisedServer {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("url" in value) || !("port" in value)) {
    return false;
  }
  return typeof value.url === "string" && typeof value.port === "number";
}

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
