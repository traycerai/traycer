import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineFallbackMethodDegrade,
  defineFloorAwareVersionedRpcRegistry,
  defineDowngradePath,
  defineRpcContract,
  defineUpgradePath,
  defineVersionedRpcRegistry,
  type VersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import { HostRpcError, RetryableTransportError } from "../host-messenger";
import {
  createRequestContext,
  identityFromAuthenticatedUser,
  type RequestContext,
} from "@traycer/protocol/auth/request-context";
import { mockLocalHostEntry } from "../../host-client/mock/mock-host-directory";
import { createAuthenticatedUserFixture } from "../../test-fixtures/authenticated-user";
import type {
  IWebSocketFactory,
  WebSocketCloseEvent,
  WebSocketErrorEvent,
  WebSocketLike,
  WebSocketMessageEvent,
  WebSocketOpenEvent,
} from "../ws-factory";
import { WsRpcClient } from "../ws-rpc-client";
import type {
  ClientFrame,
  ClientOpenFrame,
  ClientRequestFrame,
  ClientFatalErrorFrame,
  HostFrame,
} from "@traycer/protocol/framework/ws-protocol";

const echoV10 = defineRpcContract({
  method: "host.echo",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({ message: z.string() }),
  responseSchema: z.object({ echoed: z.string() }),
});

const statusV10 = defineRpcContract({
  method: "host.status",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({}),
  responseSchema: z.object({ ready: z.boolean() }),
});

const testRegistry = defineVersionedRpcRegistry({
  "host.echo": {
    1: {
      latestMinor: 0,
      versions: {
        0: { contract: echoV10, upgradeFromPreviousVersion: null },
      },
      downgradePathsFromLatest: {},
    },
  },
  "host.status": {
    1: {
      latestMinor: 0,
      versions: {
        0: { contract: statusV10, upgradeFromPreviousVersion: null },
      },
      downgradePathsFromLatest: {},
    },
  },
});

type RecordedSocket = {
  readonly url: string;
  readonly socket: StubWebSocket;
  readonly sent: ClientFrame[];
};

class StubWebSocket implements WebSocketLike {
  onopen: ((event: WebSocketOpenEvent) => void) | null = null;
  onmessage: ((event: WebSocketMessageEvent) => void) | null = null;
  onerror: ((event: WebSocketErrorEvent) => void) | null = null;
  onclose: ((event: WebSocketCloseEvent) => void) | null = null;
  readonly sent: string[] = [];
  closed: { readonly code: number; readonly reason: string } | null = null;
  readonly sentFrames: ClientFrame[] = [];

  send(data: string): void {
    this.sent.push(data);
    this.sentFrames.push(JSON.parse(data) as ClientFrame);
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }

  fireOpen(): void {
    if (this.onopen !== null) {
      this.onopen({ type: "open" });
    }
  }

  fireMessage(frame: HostFrame): void {
    if (this.onmessage !== null) {
      this.onmessage({ data: JSON.stringify(frame) });
    }
  }

  fireRawMessage(raw: string): void {
    if (this.onmessage !== null) {
      this.onmessage({ data: raw });
    }
  }

  fireError(message: string): void {
    if (this.onerror !== null) {
      this.onerror({ message });
    }
  }

  fireClose(code: number, reason: string, wasClean: boolean): void {
    if (this.onclose !== null) {
      this.onclose({ code, reason, wasClean });
    }
  }
}

function makeFactory(): {
  readonly factory: IWebSocketFactory;
  readonly sockets: RecordedSocket[];
} {
  const sockets: RecordedSocket[] = [];
  const factory: IWebSocketFactory = {
    create(url: string): WebSocketLike {
      const socket = new StubWebSocket();
      sockets.push({ url, socket, sent: socket.sentFrames });
      return socket;
    },
  };
  return { factory, sockets };
}

function makeClient(options: {
  readonly factory: IWebSocketFactory;
  readonly authToken: string | null;
  readonly requestId: string;
  readonly dialTimeoutMs: number;
  readonly frameTimeoutMs: number;
}): WsRpcClient<typeof testRegistry> {
  const ctx =
    options.authToken === null ? null : makeRequestContext(options.authToken);
  return new WsRpcClient<typeof testRegistry>({
    registry: testRegistry,
    endpoint: () => mockLocalHostEntry,
    bearer: () => ctx?.credentials ?? null,
    requestId: () => options.requestId,
    webSocketFactory: options.factory,
    dialTimeoutMs: options.dialTimeoutMs,
    frameTimeoutMs: options.frameTimeoutMs,
  });
}

