import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/index";
import { hostStatusV10 } from "@traycer/protocol/host/status/contracts";
import { releasedMethodNames } from "@traycer/protocol/host/__tests__/__fixtures__/released-method-names";
import {
  defineFallbackMethodDegrade,
  defineFloorAwareVersionedRpcRegistry,
  defineRpcContract,
} from "@traycer/protocol/framework/index";
import { buildStreamManifest } from "@traycer/protocol/framework/stream-compat";
import { SERVES_EVERY_INSTALLED_MAJOR } from "@traycer/protocol/framework/capability-manifest";
import { CLIENT_SERVED_STREAM_MAJORS } from "../served-stream-majors";
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
import { HostRpcError, type HostRequestAuthority } from "../host-messenger";
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
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";

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

function authorityForContext(ctx: RequestContext): HostRequestAuthority {
  return {
    endpoint: {
      hostId: mockLocalHostEntry.hostId,
      websocketUrl: mockLocalHostEntry.websocketUrl,
    },
    bearer: ctx.credentials,
    abortSignal: new AbortController().signal,
  };
}

const baselineFallbackV10 = defineRpcContract({
  method: "synthetic.baselineFallback",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({ label: z.string() }),
  responseSchema: z.object({ summary: z.string() }),
});

/**
 * Structural view of one method's registry entry, wide enough to look a minor
 * up with a RUNTIME version.
 *
 * The registry's own type keys majors and minors as literals, so indexing it
 * with `second.schemaVersion.minor` (a `number`) is a TS7053. Widening through
 * a named structural type is the type-safe way to do that lookup — `as any` /
 * `as unknown` are banned here, and would defeat the point in any case: the
 * whole value of this check is that it reads the REAL registry rather than a
 * hand-maintained list of minors that would go stale exactly when it matters.
 */
interface MinorLookupEntry {
  readonly contract: { readonly responseSchema: z.ZodType };
}
interface MajorLookupEntry {
  readonly versions: Readonly<Record<string, MinorLookupEntry>>;
}

/**
 * `null` when `served` is a valid response at `version`; otherwise the
 * actionable reason, naming the minor to extend.
 */
function servedResponseMismatch(
  served: unknown,
  version: { readonly major: number; readonly minor: number },
): string | null {
  const majors: Readonly<Record<string, MajorLookupEntry>> =
    hostRpcRegistry["host.status"];
  const entry = majors[String(version.major)]?.versions[String(version.minor)];
  if (entry === undefined) {
    return `host.status@${version.major}.${version.minor} is not installed in this client's registry`;
  }
  if (entry.contract.responseSchema.safeParse(served).success) return null;
  return `the stub response is not valid at the negotiated host.status@${version.major}.${version.minor}; extend \`served\` with that minor's fields`;
}

const baselineUnsupportedV10 = defineRpcContract({
  method: "synthetic.baselineUnsupported",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({}),
  responseSchema: z.object({ ok: z.boolean() }),
});

const baselineFallbackRegistry = defineFloorAwareVersionedRpcRegistry(
  releasedMethodNames,
  {
    ...hostRpcRegistry,
    "synthetic.baselineFallback": {
      degrade: defineFallbackMethodDegrade<
        typeof baselineFallbackV10,
        typeof hostStatusV10,
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
          0: {
            contract: baselineFallbackV10,
            upgradeFromPreviousVersion: null,
          },
        },
        downgradePathsFromLatest: {},
      },
    },
  },
);

const baselineUnsupportedRegistry = defineFloorAwareVersionedRpcRegistry(
  releasedMethodNames,
  {
    ...hostRpcRegistry,
    "synthetic.baselineUnsupported": {
      degrade: { kind: "unsupported" },
      1: {
        latestMinor: 0,
        versions: {
          0: {
            contract: baselineUnsupportedV10,
            upgradeFromPreviousVersion: null,
          },
        },
        downgradePathsFromLatest: {},
      },
    },
  },
);

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

