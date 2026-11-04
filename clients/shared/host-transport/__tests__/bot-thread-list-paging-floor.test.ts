/**
 * Tracy Bots T142: `bot.thread.list@1.2` pages. A 1.1 host strips `limit` and
 * `cursor` from the request it reads, so a paged call needs the 1.2 floor: the
 * REAL `WsRpcClient` and registry refuse it before sending against a 1.1
 * manifest, and project it onto 1.1 as `{ botId }` when no floor is asked.
 */
import { describe, expect, it } from "vitest";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  createRequestContext,
  identityFromAuthenticatedUser,
} from "@traycer/protocol/auth/request-context";
import type { ClientFrame } from "@traycer/protocol/framework/ws-protocol";
import { mockLocalHostEntry } from "../../host-client/mock/mock-host-directory";
import { createAuthenticatedUserFixture } from "../../test-fixtures/authenticated-user";
import {
  HostMethodVersionUnsatisfiedError,
  type HostRequestAuthority,
} from "../host-messenger";
import type {
  IWebSocketFactory,
  WebSocketCloseEvent,
  WebSocketErrorEvent,
  WebSocketLike,
  WebSocketMessageEvent,
  WebSocketOpenEvent,
} from "../ws-factory";
import { WsRpcClient } from "../ws-rpc-client";

const BOT_ID = "bot_01HZX5Y8K3M2N4P6Q7R8S9T0V1";
const PAGED = { botId: BOT_ID, limit: 1, cursor: "t1.x" } as const;
const REQUEST_ID = "req-thread-list";

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

class StubSocket implements WebSocketLike {
  onopen: ((event: WebSocketOpenEvent) => void) | null = null;
  onmessage: ((event: WebSocketMessageEvent) => void) | null = null;
  onerror: ((event: WebSocketErrorEvent) => void) | null = null;
  onclose: ((event: WebSocketCloseEvent) => void) | null = null;
  readonly sentFrames: ClientFrame[] = [];

  send(data: string): void {
    this.sentFrames.push(JSON.parse(data) as ClientFrame);
  }

  close(_code: number, _reason: string): void {}
}

function harness(): {
  readonly client: WsRpcClient<typeof hostRpcRegistry>;
  readonly sockets: StubSocket[];
  readonly authority: HostRequestAuthority;
} {
  const sockets: StubSocket[] = [];
  const factory: IWebSocketFactory = {
    create(): WebSocketLike {
      const socket = new StubSocket();
      sockets.push(socket);
      return socket;
    },
  };
  const context = createRequestContext({
    identity: identityFromAuthenticatedUser(
      createAuthenticatedUserFixture(undefined),
    ),
    bearerToken: "token-thread-list",
    origin: "renderer",
    connectionId: undefined,
    operationId: undefined,
    externalAbortSignal: undefined,
    cloudAuthorized: true,
  });
  return {
    sockets,
    authority: {
      endpoint: {
        hostId: mockLocalHostEntry.hostId,
        websocketUrl: mockLocalHostEntry.websocketUrl,
      },
      bearer: context.credentials,
      abortSignal: new AbortController().signal,
    },
    client: new WsRpcClient<typeof hostRpcRegistry>({
      clientIdentity: TEST_CLIENT_IDENTITY,
      registry: hostRpcRegistry,
      requestId: () => REQUEST_ID,
      webSocketFactory: factory,
      dialTimeoutMs: 1000,
      frameTimeoutMs: 1000,
      hostAttestationWindowMs: 0,
      evidence: NO_TRANSPORT_EVIDENCE,
    }),
  };
}

/** Opens the connection and has a host that lists threads at 1.1 answer its open frame. */
async function answerAsV11Host(socket: StubSocket): Promise<void> {
  await flush();
  socket.onopen?.({ type: "open" });
  await flush();
  const open = socket.sentFrames[0];
  if (open.kind !== "open") throw new Error("expected an open frame");
  // `bot.thread.list` is an optional method: the client advertises it there.
  if (open.optionalManifest?.["bot.thread.list"] === undefined) {
    throw new Error("the client does not advertise bot.thread.list");
  }
  socket.onmessage?.({
    data: JSON.stringify({
      kind: "openAck",
      manifest: open.manifest,
      optionalManifest: {
        ...open.optionalManifest,
        "bot.thread.list": { major: 1, minor: 1 },
      },
    }),
  });
  await flush();
}

describe("a paged bot.thread.list against a host that lists it at 1.1", () => {
  it("is refused before anything is sent when the call requires 1.2", async () => {
    const { client, sockets, authority } = harness();

    const pending = client.request("bot.thread.list", PAGED, {
      idempotencyKey: null,
      authority,
      replayMustBeKeyed: false,
      requiredHostMethodVersion: {
        method: "bot.thread.list",
        version: { major: 1, minor: 2 },
      },
    });
    const outcome = pending.then(
      () => null,
      (error: unknown) => error,
    );
    await answerAsV11Host(sockets[0]);

    expect(await outcome).toBeInstanceOf(HostMethodVersionUnsatisfiedError);
    expect(sockets[0].sentFrames.map((frame) => frame.kind)).toEqual(["open"]);
  });

  it("reaches the host as { botId } alone when it asks for no floor, which is why the floor exists", async () => {
    const { client, sockets, authority } = harness();

    void client
      .request("bot.thread.list", PAGED, {
        idempotencyKey: null,
        authority,
        replayMustBeKeyed: false,
        requiredHostMethodVersion: null,
      })
      .catch(() => undefined);
    await answerAsV11Host(sockets[0]);

    const request = sockets[0].sentFrames[1];
    if (request.kind !== "request") throw new Error("expected a request frame");
    expect(request.schemaVersion).toEqual({ major: 1, minor: 1 });
    expect(request.params).toEqual({ botId: BOT_ID });
  });
});
