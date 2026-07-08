import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/index";
import { buildStreamManifest } from "@traycer/protocol/framework/stream-compat";
import {
  manifestFromSurface,
  protocolSurfaceSchema,
} from "@traycer/protocol/framework/surface-compat";
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
  IStreamWebSocketFactory,
  StreamWebSocketLike,
  StreamWebSocketMessageEvent,
} from "../ws-stream-factory";
import { WsStreamClient } from "../ws-stream-client";
import type {
  ClientFrame,
  HostFrame,
} from "@traycer/protocol/framework/ws-protocol";

/**
 * Released-peer handshake smoke: drives the REAL shipped transports
 * (`WsRpcClient` / `WsStreamClient`) with the REAL host registries against
 * stub sockets whose `openAck` carries the manifest of an actual released
 * baseline (dumped from its git tag by the protocol-compat CI job). This
 * exercises the full client-side path - frame encode/decode, the mirror
 * compatibility check, per-method negotiation - not just the registry math
 * that `surface-compat` covers.
 *
 * Gated on `PROTOCOL_BASELINE_SURFACES_DIR` (a directory of
 * `<label>.json` surfaces); skipped in normal local runs.
 */
const surfacesDir = process.env["PROTOCOL_BASELINE_SURFACES_DIR"];

function loadBaselines(): { label: string; surfacePath: string }[] {
  if (surfacesDir === undefined || surfacesDir.length === 0) {
    return [];
  }
  return readdirSync(surfacesDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => ({
      label: name.replace(/\.json$/, ""),
      surfacePath: join(surfacesDir, name),
    }));
}

const baselines = loadBaselines();

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

class StubRpcWebSocket implements WebSocketLike {
  onopen: ((event: WebSocketOpenEvent) => void) | null = null;
  onmessage: ((event: WebSocketMessageEvent) => void) | null = null;
  onerror: ((event: WebSocketErrorEvent) => void) | null = null;
  onclose: ((event: WebSocketCloseEvent) => void) | null = null;
  readonly sentFrames: ClientFrame[] = [];

  send(data: string): void {
    this.sentFrames.push(JSON.parse(data) as ClientFrame);
  }

  close(_code: number, _reason: string): void {}

  fireOpen(): void {
    this.onopen?.({ type: "open" });
  }

  fireMessage(frame: HostFrame): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

class StubStreamWebSocket implements StreamWebSocketLike {
  onopen: ((event: WebSocketOpenEvent) => void) | null = null;
  onmessage: ((event: StreamWebSocketMessageEvent) => void) | null = null;
  onerror: ((event: WebSocketErrorEvent) => void) | null = null;
  onclose: ((event: WebSocketCloseEvent) => void) | null = null;
  readonly textSent: string[] = [];

  send(data: string | Uint8Array): void {
    if (typeof data === "string") {
      this.textSent.push(data);
    }
  }

  close(_code: number, _reason: string): void {}

  fireOpen(): void {
    this.onopen?.({ type: "open" });
  }

  fireText(data: unknown): void {
    this.onmessage?.({ type: "text", data: JSON.stringify(data) });
  }
}

function readBaselineManifests(surfacePath: string): {
  unary: Readonly<Record<string, { major: number; minor: number }>>;
  stream: Readonly<Record<string, { major: number; minor: number }>>;
} {
  const surface = protocolSurfaceSchema.parse(
    JSON.parse(readFileSync(surfacePath, "utf8")),
  );
  return {
    unary: manifestFromSurface(surface, "unary"),
    stream: manifestFromSurface(surface, "stream"),
  };
}

describe.skipIf(baselines.length === 0)(
  "released-baseline handshake smoke (real transports vs released manifests)",
  () => {
    for (const baseline of baselines) {
      it(`WsRpcClient completes the unary handshake against ${baseline.label}`, async () => {
        const { unary } = readBaselineManifests(baseline.surfacePath);
        const sockets: StubRpcWebSocket[] = [];
        const factory: IWebSocketFactory = {
          create(): WebSocketLike {
            const socket = new StubRpcWebSocket();
            sockets.push(socket);
            return socket;
          },
        };
        const ctx = makeRequestContext("token-smoke");
        const client = new WsRpcClient<typeof hostRpcRegistry>({
          registry: hostRpcRegistry,
          endpoint: () => mockLocalHostEntry,
          bearer: () => ctx.credentials,
          requestId: () => "req-smoke",
          webSocketFactory: factory,
          dialTimeoutMs: 1000,
          frameTimeoutMs: 1000,
        });

        const pending = client.request("host.status", {});
        await flush();
        expect(sockets).toHaveLength(1);
        const stub = sockets[0];
        stub.fireOpen();
        await flush();
        expect(stub.sentFrames).toHaveLength(1);
        expect(stub.sentFrames[0].kind).toBe("open");

        stub.fireMessage({ kind: "openAck", manifest: unary });
        await flush();

        // A compatible baseline yields a request frame; an incompatible one
        // yields a fatalError frame and kills every RPC on the connection.
        expect(stub.sentFrames).toHaveLength(2);
        const second = stub.sentFrames[1];
        expect(second.kind).toBe("request");

        // Settle the in-flight request so nothing leaks across tests.
        if (second.kind === "request") {
          stub.fireMessage({
            kind: "response",
            requestId: second.requestId,
            method: second.method,
            schemaVersion: second.schemaVersion,
            result: {
              ready: true,
              hostVersion: "0.0.0-smoke",
              protocolVersion: { major: 1, minor: 0 },
            },
            error: null,
          });
          await expect(pending).resolves.toMatchObject({ ready: true });
        }
      });

      it(`WsStreamClient reaches an open subscription against ${baseline.label}`, async () => {
        const { stream } = readBaselineManifests(baseline.surfacePath);
        // Subscribe to a method every released peer shipped with, so the test
        // exercises the open handshake plus a per-method check that must pass.
        const method = "epic.subscribe";
        expect(
          buildStreamManifest(hostStreamRpcRegistry)[method],
        ).toBeDefined();
        expect(stream[method]).toBeDefined();

        const sockets: StubStreamWebSocket[] = [];
        const factory: IStreamWebSocketFactory = {
          create(): StreamWebSocketLike {
            const socket = new StubStreamWebSocket();
            sockets.push(socket);
            return socket;
          },
        };
        const ctx = makeRequestContext("token-smoke");
        const client = new WsStreamClient({
          registry: hostStreamRpcRegistry,
          endpoint: () => mockLocalHostEntry,
          bearer: () => ctx.credentials,
          auth: null,
          webSocketFactory: factory,
          dialTimeoutMs: 1000,
          openAckTimeoutMs: 1000,
          pingIntervalMs: 25_000,
          pongTimeoutMs: 50_000,
          initialBackoffMs: 10,
          maxBackoffMs: 1_000,
        });

        const session = client.subscribe(method, {
          epicId: "epic-smoke",
        });
        await flush();
        expect(sockets).toHaveLength(1);
        const stub = sockets[0];
        stub.fireOpen();
        expect(stub.textSent).toHaveLength(1);

        stub.fireText({ kind: "openAck", manifest: stream });

        // A compatible released manifest yields a subscribe frame for the
        // shared method; incompatibility yields a fatalError frame instead.
        expect(stub.textSent.length).toBeGreaterThanOrEqual(2);
        const second = JSON.parse(stub.textSent[1]) as {
          readonly kind: string;
          readonly method?: string;
        };
        expect(second.kind).toBe("subscribe");
        expect(second.method).toBe(method);

        session.close();
      });
    }
  },
);
