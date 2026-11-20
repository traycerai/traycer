import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostTokenTable } from "@traycer-clients/shared/auth/host-token-store";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import {
  hostStreamRpcRegistry,
  type HostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import { NO_HOST_TOKEN_PROBE } from "../../../../shared/host-transport/released-sign-on";
import * as releasedSignOn from "@traycer-clients/shared/host-transport/released-sign-on";
import { WsStreamClient } from "../../../../shared/host-transport/ws-stream-client";
import { resetNegotiatedManifests } from "../../../../shared/host-transport/negotiated-manifest-registry";
import { resetNegotiatedStreamVersions } from "../../../../shared/host-transport/negotiated-stream-version-registry";
import type { DialPriority } from "@traycer/protocol/host-transport/dial-priority";
import type {
  StreamWebSocketLike,
  StreamWebSocketMessageEvent,
} from "@traycer/protocol/host-transport/stream-websocket";
import type {
  WebSocketCloseEvent,
  WebSocketErrorEvent,
  WebSocketOpenEvent,
} from "@traycer/protocol/host-transport/websocket";
import { CLI_CLIENT_IDENTITY } from "../../cli-version";
import {
  openCliHostSession,
  type CliHostSession,
} from "../cli-host-tokens";
import { callHostRpcAtEndpoint } from "../host-rpc";
import type { HostAuth } from "../host-auth";

const USER_ID = "user-1";
const HOST_ID = "11111111-1111-4111-8111-111111111111";
const SIGN_IN = "person-sign-in";
const ENDPOINT = { hostId: HOST_ID, websocketUrl: "ws://127.0.0.1:9/rpc" };
const WAIT = { timeout: 2_000, interval: 10 };
const ELEVEN_MINUTES_MS = 11 * 60 * 1000;

type DoorMode = "unavailable" | "unavailable-once" | "not-admitted" | "team" | "other-user";

const harness = vi.hoisted(() => {
  class ScriptSocket implements StreamWebSocketLike {
    onopen: ((event: WebSocketOpenEvent) => void) | null = null;
    onmessage: ((event: StreamWebSocketMessageEvent) => void) | null = null;
    onerror: ((event: WebSocketErrorEvent) => void) | null = null;
    onclose: ((event: WebSocketCloseEvent) => void) | null = null;
    readonly textSent: string[] = [];

    send(data: string | Uint8Array): void {
      if (typeof data !== "string") return;
      this.textSent.push(data);
    }

    close(_code: number, _reason: string): void {}

    fireOpen(): void {
      this.onopen?.({ type: "open" });
    }

    fireFrame(frame: unknown): void {
      this.onmessage?.({ type: "text", data: JSON.stringify(frame) });
    }
  }

  const sockets: ScriptSocket[] = [];
  const state: {
    mode: DoorMode;
    table: HostTokenTable;
    grants: number;
    hung: number;
  } = {
    mode: "unavailable",
    table: new Map(),
    grants: 0,
    hung: 0,
  };
  return { ScriptSocket, sockets, state };
});

const releasedMemory = vi.hoisted(() => {
  const blank = {
    opensReleasedWay: (_userId: string, _hostId: string): boolean => false,
    namedReason: (_hostId: string): boolean => false,
    signInAdmitted: (_userId: string, _hostId: string): void => undefined,
    hostTokenAdmitted: (_hostId: string): void => undefined,
    refusedNamingReason: (_hostId: string): void => undefined,
    forgetAll: (): void => undefined,
  };
  return { current: blank };
});

vi.mock("@traycer-clients/shared/host-transport/released-sign-on", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@traycer-clients/shared/host-transport/released-sign-on")
    >();
  return {
    ...actual,
    processReleasedHosts: {
      opensReleasedWay: (userId: string, hostId: string): boolean =>
        releasedMemory.current.opensReleasedWay(userId, hostId),
      namedReason: (hostId: string): boolean =>
        releasedMemory.current.namedReason(hostId),
      signInAdmitted: (userId: string, hostId: string): void => {
        releasedMemory.current.signInAdmitted(userId, hostId);
      },
      hostTokenAdmitted: (hostId: string): void => {
        releasedMemory.current.hostTokenAdmitted(hostId);
      },
      refusedNamingReason: (hostId: string): void => {
        releasedMemory.current.refusedNamingReason(hostId);
      },
      forgetAll: (): void => {
        releasedMemory.current.forgetAll();
      },
    },
  };
});