function makeRequestContext(bearer: string): RequestContext {
  const fixture = createAuthenticatedUserFixture(undefined);
  return createRequestContext({
    identity: identityFromAuthenticatedUser(fixture),
    bearerToken: bearer,
    origin: "renderer",
    connectionId: undefined,
    operationId: undefined,
    externalAbortSignal: undefined,
  });
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function expectOpenFrame(frame: ClientFrame): ClientOpenFrame {
  if (frame.kind !== "open") {
    throw new Error(`Expected open frame, got '${frame.kind}'`);
  }
  return frame;
}

function expectRequestFrame(frame: ClientFrame): ClientRequestFrame {
  if (frame.kind !== "request") {
    throw new Error(`Expected request frame, got '${frame.kind}'`);
  }
  return frame;
}

function expectTerminalFrame(frame: ClientFrame): ClientFatalErrorFrame {
  if (frame.kind !== "fatalError") {
    throw new Error(`Expected fatalError frame, got '${frame.kind}'`);
  }
  return frame;
}

function openAckWithOptionalHostEcho(version: {
  readonly major: number;
  readonly minor: number;
}): HostFrame {
  return {
    kind: "openAck",
    manifest: {
      "host.status": { major: 1, minor: 0 },
    },
    optionalManifest: {
      "host.echo": version,
    },
  };
}

function openAckWithOnlyOptionalHostEcho(version: {
  readonly major: number;
  readonly minor: number;
}): HostFrame {
  return {
    kind: "openAck",
    manifest: {},
    optionalManifest: {
      "host.echo": version,
    },
  };
}

describe("WsRpcClient", () => {
  it("walks dial → open → openAck → request → response → close on the happy path", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "token-abc",
      requestId: "req-1",
      dialTimeoutMs: 1000,
      frameTimeoutMs: 1000,
    });

    const pending = client.request("host.echo", { message: "hi" });
    await flush();

    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toBe(mockLocalHostEntry.websocketUrl);

    const stub = sockets[0].socket;
    stub.fireOpen();
    await flush();

    expect(sockets[0].sent).toHaveLength(1);
    const openFrame = expectOpenFrame(sockets[0].sent[0]);
    expect(openFrame.token).toBe("token-abc");
    expect(openFrame.manifest).toEqual({
      "host.status": { major: 1, minor: 0 },
    });
    expect(openFrame.optionalManifest).toEqual({
      "host.echo": { major: 1, minor: 0 },
    });

    stub.fireMessage(openAckWithOptionalHostEcho({ major: 1, minor: 0 }));
    await flush();

    expect(sockets[0].sent).toHaveLength(2);
    const requestFrame = expectRequestFrame(sockets[0].sent[1]);
    expect(requestFrame).toEqual({
      kind: "request",
      requestId: "req-1",
      method: "host.echo",
      schemaVersion: { major: 1, minor: 0 },
      params: { message: "hi" },
    });
    expect(stub.closed).toBeNull();

    stub.fireMessage({
      kind: "response",
      requestId: "req-1",
      method: "host.echo",
      schemaVersion: { major: 1, minor: 0 },
      result: { echoed: "HI" },
      error: null,
    });

    await expect(pending).resolves.toEqual({ echoed: "HI" });
    expect(stub.closed).toEqual({ code: 1000, reason: "ok" });
  });

  it("rejects before dialing when no authenticated request context is available", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: null,
      requestId: "req-no-auth",
      dialTimeoutMs: 1000,
      frameTimeoutMs: 1000,
    });

    await expect(
      client.request("host.echo", { message: "hi" }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof HostRpcError &&
        error.code === "RPC_ERROR" &&
        error.requestId === "req-no-auth" &&
        error.message.includes("without an authenticated bearer source"),
    );
    expect(sockets).toHaveLength(0);
  });

  it("rejects before dialing when the request-context credential lease is released", async () => {
    const { factory, sockets } = makeFactory();
    const ctx = makeRequestContext("token-abc");
    ctx.release();
    const client = new WsRpcClient<typeof testRegistry>({
      registry: testRegistry,
      endpoint: () => mockLocalHostEntry,
      bearer: () => ctx?.credentials ?? null,
      requestId: () => "req-released",
      webSocketFactory: factory,
      dialTimeoutMs: 1000,
      frameTimeoutMs: 1000,
    });

    await expect(
      client.request("host.echo", { message: "hi" }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof HostRpcError &&
        error.code === "RPC_ERROR" &&
        error.requestId === "req-released" &&
        error.message.includes("Credential lease"),
    );
    expect(sockets).toHaveLength(0);
  });

  it("decodes a host INCOMPATIBLE fatalError frame into HostRpcError", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "t",
      requestId: "req-incompat",
      dialTimeoutMs: 1000,
      frameTimeoutMs: 1000,
    });

    const pending = client.request("host.echo", { message: "x" });
    await flush();
    sockets[0].socket.fireOpen();
    await flush();

    sockets[0].socket.fireMessage({
      kind: "fatalError",
      details: {
        code: "INCOMPATIBLE",
        reason: "Incompatible methods: host.echo",
        incompatibleMethods: [
          {
            method: "host.echo",
            clientCanonical: { major: 1, minor: 0 },
            hostCanonical: { major: 2, minor: 0 },
            blocking: "no-bridge",
          },
        ],
        upgradeGuidance: {
          clientShouldUpgrade: true,
          hostShouldUpgrade: false,
        },
      },
    });
    sockets[0].socket.fireClose(4001, "incompatible", true);

    await expect(pending).rejects.toSatisfy((error: unknown) => {
      if (!(error instanceof HostRpcError)) {
        return false;
      }
      return (
        error.code === "INCOMPATIBLE" &&
        error.requestId === "req-incompat" &&
        error.method === "host.echo" &&
        error.fatalDetails !== null &&
        error.fatalDetails.code === "INCOMPATIBLE" &&
        Array.isArray(error.fatalDetails.incompatibleMethods)
      );
    });
  });

  it("decodes a host UNAUTHORIZED fatalError frame", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "bad-token",
      requestId: "req-unauth",
      dialTimeoutMs: 1000,
      frameTimeoutMs: 1000,
    });

    const pending = client.request("host.status", {});
    await flush();
    sockets[0].socket.fireOpen();
    await flush();

    sockets[0].socket.fireMessage({
      kind: "fatalError",
      details: {
        code: "UNAUTHORIZED",
        reason: "Bearer token rejected",
        incompatibleMethods: null,
        upgradeGuidance: null,
      },
    });
    sockets[0].socket.fireClose(4401, "unauthorized", true);

    await expect(pending).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof HostRpcError &&
        error.code === "UNAUTHORIZED" &&
        error.fatalDetails !== null &&
        error.fatalDetails.code === "UNAUTHORIZED"
      );
    });
  });

  it("emits a client fatalError frame when its mirror compatibility check fails", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "t",
      requestId: "req-mirror",
      dialTimeoutMs: 1000,
      frameTimeoutMs: 1000,
    });

    const pending = client.request("host.echo", { message: "x" });
    await flush();
    sockets[0].socket.fireOpen();
    await flush();

    sockets[0].socket.fireMessage({
      kind: "openAck",
      manifest: {},
      optionalManifest: {
        "host.echo": { major: 1, minor: 0 },
      },
    });

    await expect(pending).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof HostRpcError &&
        error.code === "INCOMPATIBLE" &&
        error.fatalDetails !== null
      );
    });

    expect(sockets[0].sent).toHaveLength(2);
    const terminal = expectTerminalFrame(sockets[0].sent[1]);
    expect(terminal.details.code).toBe("INCOMPATIBLE");
    expect(sockets[0].socket.closed).toEqual({ code: 1000, reason: "ok" });
  });

  it("rejects with RPC_ERROR when a response carries a mismatched requestId", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "t",
      requestId: "req-correlated",
      dialTimeoutMs: 1000,
      frameTimeoutMs: 1000,
    });

    const pending = client.request("host.echo", { message: "x" });
    await flush();
    sockets[0].socket.fireOpen();
    await flush();
    sockets[0].socket.fireMessage(
      openAckWithOptionalHostEcho({ major: 1, minor: 0 }),
    );
    await flush();

    sockets[0].socket.fireMessage({
      kind: "response",
      requestId: "different",
      method: "host.echo",
      schemaVersion: { major: 1, minor: 0 },
      result: { echoed: "X" },
      error: null,
    });

    await expect(pending).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof HostRpcError &&
        error.code === "RPC_ERROR" &&
        error.requestId === "req-correlated"
      );
    });
  });

  it("maps a dial failure (transport unreachable) to RPC_ERROR", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "t",
      requestId: "req-dial-fail",
      dialTimeoutMs: 1000,
      frameTimeoutMs: 1000,
    });

    const pending = client.request("host.echo", { message: "x" });
    await flush();
    sockets[0].socket.fireError("ECONNREFUSED");
    sockets[0].socket.fireClose(1006, "abnormal", false);

    await expect(pending).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof HostRpcError &&
        error.code === "RPC_ERROR" &&
        error.method === "host.echo" &&
        error.requestId === "req-dial-fail"
      );
    });
    expect(sockets[0].socket.sent).toHaveLength(0);
  });

  it("maps a dial timeout to RPC_ERROR", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "t",
      requestId: "req-dial-timeout",
      dialTimeoutMs: 25,
      frameTimeoutMs: 1000,
    });

    const pending = client.request("host.echo", { message: "x" });
    await flush();
    expect(sockets).toHaveLength(1);

    await expect(pending).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof HostRpcError &&
        error.code === "RPC_ERROR" &&
        error.message.includes("dial timed out")
      );
    });
  });

  it("maps a frame timeout (no openAck) to RPC_ERROR", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "t",
      requestId: "req-frame-timeout",
      dialTimeoutMs: 1000,
      frameTimeoutMs: 25,
    });

    const pending = client.request("host.echo", { message: "x" });
    await flush();
    sockets[0].socket.fireOpen();
    await flush();

    await expect(pending).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof HostRpcError &&
        error.code === "RPC_ERROR" &&
        error.message.includes("frame timed out")
      );
    });
  });

  it("maps a malformed host frame to RPC_ERROR", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "t",
      requestId: "req-malformed",
      dialTimeoutMs: 1000,
      frameTimeoutMs: 1000,
    });

    const pending = client.request("host.echo", { message: "x" });
    await flush();
    sockets[0].socket.fireOpen();
    await flush();

    sockets[0].socket.fireRawMessage(
      JSON.stringify({
        kind: "fatalError",
        details: {
          code: "INCOMPATIBLE",
          reason: "broken payload",
          incompatibleMethods: [],
          upgradeGuidance: {
            clientShouldUpgrade: "yes",
            hostShouldUpgrade: false,
          },
        },
      }),
    );

    await expect(pending).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof HostRpcError &&
        error.code === "RPC_ERROR" &&
        error.requestId === "req-malformed" &&
        error.method === "host.echo" &&
        error.message.includes("Malformed host frame:")
      );
    });
  });

  it("classifies a dial timeout as a retryable transport error", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "t",
      requestId: "req-dial-retryable",
      dialTimeoutMs: 25,
      frameTimeoutMs: 1000,
    });

    const pending = client.request("host.echo", { message: "x" });
    await flush();
    expect(sockets).toHaveLength(1);

    await expect(pending).rejects.toBeInstanceOf(RetryableTransportError);
  });

  it("classifies a close-before-open as a retryable transport error", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "t",
      requestId: "req-close-retryable",
      dialTimeoutMs: 1000,
      frameTimeoutMs: 1000,
    });

    const pending = client.request("host.echo", { message: "x" });
    await flush();
    sockets[0].socket.fireClose(1006, "abnormal", false);

    await expect(pending).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof RetryableTransportError &&
        error.code === "RPC_ERROR" &&
        error.message.includes("closed before open"),
    );
  });

  it("classifies a handshake (pre-openAck) frame timeout as retryable", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "t",
      requestId: "req-handshake-retryable",
      dialTimeoutMs: 1000,
      frameTimeoutMs: 25,
    });

    const pending = client.request("host.echo", { message: "x" });
    await flush();
    sockets[0].socket.fireOpen();
    await flush();

    await expect(pending).rejects.toBeInstanceOf(RetryableTransportError);
  });

  it("does NOT classify a post-send response timeout as retryable", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "t",
      requestId: "req-postsend",
      dialTimeoutMs: 1000,
      frameTimeoutMs: 25,
    });

    const pending = client.request("host.echo", { message: "x" });
    await flush();
    sockets[0].socket.fireOpen();
    await flush();
    sockets[0].socket.fireMessage(
      openAckWithOptionalHostEcho({ major: 1, minor: 0 }),
    );
    await flush();
    // The request frame is now on the wire; the response never arrives.
    expect(expectRequestFrame(sockets[0].sent[1])).toBeDefined();

    await expect(pending).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof HostRpcError &&
        !(error instanceof RetryableTransportError) &&
        error.message.includes("frame timed out"),
    );
  });

  it("does NOT classify a malformed frame as retryable", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "t",
      requestId: "req-malformed-nonretry",
      dialTimeoutMs: 1000,
      frameTimeoutMs: 1000,
    });

    const pending = client.request("host.echo", { message: "x" });
    await flush();
    sockets[0].socket.fireOpen();
    await flush();
    sockets[0].socket.fireRawMessage("{ not json");

    await expect(pending).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof HostRpcError &&
        !(error instanceof RetryableTransportError) &&
        error.message.includes("Malformed host frame:"),
    );
  });

  it("propagates a host error envelope on the response frame", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "t",
      requestId: "req-error-env",
      dialTimeoutMs: 1000,
      frameTimeoutMs: 1000,
    });

    const pending = client.request("host.echo", { message: "x" });
    await flush();
    sockets[0].socket.fireOpen();
    await flush();
    sockets[0].socket.fireMessage(
      openAckWithOptionalHostEcho({ major: 1, minor: 0 }),
    );
    await flush();

    sockets[0].socket.fireMessage({
      kind: "response",
      requestId: "req-error-env",
      method: "host.echo",
      schemaVersion: { major: 1, minor: 0 },
      result: null,
      error: { code: "DOWNGRADE_UNSUPPORTED", message: "no bridge" },
    });

    await expect(pending).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof HostRpcError &&
        error.code === "DOWNGRADE_UNSUPPORTED" &&
        error.message === "no bridge"
      );
    });
  });

  it("falls back to a floor method when an optional method is absent", async () => {
    const fallbackV10 = defineRpcContract({
      method: "host.syntheticFallback",
      schemaVersion: { major: 1, minor: 0 } as const,
      requestSchema: z.object({ label: z.string() }),
      responseSchema: z.object({ summary: z.string() }),
    });
    const fallbackRegistry = defineFloorAwareVersionedRpcRegistry(
      ["host.status"] as const,
      {
        "host.status": {
          1: {
            latestMinor: 0,
            versions: {
              0: { contract: statusV10, upgradeFromPreviousVersion: null },
            },
            downgradePathsFromLatest: {},
          },
        },
        "host.syntheticFallback": {
          degrade: defineFallbackMethodDegrade<
            typeof fallbackV10,
            typeof statusV10,
            "host.status"
          >({
            kind: "fallback",
            to: { method: "host.status", major: 1, minor: 0 },
            adaptRequest: () => ({}),
            adaptResponse: (response) => ({
              summary: response.ready ? "ready" : "not-ready",
            }),
          }),
          1: {
            latestMinor: 0,
            versions: {
              0: { contract: fallbackV10, upgradeFromPreviousVersion: null },
            },
            downgradePathsFromLatest: {},
          },
        },
      },
    );
    const { factory, sockets } = makeFactory();
    const ctx = makeRequestContext("t");
    const client = new WsRpcClient<typeof fallbackRegistry>({
      registry: fallbackRegistry,
      endpoint: () => mockLocalHostEntry,
      bearer: () => ctx.credentials,
      requestId: () => "req-fallback",
      webSocketFactory: factory,
      dialTimeoutMs: 1000,
      frameTimeoutMs: 1000,
    });

    const pending = client.request("host.syntheticFallback", { label: "x" });
    await flush();
    sockets[0].socket.fireOpen();
    await flush();

    const openFrame = expectOpenFrame(sockets[0].sent[0]);
    expect(openFrame.manifest).toEqual({
      "host.status": { major: 1, minor: 0 },
    });
    expect(openFrame.optionalManifest).toEqual({
      "host.syntheticFallback": { major: 1, minor: 0 },
    });

    sockets[0].socket.fireMessage({
      kind: "openAck",
      manifest: {
        "host.status": { major: 1, minor: 0 },
      },
    });
    await flush();

    const requestFrame = expectRequestFrame(sockets[0].sent[1]);
    expect(requestFrame).toEqual({
      kind: "request",
      requestId: "req-fallback",
      method: "host.status",
      schemaVersion: { major: 1, minor: 0 },
      params: {},
    });
    expect(sockets[0].socket.closed).toBeNull();

    sockets[0].socket.fireMessage({
      kind: "response",
      requestId: "req-fallback",
      method: "host.status",
      schemaVersion: { major: 1, minor: 0 },
      result: { ready: true },
      error: null,
    });

    await expect(pending).resolves.toEqual({ summary: "ready" });
    expect(sockets[0].socket.closed).toEqual({ code: 1000, reason: "ok" });
  });

  it("throws E_HOST_UNSUPPORTED when an absent optional method declares unsupported", async () => {
    const unsupportedV10 = defineRpcContract({
      method: "host.syntheticUnsupported",
      schemaVersion: { major: 1, minor: 0 } as const,
      requestSchema: z.object({}),
      responseSchema: z.object({ ok: z.boolean() }),
    });
    const unsupportedRegistry = defineFloorAwareVersionedRpcRegistry(
      ["host.status"] as const,
      {
        "host.status": {
          1: {
            latestMinor: 0,
            versions: {
              0: { contract: statusV10, upgradeFromPreviousVersion: null },
            },
            downgradePathsFromLatest: {},
          },
        },
        "host.syntheticUnsupported": {
          degrade: { kind: "unsupported" },
          1: {
            latestMinor: 0,
            versions: {
              0: { contract: unsupportedV10, upgradeFromPreviousVersion: null },
            },
            downgradePathsFromLatest: {},
          },
        },
      },
    );
    const { factory, sockets } = makeFactory();
    const ctx = makeRequestContext("t");
    const client = new WsRpcClient<typeof unsupportedRegistry>({
      registry: unsupportedRegistry,
      endpoint: () => mockLocalHostEntry,
      bearer: () => ctx.credentials,
      requestId: () => "req-unsupported",
      webSocketFactory: factory,
      dialTimeoutMs: 1000,
      frameTimeoutMs: 1000,
    });

    const pending = client.request("host.syntheticUnsupported", {});
    await flush();
    sockets[0].socket.fireOpen();
    await flush();
    sockets[0].socket.fireMessage({
      kind: "openAck",
      manifest: {
        "host.status": { major: 1, minor: 0 },
      },
    });

    await expect(pending).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof HostRpcError &&
        error.code === "E_HOST_UNSUPPORTED" &&
        error.fatalDetails?.upgradeGuidance?.hostShouldUpgrade === true
      );
    });
    expect(sockets[0].sent.map((frame) => frame.kind)).not.toContain("request");
  });

  describe("fallback degrade version anchoring", () => {
    const statusSkewV11 = defineRpcContract({
      method: "host.status",
      schemaVersion: { major: 1, minor: 1 } as const,
      requestSchema: z.object({ verbose: z.boolean() }),
      responseSchema: z.object({ ready: z.boolean(), detail: z.string() }),
    });

    const fallbackSkewV10 = defineRpcContract({
      method: "host.syntheticSkewFallback",
      schemaVersion: { major: 1, minor: 0 } as const,
      requestSchema: z.object({ label: z.string() }),
      responseSchema: z.object({
        summary: z.string(),
        detailSeen: z.boolean(),
      }),
    });

    const upgradeStatusV10ToV11 = defineUpgradePath<
      typeof statusV10,
      typeof statusSkewV11
    >({
      from: statusV10.schemaVersion,
      to: statusSkewV11.schemaVersion,
      upgradeRequest: () => ({ verbose: false }),
      upgradeResponse: (response) => ({
        ready: response.ready,
        detail: "upgraded",
      }),
    });

    const fallbackSkewRegistry = defineFloorAwareVersionedRpcRegistry(
      ["host.status"] as const,
      {
        "host.status": {
          1: {
            latestMinor: 1,
            versions: {
              0: { contract: statusV10, upgradeFromPreviousVersion: null },
              1: {
                contract: statusSkewV11,
                upgradeFromPreviousVersion: upgradeStatusV10ToV11,
              },
            },
            downgradePathsFromLatest: {},
          },
        },
        "host.syntheticSkewFallback": {
          degrade: defineFallbackMethodDegrade<
            typeof fallbackSkewV10,
            typeof statusV10,
            "host.status"
          >({
            kind: "fallback",
            to: { method: "host.status", major: 1, minor: 0 },
            adaptRequest: () => ({}),
            adaptResponse: (response) => ({
              summary: response.ready ? "ready" : "not-ready",
              detailSeen: Object.prototype.hasOwnProperty.call(
                response,
                "detail",
              ),
            }),
          }),
          1: {
            latestMinor: 0,
            versions: {
              0: {
                contract: fallbackSkewV10,
                upgradeFromPreviousVersion: null,
              },
            },
            downgradePathsFromLatest: {},
          },
        },
      },
    );

    function makeFallbackSkewClient(options: {
      readonly factory: IWebSocketFactory;
      readonly requestId: string;
    }): WsRpcClient<typeof fallbackSkewRegistry> {
      const ctx = makeRequestContext("t");
      return new WsRpcClient<typeof fallbackSkewRegistry>({
        registry: fallbackSkewRegistry,
        endpoint: () => mockLocalHostEntry,
        bearer: () => ctx.credentials,
        requestId: () => options.requestId,
        webSocketFactory: options.factory,
        dialTimeoutMs: 1000,
        frameTimeoutMs: 1000,
      });
    }

    it("anchors fallback at degrade.to when the host has the older target minor", async () => {
      const { factory, sockets } = makeFactory();
      const client = makeFallbackSkewClient({
        factory,
        requestId: "req-fallback-skew-old-host",
      });

      const pending = client.request("host.syntheticSkewFallback", {
        label: "x",
      });
      await flush();
      sockets[0].socket.fireOpen();
      await flush();

      const openFrame = expectOpenFrame(sockets[0].sent[0]);
      expect(openFrame.manifest).toEqual({
        "host.status": { major: 1, minor: 1 },
      });
      expect(openFrame.optionalManifest).toEqual({
        "host.syntheticSkewFallback": { major: 1, minor: 0 },
      });

      sockets[0].socket.fireMessage({
        kind: "openAck",
        manifest: {
          "host.status": { major: 1, minor: 0 },
        },
      });
      await flush();

      const requestFrame = expectRequestFrame(sockets[0].sent[1]);
      expect(requestFrame).toEqual({
        kind: "request",
        requestId: "req-fallback-skew-old-host",
        method: "host.status",
        schemaVersion: { major: 1, minor: 0 },
        params: {},
      });

      sockets[0].socket.fireMessage({
        kind: "response",
        requestId: "req-fallback-skew-old-host",
        method: "host.status",
        schemaVersion: { major: 1, minor: 0 },
        result: { ready: true },
        error: null,
      });

      await expect(pending).resolves.toEqual({
        summary: "ready",
        detailSeen: false,
      });
    });

    it("anchors fallback at degrade.to when the host has the newer floor minor", async () => {
      const { factory, sockets } = makeFactory();
      const client = makeFallbackSkewClient({
        factory,
        requestId: "req-fallback-skew-new-host",
      });

      const pending = client.request("host.syntheticSkewFallback", {
        label: "x",
      });
      await flush();
      sockets[0].socket.fireOpen();
      await flush();

      sockets[0].socket.fireMessage({
        kind: "openAck",
        manifest: {
          "host.status": { major: 1, minor: 1 },
        },
      });
      await flush();

      const requestFrame = expectRequestFrame(sockets[0].sent[1]);
      expect(requestFrame).toEqual({
        kind: "request",
        requestId: "req-fallback-skew-new-host",
        method: "host.status",
        schemaVersion: { major: 1, minor: 0 },
        params: {},
      });

      sockets[0].socket.fireMessage({
        kind: "response",
        requestId: "req-fallback-skew-new-host",
        method: "host.status",
        schemaVersion: { major: 1, minor: 0 },
        result: { ready: true },
        error: null,
      });

      await expect(pending).resolves.toEqual({
        summary: "ready",
        detailSeen: false,
      });
    });
  });

  // ---- Asymmetric per-method version-on-wire ---------------------------- //

  describe("asymmetric per-method version-on-wire", () => {
    const echoReqV10 = defineRpcContract({
      method: "host.echo",
      schemaVersion: { major: 1, minor: 0 } as const,
      requestSchema: z.object({ message: z.string() }),
      responseSchema: z.object({ echoed: z.string() }),
    });

    const echoReqV11 = defineRpcContract({
      method: "host.echo",
      schemaVersion: { major: 1, minor: 1 } as const,
      requestSchema: z.object({ message: z.string(), loud: z.boolean() }),
      responseSchema: z.object({ echoed: z.string(), volume: z.number() }),
    });

    const echoReqV20 = defineRpcContract({
      method: "host.echo",
      schemaVersion: { major: 2, minor: 0 } as const,
      requestSchema: z.object({ text: z.string(), shout: z.boolean() }),
      responseSchema: z.object({ reply: z.string(), level: z.number() }),
    });

    const upgradeEchoV10ToV11 = defineUpgradePath<
      typeof echoReqV10,
      typeof echoReqV11
    >({
      from: echoReqV10.schemaVersion,
      to: echoReqV11.schemaVersion,
      upgradeRequest: (request) => ({ message: request.message, loud: false }),
      upgradeResponse: (response) => ({ echoed: response.echoed, volume: 0 }),
    });

    const upgradeEchoV11ToV20 = defineUpgradePath<
      typeof echoReqV11,
      typeof echoReqV20
    >({
      from: echoReqV11.schemaVersion,
      to: echoReqV20.schemaVersion,
      upgradeRequest: (request) => ({
        text: request.message,
        shout: request.loud,
      }),
      upgradeResponse: (response) => ({
        reply: response.echoed,
        level: response.volume,
      }),
    });

    const downgradeEchoV20ToV11 = defineDowngradePath<
      typeof echoReqV20,
      typeof echoReqV11
    >({
      from: echoReqV20.schemaVersion,
      to: echoReqV11.schemaVersion,
      downgradeRequest: (request) => ({
        ok: true,
        value: { message: request.text, loud: request.shout },
      }),
      downgradeResponse: (response) => ({
        ok: true,
        value: { echoed: response.reply, volume: response.level },
      }),
    });

    const registryV1Line = defineVersionedRpcRegistry({
      "host.echo": {
        1: {
          latestMinor: 1,
          versions: {
            0: { contract: echoReqV10, upgradeFromPreviousVersion: null },
            1: {
              contract: echoReqV11,
              upgradeFromPreviousVersion: upgradeEchoV10ToV11,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    });

    const registryV10Only = defineVersionedRpcRegistry({
      "host.echo": {
        1: {
          latestMinor: 0,
          versions: {
            0: { contract: echoReqV10, upgradeFromPreviousVersion: null },
          },
          downgradePathsFromLatest: {},
        },
      },
    });

    const registryV2WithBridge = defineVersionedRpcRegistry({
      "host.echo": {
        1: {
          latestMinor: 1,
          versions: {
            0: { contract: echoReqV10, upgradeFromPreviousVersion: null },
            1: {
              contract: echoReqV11,
              upgradeFromPreviousVersion: upgradeEchoV10ToV11,
            },
          },
          downgradePathsFromLatest: {},
        },
        2: {
          latestMinor: 0,
          versions: {
            0: {
              contract: echoReqV20,
              upgradeFromPreviousVersion: upgradeEchoV11ToV20,
            },
          },
          downgradePathsFromLatest: { 1: downgradeEchoV20ToV11 },
        },
      },
    });

    const registryV2NoBridge = defineVersionedRpcRegistry({
      "host.echo": {
        2: {
          latestMinor: 0,
          versions: {
            0: { contract: echoReqV20, upgradeFromPreviousVersion: null },
          },
          downgradePathsFromLatest: {},
        },
      },
    });

    function buildClient<Registry extends VersionedRpcRegistry>(
      registry: Registry,
      options: {
        readonly factory: IWebSocketFactory;
        readonly requestId: string;
      },
    ): WsRpcClient<Registry> {
      const ctx = makeRequestContext("t");
      return new WsRpcClient<Registry>({
        registry,
        endpoint: () => mockLocalHostEntry,
        bearer: () => ctx?.credentials ?? null,
        requestId: () => options.requestId,
        webSocketFactory: options.factory,
        dialTimeoutMs: 1000,
        frameTimeoutMs: 1000,
      });
    }

    it("same major, client newer minor: strips request to older minor and upgrades response", async () => {
      const { factory, sockets } = makeFactory();
      const client = buildClient(registryV1Line, {
        factory,
        requestId: "req-same-newer",
      });

      const pending = client.request("host.echo", {
        message: "hi",
        loud: true,
      });
      await flush();

      sockets[0].socket.fireOpen();
      await flush();

      sockets[0].socket.fireMessage(
        openAckWithOnlyOptionalHostEcho({ major: 1, minor: 0 }),
      );
      await flush();

      expect(sockets[0].sent).toHaveLength(2);
      const requestFrame = expectRequestFrame(sockets[0].sent[1]);
      expect(requestFrame.schemaVersion).toEqual({ major: 1, minor: 0 });
      expect(requestFrame.params).toEqual({ message: "hi" });

      sockets[0].socket.fireMessage({
        kind: "response",
        requestId: "req-same-newer",
        method: "host.echo",
        schemaVersion: { major: 1, minor: 0 },
        result: { echoed: "HI" },
        error: null,
      });

      await expect(pending).resolves.toEqual({ echoed: "HI", volume: 0 });
    });

    it("same major, client older minor: sends caller canonical unchanged and returns response unchanged", async () => {
      const { factory, sockets } = makeFactory();
      const client = buildClient(registryV10Only, {
        factory,
        requestId: "req-same-older",
      });

      const pending = client.request("host.echo", { message: "hi" });
      await flush();

      sockets[0].socket.fireOpen();
      await flush();

      sockets[0].socket.fireMessage(
        openAckWithOnlyOptionalHostEcho({ major: 1, minor: 1 }),
      );
      await flush();

      expect(sockets[0].sent).toHaveLength(2);
      const requestFrame = expectRequestFrame(sockets[0].sent[1]);
      expect(requestFrame.schemaVersion).toEqual({ major: 1, minor: 0 });
      expect(requestFrame.params).toEqual({ message: "hi" });

      sockets[0].socket.fireMessage({
        kind: "response",
        requestId: "req-same-older",
        method: "host.echo",
        schemaVersion: { major: 1, minor: 0 },
        result: { echoed: "HI" },
        error: null,
      });

      await expect(pending).resolves.toEqual({ echoed: "HI" });
    });

    it("cross major, client newer with bridge: downgrades request and upgrades response", async () => {
      const { factory, sockets } = makeFactory();
      const client = buildClient(registryV2WithBridge, {
        factory,
        requestId: "req-cross-bridge",
      });

      const pending = client.request("host.echo", {
        text: "hi",
        shout: true,
      });
      await flush();

      sockets[0].socket.fireOpen();
      await flush();

      sockets[0].socket.fireMessage(
        openAckWithOnlyOptionalHostEcho({ major: 1, minor: 1 }),
      );
      await flush();

      expect(sockets[0].sent).toHaveLength(2);
      const requestFrame = expectRequestFrame(sockets[0].sent[1]);
      expect(requestFrame.schemaVersion).toEqual({ major: 1, minor: 1 });
      expect(requestFrame.params).toEqual({ message: "hi", loud: true });

      sockets[0].socket.fireMessage({
        kind: "response",
        requestId: "req-cross-bridge",
        method: "host.echo",
        schemaVersion: { major: 1, minor: 1 },
        result: { echoed: "HI", volume: 9 },
        error: null,
      });

      await expect(pending).resolves.toEqual({ reply: "HI", level: 9 });
    });

    it("cross major, client newer without bridge: throws DOWNGRADE_UNSUPPORTED without sending request or fatalError", async () => {
      const { factory, sockets } = makeFactory();
      const client = buildClient(registryV2NoBridge, {
        factory,
        requestId: "req-cross-no-bridge",
      });

      const pending = client.request("host.echo", {
        text: "hi",
        shout: true,
      });
      await flush();

      sockets[0].socket.fireOpen();
      await flush();

      sockets[0].socket.fireMessage(
        openAckWithOnlyOptionalHostEcho({ major: 1, minor: 1 }),
      );

      await expect(pending).rejects.toSatisfy((error: unknown) => {
        return (
          error instanceof HostRpcError &&
          error.code === "DOWNGRADE_UNSUPPORTED" &&
          error.method === "host.echo" &&
          error.requestId === "req-cross-no-bridge" &&
          error.fatalDetails === null
        );
      });

      const kinds = sockets[0].sent.map((frame) => frame.kind);
      expect(kinds).not.toContain("request");
      expect(kinds).not.toContain("fatalError");
    });

    it("cross major, client older: sends caller canonical unchanged and returns response unchanged", async () => {
      const { factory, sockets } = makeFactory();
      const client = buildClient(registryV1Line, {
        factory,
        requestId: "req-cross-older",
      });

      const pending = client.request("host.echo", {
        message: "hi",
        loud: true,
      });
      await flush();

      sockets[0].socket.fireOpen();
      await flush();

      sockets[0].socket.fireMessage(
        openAckWithOnlyOptionalHostEcho({ major: 2, minor: 0 }),
      );
      await flush();

      expect(sockets[0].sent).toHaveLength(2);
      const requestFrame = expectRequestFrame(sockets[0].sent[1]);
      expect(requestFrame.schemaVersion).toEqual({ major: 1, minor: 1 });
      expect(requestFrame.params).toEqual({ message: "hi", loud: true });

      sockets[0].socket.fireMessage({
        kind: "response",
        requestId: "req-cross-older",
        method: "host.echo",
        schemaVersion: { major: 1, minor: 1 },
        result: { echoed: "HI", volume: 4 },
        error: null,
      });

      await expect(pending).resolves.toEqual({ echoed: "HI", volume: 4 });
    });
  });
});
