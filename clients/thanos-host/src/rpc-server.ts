import {
  clientFrameSchema,
  hostFrameSchema,
  type ClientFrame,
  type HostFrame,
} from "@traycer/protocol/framework/ws-protocol";
import { acceptBearer } from "./identity";
import { thanosHostManifest } from "./manifest";
import { dispatchRpc } from "./handlers";

export type StartRpcServerOptions = {
  readonly hostname: string;
  readonly port: number;
};

export type ListeningRpcServer = {
  readonly url: string;
  readonly port: number;
  readonly stop: () => void;
};

type ConnectionState = {
  opened: boolean;
};

type RpcWebSocket = {
  readonly data: ConnectionState;
  send: (data: string) => void;
  close: () => void;
};

type BunUpgradeServer = {
  upgrade: (request: Request, options: { data: ConnectionState }) => boolean;
};

type BunServeResult = {
  readonly port: number;
  stop: (closeActiveConnections: boolean | undefined) => void;
};

type BunRuntime = {
  serve: (options: {
    hostname: string;
    port: number;
    fetch: (
      request: Request,
      server: BunUpgradeServer,
    ) => Response | undefined;
    websocket: {
      message: (
        ws: RpcWebSocket,
        message: string | ArrayBuffer | Uint8Array,
      ) => void;
    };
  }) => BunServeResult;
};

const LOOPBACK_HOST = "127.0.0.1";

export function startRpcServer(
  options: StartRpcServerOptions,
): ListeningRpcServer {
  if (options.hostname !== LOOPBACK_HOST) {
    throw new Error(
      `Refusing to bind ${options.hostname}; Thanos host listens on ${LOOPBACK_HOST} only`,
    );
  }

  const bun = readBunRuntime();
  const server = bun.serve({
    hostname: LOOPBACK_HOST,
    port: options.port,
    fetch: (request, upgradeServer) => {
      const url = new URL(request.url);
      if (url.pathname !== "/rpc") {
        return new Response("Not Found", { status: 404 });
      }
      const upgraded = upgradeServer.upgrade(request, {
        data: { opened: false },
      });
      if (!upgraded) {
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      return undefined;
    },
    websocket: {
      message: (ws, message) => {
        handleRpcMessage(ws, message);
      },
    },
  });

  return {
    url: `ws://${LOOPBACK_HOST}:${server.port}/rpc`,
    port: server.port,
    stop: () => {
      server.stop(true);
    },
  };
}

function handleRpcMessage(
  ws: RpcWebSocket,
  message: string | ArrayBuffer | Uint8Array,
): void {
  let frame: ClientFrame;
  try {
    frame = clientFrameSchema.parse(JSON.parse(textFromMessage(message)));
  } catch {
    sendFatalAndClose(ws, "RPC_ERROR", "invalid client frame");
    return;
  }

  if (frame.kind === "fatalError") {
    ws.close();
    return;
  }

  if (frame.kind === "open") {
    handleOpen(ws, frame.token);
    return;
  }

  handleRequest(ws, frame);
}

function handleOpen(ws: RpcWebSocket, token: string): void {
  if (ws.data.opened) {
    sendFatalAndClose(ws, "RPC_ERROR", "connection already opened");
    return;
  }
  const identity = acceptBearer(token);
  if (identity === null) {
    sendFatalAndClose(ws, "UNAUTHORIZED", "missing bearer");
    return;
  }
  const split = thanosHostManifest();
  sendHostFrame(ws, {
    kind: "openAck",
    manifest: split.manifest,
    optionalManifest: split.optionalManifest,
  });
  ws.data.opened = true;
}

function handleRequest(
  ws: RpcWebSocket,
  frame: Extract<ClientFrame, { kind: "request" }>,
): void {
  if (!ws.data.opened) {
    sendFatalAndClose(ws, "RPC_ERROR", "expected open frame");
    return;
  }
  const dispatched = dispatchRpc(
    frame.method,
    frame.schemaVersion,
    frame.params,
  );
  sendHostFrame(ws, {
    kind: "response",
    requestId: frame.requestId,
    method: frame.method,
    schemaVersion: frame.schemaVersion,
    result: dispatched.result,
    error: dispatched.error,
  });
}

function sendFatalAndClose(
  ws: RpcWebSocket,
  code: string,
  reason: string,
): void {
  sendHostFrame(ws, {
    kind: "fatalError",
    details: {
      code,
      reason,
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  });
  ws.close();
}

function sendHostFrame(ws: RpcWebSocket, frame: HostFrame): void {
  ws.send(JSON.stringify(hostFrameSchema.parse(frame)));
}

function textFromMessage(
  message: string | ArrayBuffer | Uint8Array,
): string {
  if (typeof message === "string") {
    return message;
  }
  return new TextDecoder().decode(message);
}

function readBunRuntime(): BunRuntime {
  const bunValue: unknown = Reflect.get(globalThis, "Bun");
  if (typeof bunValue !== "object" || bunValue === null) {
    throw new Error("Thanos host requires the Bun runtime");
  }
  const serve: unknown = Reflect.get(bunValue, "serve");
  if (typeof serve !== "function") {
    throw new Error("Thanos host requires Bun.serve");
  }
  return bunValue as BunRuntime;
}