function intersectManifests(
  hostManifest: Readonly<Record<string, { major: number; minor: number }>>,
  clientManifest: Readonly<Record<string, { major: number; minor: number }>>,
): Record<string, { major: number; minor: number }> {
  return Object.fromEntries(
    Object.entries(hostManifest).filter(
      ([method]) => clientManifest[method] !== undefined,
    ),
  );
}

function createReleasedPeerClient(
  bearer: string,
  requestId: string,
): {
  readonly client: WsRpcClient<typeof hostRpcRegistry>;
  readonly sockets: StubRpcWebSocket[];
  readonly authority: HostRequestAuthority;
} {
  const sockets: StubRpcWebSocket[] = [];
  const factory: IWebSocketFactory = {
    create(): WebSocketLike {
      const socket = new StubRpcWebSocket();
      sockets.push(socket);
      return socket;
    },
  };
  const ctx = makeRequestContext(bearer);
  return {
    sockets,
    authority: authorityForContext(ctx),
    client: new WsRpcClient<typeof hostRpcRegistry>({
      clientIdentity: TEST_CLIENT_IDENTITY,
      registry: hostRpcRegistry,
      requestId: () => requestId,
      webSocketFactory: factory,
      dialTimeoutMs: 1000,
      frameTimeoutMs: 1000,
      hostAttestationWindowMs: 0,
      evidence: NO_TRANSPORT_EVIDENCE,
    }),
  };
}

