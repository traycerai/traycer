import { buildStreamManifest } from "@traycer/protocol/framework/stream-compat";
import {
  clientStreamOpenFrameSchema,
  clientStreamSubscribeFrameSchema,
  hostStreamFatalErrorFrameSchema,
  hostStreamOpenAckFrameSchema,
  type HostStreamFatalErrorFrame,
  type HostStreamOpenAckFrame,
} from "@traycer/protocol/framework/stream-ws-protocol";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { acceptBearer } from "./identity";

export type StreamWebSocket = {
  readonly data: {
    opened: boolean;
  };
  send: (data: string) => void;
  close: () => void;
};

const STREAM_MANIFEST = buildStreamManifest(hostStreamRpcRegistry);

export function handleStreamMessage(
  ws: StreamWebSocket,
  message: string | ArrayBuffer | Uint8Array,
): void {
  let payload: unknown;
  try {
    payload = JSON.parse(textFromMessage(message));
  } catch {
    sendFatalAndClose(ws, "RPC_ERROR", "invalid client frame");
    return;
  }

  if (!ws.data.opened) {
    handleFirstFrame(ws, payload);
    return;
  }

  handleOpenedFrame(ws, payload);
}

function handleFirstFrame(ws: StreamWebSocket, payload: unknown): void {
  const parsed = clientStreamOpenFrameSchema.safeParse(payload);
  if (!parsed.success) {
    sendFatalAndClose(ws, "RPC_ERROR", "invalid client frame");
    return;
  }
  const identity = acceptBearer(parsed.data.token);
  if (identity === null) {
    sendFatalAndClose(ws, "UNAUTHORIZED", "missing bearer");
    return;
  }
  sendOpenAck(ws);
  ws.data.opened = true;
}

function handleOpenedFrame(ws: StreamWebSocket, payload: unknown): void {
  if (clientStreamOpenFrameSchema.safeParse(payload).success) {
    sendFatalAndClose(ws, "RPC_ERROR", "connection already opened");
    return;
  }
  if (readKind(payload) === "fatalError") {
    ws.close();
    return;
  }
  const subscribe = clientStreamSubscribeFrameSchema.safeParse(payload);
  if (subscribe.success) {
    sendFatalAndClose(ws, "E_HOST_UNSUPPORTED", subscribe.data.method);
    return;
  }
  sendFatalAndClose(ws, "RPC_ERROR", "unsupported stream frame");
}

function sendOpenAck(ws: StreamWebSocket): void {
  const frame: HostStreamOpenAckFrame = {
    kind: "openAck",
    manifest: STREAM_MANIFEST,
    capabilities: [],
    hostCredentialState: null,
  };
  ws.send(JSON.stringify(hostStreamOpenAckFrameSchema.parse(frame)));
}

function sendFatalAndClose(
  ws: StreamWebSocket,
  code: string,
  reason: string,
): void {
  const frame: HostStreamFatalErrorFrame = {
    kind: "fatalError",
    details: {
      code,
      reason,
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  };
  ws.send(JSON.stringify(hostStreamFatalErrorFrameSchema.parse(frame)));
  ws.close();
}

function textFromMessage(
  message: string | ArrayBuffer | Uint8Array,
): string {
  if (typeof message === "string") {
    return message;
  }
  return new TextDecoder().decode(message);
}

function readKind(value: unknown): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  if (!("kind" in value)) {
    return null;
  }
  const kind: unknown = value.kind;
  return typeof kind === "string" ? kind : null;
}