vi.mock("../../../../shared/host-transport/whatwg-ws-factory", () => ({
  createWhatwgWebSocketFactory: () => ({
    create: () => {
      const socket = new harness.ScriptSocket();
      harness.sockets.push(socket);
      return socket;
    },
  }),
}));

vi.mock("../host-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../host-auth")>();
  return {
    ...actual,
    resolveHostAuth: async (): Promise<HostAuth> => ({
      token: "person-sign-in",
      authnBaseUrl: "https://authn.test",
      userId: "user-1",
    }),
  };
});

vi.mock("../../store/credentials-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../store/credentials-store")>();
  return {
    ...actual,
    createCliCredentialsStore: () => ({ dispose: () => undefined }),
    createStoreBackedRevalidator: () => ({
      revalidateCurrentContext: async () => "network-error" as const,
    }),
  };
});

vi.mock(
  "@traycer-clients/shared/auth/host-token-file",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/auth/host-token-file")
      >();
    return {
      ...actual,
      createHostTokenFilePersistence: () => ({
        load: async () => harness.state.table,
        update: async (change: (table: HostTokenTable) => HostTokenTable) => {
          harness.state.table = change(harness.state.table);
          return harness.state.table;
        },
      }),
    };
  },
);

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function ownershipBody(): unknown {
  if (harness.state.mode === "team") {
    return {
      hosts: [
        {
          hostId: HOST_ID,
          owner: { kind: "team", id: "team-1", name: "Team" },
          kind: "machine",
          remoteAccess: false,
        },
      ],
    };
  }
  return {
    hosts: [
      {
        hostId: HOST_ID,
        owner: { kind: "user", id: "someone-else" },
        kind: "personal",
        remoteAccess: false,
      },
    ],
  };
}

function installFetch(): void {
  vi.stubGlobal(
    "fetch",
    async (
      input: RequestInfo | URL,
      init: RequestInit | undefined,
    ): Promise<Response> => {
      const url = new URL(requestUrl(input));
      const method = init?.method ?? "GET";
      if (url.pathname === "/api/v3/hosts" && method === "GET") {
        if (harness.state.mode === "team" || harness.state.mode === "other-user") {
          return jsonResponse(ownershipBody(), 200);
        }
        return jsonResponse({ message: "missing" }, 404);
      }
      if (method === "POST" && url.pathname.endsWith("/session-grant")) {
        harness.state.grants += 1;
        if (harness.state.mode === "unavailable-once") {
          if (harness.state.grants === 1) {
            return jsonResponse({ message: "offline" }, 503);
          }
          harness.state.hung += 1;
          return new Promise<Response>(() => undefined);
        }
        if (
          harness.state.mode === "unavailable"
        ) {
          return jsonResponse({ message: "offline" }, 503);
        }
        return jsonResponse({ message: "missing" }, 404);
      }
      return jsonResponse({ url: url.toString() }, 500);
    },
  );
}

function expiredJwt(nowMs: number): { readonly token: string; readonly expiresAtMs: number } {
  const expiresAtMs = nowMs - ELEVEN_MINUTES_MS;
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(expiresAtMs / 1000) }),
  ).toString("base64url");
  return { token: `${header}.${payload}.`, expiresAtMs };
}

function hold(token: { readonly token: string; readonly expiresAtMs: number }): void {
  harness.state.table = new Map([
    [USER_ID, new Map([[HOST_ID, token]])],
  ]);
}

function readObject(raw: string): Record<string, unknown> {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("frame was not an object");
  }
  const frame: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    frame[key] = entry;
  }
  return frame;
}

function openToken(socket: InstanceType<typeof harness.ScriptSocket>): unknown {
  for (const raw of socket.textSent) {
    const frame = readObject(raw);
    if (frame.kind === "open") return frame.token;
  }
  return undefined;
}

async function socketAt(
  index: number,
): Promise<InstanceType<typeof harness.ScriptSocket>> {
  await vi.waitFor(() => expect(harness.sockets.length).toBeGreaterThan(index), WAIT);
  const socket = harness.sockets[index];
  if (socket === undefined) throw new Error("socket missing");
  return socket;
}

async function readOpen(
  socket: InstanceType<typeof harness.ScriptSocket>,
): Promise<Record<string, unknown>> {
  socket.fireOpen();
  await vi.waitFor(() => expect(openToken(socket)).toBeDefined(), WAIT);
  const raw = socket.textSent.find((line) => readObject(line).kind === "open");
  if (raw === undefined) throw new Error("open frame missing");
  return readObject(raw);
}