describe("host-v1.1.7 permission-mode downgrade protection", () => {
  it("rejects agent.create@3.0 before sending to released agent.create@2.0", async () => {
    const { client, sockets, authority } = createReleasedPeerClient(
      "token-v1.1.7-create",
      "req-v1.1.7-create",
    );

    const pending = client.request(
      "agent.create",
      {
        senderAgentId: "agent-parent",
        epicId: "epic-1",
        name: null,
        surface: "gui",
        harnessId: "cursor",
        model: "cursor-test",
        agentMode: null,
        reasoningEffort: null,
        fastMode: null,
        permissionMode: "full_access",
        workspace: null,
        profileSelection: { kind: "ambient" },
      },
      authority,
    );
    await flush();
    const stub = sockets[0];
    stub.fireOpen();
    await flush();
    const open = stub.sentFrames[0];
    if (open.kind !== "open") throw new Error("expected open frame");
    stub.fireMessage({
      kind: "openAck",
      manifest: {
        ...open.manifest,
        "agent.create": { major: 2, minor: 0 },
      },
      optionalManifest: open.optionalManifest,
    });

    await expect(pending).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof HostRpcError &&
        error.code === "DOWNGRADE_UNSUPPORTED" &&
        error.message.includes("Upgrade the host")
      );
    });
    expect(stub.sentFrames.map((frame) => frame.kind)).toEqual(["open"]);
  });

  it("rejects agent.configure@2.0 before sending to released agent.configure@1.0", async () => {
    const { client, sockets, authority } = createReleasedPeerClient(
      "token-v1.1.7-configure",
      "req-v1.1.7-configure",
    );

    const pending = client.request(
      "agent.configure",
      {
        epicId: "epic-1",
        senderAgentId: "agent-parent",
        agentId: "agent-target",
        harnessId: "cursor",
        model: "cursor-test",
        profileSelection: { kind: "ambient" },
        reasoningEffort: null,
        fastMode: false,
        permissionMode: "full_access",
      },
      authority,
    );
    await flush();
    const stub = sockets[0];
    stub.fireOpen();
    await flush();
    const open = stub.sentFrames[0];
    if (open.kind !== "open") throw new Error("expected open frame");
    stub.fireMessage({
      kind: "openAck",
      manifest: open.manifest,
      optionalManifest: {
        ...open.optionalManifest,
        "agent.configure": { major: 1, minor: 0 },
      },
    });

    await expect(pending).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof HostRpcError &&
        error.code === "DOWNGRADE_UNSUPPORTED" &&
        error.message.includes("Upgrade the host")
      );
    });
    expect(stub.sentFrames.map((frame) => frame.kind)).toEqual(["open"]);
  });
});

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
          clientIdentity: TEST_CLIENT_IDENTITY,
          registry: hostRpcRegistry,
          requestId: () => "req-smoke",
          webSocketFactory: factory,
          dialTimeoutMs: 1000,
          frameTimeoutMs: 1000,
          hostAttestationWindowMs: 0,
          evidence: NO_TRANSPORT_EVIDENCE,
        });

        const pending = client.request(
          "host.status",
          {},
          authorityForContext(ctx),
        );
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
          // A RESPONSE VALID AT THE NEGOTIATED VERSION, not a fixed v1.0 body.
          //
          // This used to serve `{ ready, hostVersion, protocolVersion }`
          // whatever the baseline negotiated, which is a valid response only at
          // host.status@1.0. Against a 1.2 baseline it was already wrong — a
          // real host advertising 1.2 sends all four 1.2 fields — but nothing
          // could notice: `upgradeResponseAlongChain` is the only place the
          // client parses a raw wire result against the negotiated schema, and
          // it runs ONLY when an upgrade is needed. While the client's own
          // latest minor was 2, negotiating 2 meant no upgrade, no parse, and a
          // malformed stub sailed through.
          //
          // The moment the client gained @1.3 the 1.2→1.3 upgrade started
          // firing and the parse rejected it. That is the guard working, not a
          // regression: the frozen 1.2 wire schema is byte-identical to main's
          // (this branch's contract change is purely additive), so a real 1.2
          // peer is unaffected.
          //
          // Serving a superset body is sound because the line is additive and
          // `z.object` is non-strict: extra keys are stripped at the negotiated
          // version, missing ones are not invented.
          const served = {
            ready: true,
            hostVersion: "0.0.0-smoke",
            protocolVersion: { major: 1, minor: 0 },
            busy: false,
            busySessionCount: null,
            updateProgress: null,
            busyBreakdown: null,
          };

          // SELF-CHECKING FIXTURE. Without this, the next released minor a
          // baseline advertises would reintroduce the same defect and surface
          // as the same opaque "does not match the X.Y response schema" — a
          // failure that reads as a protocol break when it is a stale stub.
          const failure = servedResponseMismatch(served, second.schemaVersion);
          expect(failure).toBeNull();

          stub.fireMessage({
            kind: "response",
            requestId: second.requestId,
            method: second.method,
            schemaVersion: second.schemaVersion,
            result: served,
            error: null,
          });
          // The UPGRADED payload, not merely `ready`. The upgrade chain now
          // actually runs for a below-latest baseline, so assert what it
          // produces: absent evidence must arrive as `null`, never as a
          // fabricated capability statement.
          await expect(pending).resolves.toMatchObject({
            ready: true,
            updateOperation: null,
            updateTransaction: null,
          });
        }
      });

      it(`WsRpcClient runs optional fallback against ${baseline.label}`, async () => {
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
        const client = new WsRpcClient<typeof baselineFallbackRegistry>({
          clientIdentity: TEST_CLIENT_IDENTITY,
          registry: baselineFallbackRegistry,
          requestId: () => "req-fallback-smoke",
          webSocketFactory: factory,
          dialTimeoutMs: 1000,
          frameTimeoutMs: 1000,
          hostAttestationWindowMs: 0,
          evidence: NO_TRANSPORT_EVIDENCE,
        });

        const pending = client.request(
          "synthetic.baselineFallback",
          {
            label: "x",
          },
          authorityForContext(ctx),
        );
        await flush();
        expect(sockets).toHaveLength(1);
        const stub = sockets[0];
        stub.fireOpen();
        await flush();
        expect(stub.sentFrames).toHaveLength(1);
        const open = stub.sentFrames[0];
        expect(open.kind).toBe("open");
        if (open.kind === "open") {
          expect(open.manifest["synthetic.baselineFallback"]).toBeUndefined();
          expect(open.optionalManifest?.["synthetic.baselineFallback"]).toEqual(
            { major: 1, minor: 0, supportedMajors: [1] },
          );
        }

        // Released baselines predate the optional channel; omitted
        // optionalManifest must be read as empty and drive the fallback path.
        stub.fireMessage({ kind: "openAck", manifest: unary });
        await flush();

        expect(stub.sentFrames).toHaveLength(2);
        const second = stub.sentFrames[1];
        expect(second.kind).toBe("request");
        if (second.kind !== "request") {
          throw new Error("expected fallback request frame");
        }
        expect(second.method).toBe("host.status");

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
        await expect(pending).resolves.toEqual({ summary: "ready" });
      });

      it(`WsRpcClient throws typed unsupported against ${baseline.label}`, async () => {
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
        const client = new WsRpcClient<typeof baselineUnsupportedRegistry>({
          clientIdentity: TEST_CLIENT_IDENTITY,
          registry: baselineUnsupportedRegistry,
          requestId: () => "req-unsupported-smoke",
          webSocketFactory: factory,
          dialTimeoutMs: 1000,
          frameTimeoutMs: 1000,
          hostAttestationWindowMs: 0,
          evidence: NO_TRANSPORT_EVIDENCE,
        });

        const pending = client.request(
          "synthetic.baselineUnsupported",
          {},
          authorityForContext(ctx),
        );
        await flush();
        expect(sockets).toHaveLength(1);
        const stub = sockets[0];
        stub.fireOpen();
        await flush();
        expect(stub.sentFrames).toHaveLength(1);
        const open = stub.sentFrames[0];
        expect(open.kind).toBe("open");
        if (open.kind === "open") {
          expect(
            open.manifest["synthetic.baselineUnsupported"],
          ).toBeUndefined();
          expect(
            open.optionalManifest?.["synthetic.baselineUnsupported"],
          ).toEqual({ major: 1, minor: 0, supportedMajors: [1] });
        }

        // No optionalManifest on the old ack means the optional method is
        // absent, not fatal to the connection.
        stub.fireMessage({ kind: "openAck", manifest: unary });

        await expect(pending).rejects.toSatisfy((error: unknown) => {
          return (
            error instanceof HostRpcError &&
            error.code === "E_HOST_UNSUPPORTED" &&
            error.fatalDetails?.upgradeGuidance?.hostShouldUpgrade === true
          );
        });
        expect(stub.sentFrames.map((frame) => frame.kind)).not.toContain(
          "request",
        );
      });

      it(`WsStreamClient reaches an open subscription against ${baseline.label}`, async () => {
        const { stream } = readBaselineManifests(baseline.surfacePath);
        // Subscribe to a method every released peer shipped with, so the test
        // exercises the open handshake plus a per-method check that must pass.
        const method = "epic.subscribe";
        expect(
          buildStreamManifest(
            hostStreamRpcRegistry,
            SERVES_EVERY_INSTALLED_MAJOR,
          )[method],
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
          clientIdentity: TEST_CLIENT_IDENTITY,
          registry: hostStreamRpcRegistry,
          endpoint: () => mockLocalHostEntry,
          bearer: () => ctx.credentials,
          auth: null,
          clock: null,
          hostCredentialMint: null,
          onHostCredentialState: null,
          evidence: NO_TRANSPORT_EVIDENCE,
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
        const open = JSON.parse(stub.textSent[0]) as {
          readonly kind: string;
          readonly manifest: Record<string, { major: number; minor: number }>;
          readonly optionalManifest?: Record<
            string,
            { major: number; minor: number }
          >;
        };
        expect(open.kind).toBe("open");
        expect(open.manifest).toEqual(
          buildStreamManifest(
            hostStreamRpcRegistry,
            CLIENT_SERVED_STREAM_MAJORS,
          ),
        );
        expect(open.optionalManifest).toBeUndefined();

        const ackManifest = intersectManifests(stream, open.manifest);
        stub.fireText({
          kind: "openAck",
          manifest: ackManifest,
        });

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
