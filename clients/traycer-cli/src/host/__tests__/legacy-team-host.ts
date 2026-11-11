import { MutableBearerLease } from "@traycer-clients/shared/auth/bearer-source";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { WsRpcClient } from "@traycer-clients/shared/host-transport/ws-rpc-client";
import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { WebSocketLike } from "@traycer-clients/shared/host-transport/ws-factory";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";
import { clientFrameSchema } from "@traycer/protocol/framework/ws-protocol";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/registry";
import type { HostRpcDispatch } from "../../internal/host-rpc";

export const LEGACY_TEAM = {
  environmentId: "environment-acme",
  ownerKind: "organization",
  ownerId: "organization-acme",
  roomId: "room-acme",
  label: "Acme",
  effectiveRole: "editor",
  kind: "team",
  hostCount: 0,
  providerHandle: "acme",
} as const;

/** Only the handshake is fake: the production transport owns the pre-send gate. */
export class LegacyTeamHost {
  readonly requests: string[] = [];
  private readonly client = new WsRpcClient({
    clientIdentity: TEST_CLIENT_IDENTITY,
    registry: hostRpcRegistry,
    requestId: () => "legacy-team-host",
    dialTimeoutMs: 1_000,
    frameTimeoutMs: 1_000,
    hostAttestationWindowMs: 0,
    evidence: NO_TRANSPORT_EVIDENCE,
    webSocketFactory: {
      create: () => {
        const socket: WebSocketLike = {
          onopen: null,
          onmessage: null,
          onerror: null,
          onclose: null,
          close: () => undefined,
          send: (data) => {
            const frame = clientFrameSchema.parse(JSON.parse(data));
            if (frame.kind === "request") {
              this.requests.push(frame.method);
              throw new Error("A request reached a host that cannot transfer.");
            }
            if (frame.kind !== "open") return;
            queueMicrotask(() => {
              socket.onmessage?.({
                data: JSON.stringify({
                  kind: "openAck",
                  manifest: frame.manifest,
                  optionalManifest: {
                    ...frame.optionalManifest,
                    "environment.host.bind": { major: 1, minor: 0 },
                  },
                }),
              });
            });
          },
        };
        queueMicrotask(() => socket.onopen?.({ type: "open" }));
        return socket;
      },
    },
  });

  request<Method extends keyof HostRpcRegistry & string>(
    method: Method,
    params: RequestOfMethod<HostRpcRegistry, Method>,
    dispatch: HostRpcDispatch,
  ): Promise<ResponseOfMethod<HostRpcRegistry, Method>> {
    return this.client.request(method, params, {
      requiredHostMethodVersion: dispatch.requiredHostMethodVersion,
      replayMustBeKeyed: false,
      idempotencyKey: null,
      authority: {
        endpoint: {
          hostId: "host-local",
          websocketUrl: "ws://127.0.0.1:1/rpc",
        },
        bearer: new MutableBearerLease("test-token", "test-person"),
        abortSignal: new AbortController().signal,
      },
    });
  }
}