function namedProbeRefusal(): {
  readonly kind: "fatalError";
  readonly details: {
    readonly code: "UNAUTHORIZED";
    readonly reason: string;
    readonly doorReason: "not_admitted";
    readonly retryable: false;
    readonly incompatibleMethods: null;
    readonly upgradeGuidance: null;
  };
} {
  return {
    kind: "fatalError",
    details: {
      code: "UNAUTHORIZED",
      reason: "current-host-refusal",
      doorReason: "not_admitted",
      retryable: false,
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  };
}

function releasedRefusal(): {
  readonly kind: "fatalError";
  readonly details: {
    readonly code: "UNAUTHORIZED";
    readonly reason: string;
    readonly incompatibleMethods: null;
    readonly upgradeGuidance: null;
  };
} {
  return {
    kind: "fatalError",
    details: {
      code: "UNAUTHORIZED",
      reason: "released-host-token-refusal",
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  };
}

async function admitStatus(
  socket: InstanceType<typeof harness.ScriptSocket>,
  open: Record<string, unknown>,
): Promise<void> {
  socket.fireFrame({
    kind: "openAck",
    manifest: open.manifest,
    optionalManifest: open.optionalManifest,
  });
  await vi.waitFor(() => expect(socket.textSent.length).toBeGreaterThanOrEqual(2), WAIT);
  const request = socket.textSent
    .map((line) => readObject(line))
    .find((frame) => frame.kind === "request");
  if (request === undefined) throw new Error("status request missing");
  socket.fireFrame({
    kind: "response",
    requestId: request.requestId,
    method: "host.status",
    schemaVersion: request.schemaVersion,
    result: {
      ready: true,
      hostVersion: "1.5.4",
      protocolVersion: { major: 1, minor: 0 },
    },
    error: null,
  });
}

const streams: WsStreamClient<HostStreamRpcRegistry>[] = [];

function auth(): HostAuth {
  return {
    token: SIGN_IN,
    authnBaseUrl: "https://authn.test",
    userId: USER_ID,
  };
}

async function openStream(session: CliHostSession): Promise<void> {
  const client = new WsStreamClient<HostStreamRpcRegistry>({
    registry: hostStreamRpcRegistry,
    hostId: HOST_ID,
    endpoint: () => ENDPOINT,
    bearer: session.tokens.streamBearer(HOST_ID),
    presentsHeldPastExpiry: () => session.tokens.presentsHeldPastExpiry(HOST_ID),
    releasedSignOn: session.releasedSignOn,
    userId: USER_ID,
    auth: session.tokens.streamRecovery(HOST_ID),
    clock: null,
    hostCredentialMint: null,
    onHostCredentialState: null,
    evidence: NO_TRANSPORT_EVIDENCE,
    webSocketFactory: {
      create: (_url: string, _priority: DialPriority): StreamWebSocketLike => {
        const socket = new harness.ScriptSocket();
        harness.sockets.push(socket);
        return socket;
      },
    },
    dialTimeoutMs: 1_000,
    openAckTimeoutMs: 1_000,
    pingIntervalMs: 25_000,
    pongTimeoutMs: 50_000,
    initialBackoffMs: 10,
    maxBackoffMs: 1_000,
    clientIdentity: CLI_CLIENT_IDENTITY,
  });
  streams.push(client);
  client.subscribe("host.notifications.subscribe", {
    filter: "unread",
    initialLimit: 1,
  });
}

beforeEach(() => {
  let create: typeof releasedSignOn.createReleasedHostMemory | undefined;
  try {
    create = releasedSignOn.createReleasedHostMemory;
  } catch (error: unknown) {
    if (
      !(error instanceof Error) ||
      !error.message.includes('No "createReleasedHostMemory" export')
    ) {
      throw error;
    }
  }
  if (typeof create === "function") releasedMemory.current = create();
  harness.sockets.splice(0);
  harness.state.mode = "unavailable";
  harness.state.table = new Map();
  harness.state.grants = 0;
  harness.state.hung = 0;
  installFetch();
});

afterEach(() => {
  for (const client of streams.splice(0)) client.close("test complete");
  resetNegotiatedManifests();
  resetNegotiatedStreamVersions();
  vi.unstubAllGlobals();
});

describe("CLI local doors while authn cannot mint", () => {
  it("reaches the host with the held expired token and does not start another mint", async () => {
    const expired = expiredJwt(Date.now());
    hold(expired);
    harness.state.mode = "unavailable-once";
    const pending = callHostRpcAtEndpoint("host.status", {}, ENDPOINT);
    const socket = await socketAt(0);
    const open = await readOpen(socket);
    expect(open.token).toBe(expired.token);
    expect(harness.state.grants).toBe(1);
    expect(harness.state.hung).toBe(0);
    await admitStatus(socket, open);
    await expect(pending).resolves.toMatchObject({ ready: true });
    expect(harness.state.grants).toBe(1);
  });

  it("opens a released host with the sign-in after the held expired token is refused", async () => {
    const expired = expiredJwt(Date.now());
    hold(expired);
    harness.state.mode = "unavailable";
    const pending = callHostRpcAtEndpoint("host.status", {}, ENDPOINT);
    const first = await socketAt(0);
    const refused = await readOpen(first);
    expect(refused.token).toBe(expired.token);
    first.fireFrame(releasedRefusal());
    const second = await socketAt(1);
    const open = await readOpen(second);
    expect(open.token).toBe(SIGN_IN);
    await admitStatus(second, open);
    await expect(pending).resolves.toMatchObject({ ready: true });
  });

  it("returns a session whose call and stream reach the host with the sign-in when none is held", async () => {
    harness.state.mode = "unavailable";
    const opened = await openCliHostSession(auth(), HOST_ID, false, null);
    expect(opened.kind).toBe("ok");
    if (opened.kind !== "ok") {
      throw new Error("session did not open");
    }
    await openStream(opened.session);
    const streamProbe = await socketAt(0);
    const streamProbed = await readOpen(streamProbe);
    expect(streamProbed.token).toBe(NO_HOST_TOKEN_PROBE);
    streamProbe.fireFrame(releasedRefusal());
    const streamSocket = await socketAt(1);
    const streamOpen = await readOpen(streamSocket);
    expect(streamOpen.token).toBe(SIGN_IN);
    streamSocket.fireFrame({
      kind: "openAck",
      manifest: streamOpen.manifest,
      optionalManifest: streamOpen.optionalManifest,
    });
    opened.session.dispose();
    const start = harness.sockets.length;
    const pending = callHostRpcAtEndpoint("host.status", {}, ENDPOINT);
    const unary = await socketAt(start);
    const open = await readOpen(unary);
    expect(open.token).toBe(SIGN_IN);
    await admitStatus(unary, open);
    await expect(pending).resolves.toMatchObject({ ready: true });
  });

  it("opens with the placeholder, then the sign-in, when authn has no row for this computer", async () => {
    harness.state.mode = "not-admitted";
    const pending = callHostRpcAtEndpoint("host.status", {}, ENDPOINT);
    const probe = await socketAt(0);
    const probed = await readOpen(probe);
    expect(probed.token).toBe(NO_HOST_TOKEN_PROBE);
    probe.fireFrame(releasedRefusal());
    const socket = await socketAt(1);
    const open = await readOpen(socket);
    expect(open.token).toBe(SIGN_IN);
    await admitStatus(socket, open);
    await expect(pending).resolves.toMatchObject({ ready: true });
  });

  it("sends only the placeholder to a current host when the app is offline and no token is held", async () => {
    harness.state.mode = "unavailable";
    const pending = callHostRpcAtEndpoint("host.status", {}, ENDPOINT);
    const probe = await socketAt(0);
    const probed = await readOpen(probe);
    expect(probed.token).toBe(NO_HOST_TOKEN_PROBE);
    probe.fireFrame(namedProbeRefusal());
    await expect(pending).rejects.toThrow();
    expect(harness.sockets).toHaveLength(1);
    expect(openToken(probe)).toBe(NO_HOST_TOKEN_PROBE);
    expect(harness.sockets.map((socket) => openToken(socket))).not.toContain(
      SIGN_IN,
    );
  });

  it.each([
    { name: "a team row", mode: "team" as const },
    { name: "another person's row", mode: "other-user" as const },
  ])("never sends the sign-in for $name", async ({ mode }) => {
    harness.state.mode = mode;
    await expect(
      callHostRpcAtEndpoint("host.status", {}, ENDPOINT),
    ).rejects.toThrow();
    expect(harness.sockets.map((socket) => openToken(socket))).not.toContain(
      SIGN_IN,
    );
  });
});
