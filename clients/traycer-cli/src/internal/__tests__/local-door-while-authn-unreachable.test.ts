import { NO_HOST_TOKEN_PROBE } from "@traycer/protocol/framework/door-reason";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostTokenTable } from "@traycer-clients/shared/auth/host-token-store";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import {
  hostStreamRpcRegistry,
  type HostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import {
  createReleasedHostMemory,
  processReleasedHosts,
  type HostInstance,
  type InvitationMark,
  type ReleasedHostMemory,
} from "@traycer-clients/shared/host-transport/released-sign-on";
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
import { openCliHostSession, type CliHostSession } from "../cli-host-tokens";
import { callHostRpcAtEndpoint, toAgentCliError } from "../host-rpc";
import { UNWORDED_MINT_REFUSAL_MESSAGE } from "../host-door-words";
import type { HostAuth } from "../host-auth";
import { CLI_ERROR_CODES } from "../../runner/errors";

const USER_ID = "user-1";
const HOST_ID = "11111111-1111-4111-8111-111111111111";
const SIGN_IN = "person-sign-in";
const ENDPOINT = { hostId: HOST_ID, websocketUrl: "ws://127.0.0.1:9/rpc" };
const UNARY_HOST_ID = "22222222-2222-4222-8222-222222222222";
const UNARY_ENDPOINT = { ...ENDPOINT, hostId: UNARY_HOST_ID };
const WAIT = { timeout: 2_000, interval: 10 };
const ELEVEN_MINUTES_MS = 11 * 60 * 1000;

type DoorMode =
  | "unavailable"
  | "unavailable-once"
  | "not-admitted"
  | "black-hole";

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
    hostRowReads: string[];
  } = {
    mode: "unavailable",
    table: new Map(),
    grants: 0,
    hung: 0,
    hostRowReads: [],
  };
  return { ScriptSocket, sockets, state };
});

const releasedMemory = vi.hoisted(() => {
  let current: ReleasedHostMemory | undefined;
  return {
    install(memory: ReleasedHostMemory): void {
      current = memory;
    },
    read(): ReleasedHostMemory {
      if (current === undefined) {
        throw new Error("released host memory is not installed");
      }
      return current;
    },
  };
});

vi.mock(
  "@traycer-clients/shared/host-transport/released-sign-on",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-transport/released-sign-on")
      >();
    return {
      ...actual,
      processReleasedHosts: {
        currentInstance: (hostId: string): HostInstance =>
          releasedMemory.read().currentInstance(hostId),
        isCurrent: (instance: HostInstance): boolean =>
          releasedMemory.read().isCurrent(instance),
        observeInstance: (hostId: string, observed: string): void => {
          releasedMemory.read().observeInstance(hostId, observed);
        },
        opensReleasedWay: (userId: string, hostId: string): boolean =>
          releasedMemory.read().opensReleasedWay(userId, hostId),
        namedReason: (hostId: string): boolean =>
          releasedMemory.read().namedReason(hostId),
        signInAdmitted: (userId: string, instance: HostInstance): void => {
          releasedMemory.read().signInAdmitted(userId, instance);
        },
        hostTokenAdmitted: (instance: HostInstance): void => {
          releasedMemory.read().hostTokenAdmitted(instance);
        },
        refusedNamingReason: (
          instance: HostInstance,
          invitation: boolean,
        ): void => {
          releasedMemory.read().refusedNamingReason(instance, invitation);
        },
        invitationHeard: (instance: HostInstance): InvitationMark =>
          releasedMemory.read().invitationHeard(instance),
        invitationWithdrawn: (mark: InvitationMark): boolean =>
          releasedMemory.read().invitationWithdrawn(mark),
        declineProbe: (userId: string, instance: HostInstance): void => {
          releasedMemory.read().declineProbe(userId, instance);
        },
        probeDeclined: (userId: string, hostId: string): boolean =>
          releasedMemory.read().probeDeclined(userId, hostId),
        invitedSignInPending: (hostId: string): boolean =>
          releasedMemory.read().invitedSignInPending(hostId),
        invitedSignInWritten: (instance: HostInstance): void => {
          releasedMemory.read().invitedSignInWritten(instance);
        },
        invitedSignInAnswered: (instance: HostInstance): void => {
          releasedMemory.read().invitedSignInAnswered(instance);
        },
        forgetAll: (): void => {
          releasedMemory.read().forgetAll();
        },
      } satisfies ReleasedHostMemory,
    };
  },
);

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
        // The host's row is read by nothing on this machine's doors. A read
        // that happened would never be answered, as when authn is silent.
        harness.state.hostRowReads.push(url.pathname);
        return new Promise<Response>(() => undefined);
      }
      if (method === "POST" && url.pathname.endsWith("/session-grant")) {
        harness.state.grants += 1;
        if (harness.state.mode === "black-hole") {
          harness.state.hung += 1;
          return new Promise<Response>(() => undefined);
        }
        if (harness.state.mode === "unavailable-once") {
          if (harness.state.grants === 1) {
            return jsonResponse({ message: "offline" }, 503);
          }
          harness.state.hung += 1;
          return new Promise<Response>(() => undefined);
        }
        if (harness.state.mode === "unavailable") {
          return jsonResponse({ message: "offline" }, 503);
        }
        return jsonResponse({ message: "missing" }, 404);
      }
      return jsonResponse({ url: url.toString() }, 500);
    },
  );
}

function expiredJwt(nowMs: number): {
  readonly token: string;
  readonly expiresAtMs: number;
} {
  const expiresAtMs = nowMs - ELEVEN_MINUTES_MS;
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(expiresAtMs / 1000) }),
  ).toString("base64url");
  return { token: `${header}.${payload}.`, expiresAtMs };
}

function hold(token: {
  readonly token: string;
  readonly expiresAtMs: number;
}): void {
  harness.state.table = new Map([[USER_ID, new Map([[HOST_ID, token]])]]);
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
  await vi.waitFor(
    () => expect(harness.sockets.length).toBeGreaterThan(index),
    WAIT,
  );
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

function ownerSignInRefusal(): {
  readonly kind: "fatalError";
  readonly details: {
    readonly code: "UNAUTHORIZED";
    readonly reason: string;
    readonly doorReason: "owner_sign_in";
    readonly retryable: false;
    readonly incompatibleMethods: null;
    readonly upgradeGuidance: null;
  };
} {
  return {
    kind: "fatalError",
    details: {
      code: "UNAUTHORIZED",
      reason: "current personal host invited sign-in",
      doorReason: "owner_sign_in",
      retryable: false,
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  };
}

function notProvisionedRefusal(): {
  readonly kind: "fatalError";
  readonly details: {
    readonly code: "UNAUTHORIZED";
    readonly reason: string;
    readonly doorReason: "not_provisioned";
    readonly retryable: false;
    readonly incompatibleMethods: null;
    readonly upgradeGuidance: null;
  };
} {
  return {
    kind: "fatalError",
    details: {
      code: "UNAUTHORIZED",
      reason:
        "Host is not provisioned - run `traycer login` on the host machine to authorize it",
      doorReason: "not_provisioned",
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

function expiredTokenRefusal(): {
  readonly kind: "fatalError";
  readonly details: {
    readonly code: "UNAUTHORIZED";
    readonly reason: string;
    readonly doorReason: "token_expired";
    readonly retryable: false;
    readonly incompatibleMethods: null;
    readonly upgradeGuidance: null;
  };
} {
  return {
    kind: "fatalError",
    details: {
      code: "UNAUTHORIZED",
      reason: "host token expired",
      doorReason: "token_expired",
      retryable: false,
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
  await vi.waitFor(
    () => expect(socket.textSent.length).toBeGreaterThanOrEqual(2),
    WAIT,
  );
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
  releasedMemory.install(createReleasedHostMemory());
  harness.sockets.splice(0);
  harness.state.mode = "unavailable";
  harness.state.table = new Map();
  harness.state.grants = 0;
  harness.state.hung = 0;
  harness.state.hostRowReads = [];
  installFetch();
});

afterEach(() => {
  for (const client of streams.splice(0)) client.close("test complete");
  resetNegotiatedManifests();
  resetNegotiatedStreamVersions();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("CLI local doors while authn cannot mint", () => {
  it("reports not_provisioned and probes again after this computer is enrolled", async () => {
    harness.state.mode = "unavailable";
    const firstCall = callHostRpcAtEndpoint("host.status", {}, ENDPOINT);
    const firstProbe = await socketAt(0);
    expect((await readOpen(firstProbe)).token).toBe(NO_HOST_TOKEN_PROBE);
    firstProbe.fireFrame(notProvisionedRefusal());
    await expect(toAgentCliError(firstCall)).rejects.toMatchObject({
      code: CLI_ERROR_CODES.AUTH_REJECTED,
      exitCode: 1,
      message:
        "Host is not provisioned - run `traycer login` on the host machine to authorize it",
    });

    const secondCall = callHostRpcAtEndpoint("host.status", {}, ENDPOINT);
    const enrolledProbe = await socketAt(1);
    expect((await readOpen(enrolledProbe)).token).toBe(NO_HOST_TOKEN_PROBE);
    enrolledProbe.fireFrame({
      kind: "fatalError",
      details: {
        code: "UNAUTHORIZED",
        reason: "owner sign-in invited",
        doorReason: "owner_sign_in",
        retryable: false,
        incompatibleMethods: null,
        upgradeGuidance: null,
      },
    });
    const invited = await socketAt(2);
    const open = await readOpen(invited);
    expect(open.token).toBe(SIGN_IN);
    await admitStatus(invited, open);
    await expect(secondCall).resolves.toMatchObject({ ready: true });
    expect(harness.sockets.map((socket) => openToken(socket))).toEqual([
      NO_HOST_TOKEN_PROBE,
      NO_HOST_TOKEN_PROBE,
      SIGN_IN,
    ]);
  });

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

  it("probes after the held token is refused, then signs in when invited", async () => {
    const expired = expiredJwt(Date.now());
    hold(expired);
    harness.state.mode = "unavailable";
    const pending = callHostRpcAtEndpoint("host.status", {}, ENDPOINT);
    const first = await socketAt(0);
    const refused = await readOpen(first);
    expect(refused.token).toBe(expired.token);
    first.fireFrame(expiredTokenRefusal());
    const probe = await socketAt(1);
    expect((await readOpen(probe)).token).toBe(NO_HOST_TOKEN_PROBE);
    probe.fireFrame(ownerSignInRefusal());
    const invited = await socketAt(2);
    const open = await readOpen(invited);
    expect(open.token).toBe(SIGN_IN);
    await admitStatus(invited, open);
    await expect(pending).resolves.toMatchObject({ ready: true });
    expect(harness.sockets.map((socket) => openToken(socket))).toEqual([
      expired.token,
      NO_HOST_TOKEN_PROBE,
      SIGN_IN,
    ]);
  });

  it("sends sign-in on current-personal stream and unary invitations", async () => {
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
    streamProbe.fireFrame(ownerSignInRefusal());
    const streamSocket = await socketAt(1);
    const streamOpen = await readOpen(streamSocket);
    expect(streamOpen.token).toBe(SIGN_IN);
    streamSocket.fireFrame({
      kind: "openAck",
      manifest: streamOpen.manifest,
      optionalManifest: streamOpen.optionalManifest,
    });
    opened.session.dispose();
    expect(processReleasedHosts.opensReleasedWay(USER_ID, HOST_ID)).toBe(false);
    const start = harness.sockets.length;
    const pending = callHostRpcAtEndpoint("host.status", {}, UNARY_ENDPOINT);
    const unary = await socketAt(start);
    const unaryProbe = await readOpen(unary);
    expect(unaryProbe.token).toBe(NO_HOST_TOKEN_PROBE);
    unary.fireFrame(ownerSignInRefusal());
    const unaryInvited = await socketAt(start + 1);
    const open = await readOpen(unaryInvited);
    expect(open.token).toBe(SIGN_IN);
    await admitStatus(unaryInvited, open);
    await expect(pending).resolves.toMatchObject({ ready: true });
    expect(processReleasedHosts.opensReleasedWay(USER_ID, UNARY_HOST_ID)).toBe(
      false,
    );
    expect(harness.sockets.map((socket) => openToken(socket))).toEqual([
      NO_HOST_TOKEN_PROBE,
      SIGN_IN,
      NO_HOST_TOKEN_PROBE,
      SIGN_IN,
    ]);
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
    await expect(toAgentCliError(pending)).rejects.toMatchObject({
      exitCode: 1,
      message: "No host-only token is held for this host",
    });
    expect(harness.sockets).toHaveLength(1);
    expect(openToken(probe)).toBe(NO_HOST_TOKEN_PROBE);
    const retry = callHostRpcAtEndpoint("host.status", {}, ENDPOINT);
    await expect(toAgentCliError(retry)).rejects.toMatchObject({
      exitCode: 1,
      message: "No host-only token is held for this host",
    });
    expect(harness.sockets).toHaveLength(1);
  });

  it("opens the sign-in at once after a released host refuses the held token while authn answers nothing", async () => {
    vi.useFakeTimers();
    harness.state.mode = "unavailable-once";
    const expired = expiredJwt(Date.now());
    hold(expired);
    const pending = callHostRpcAtEndpoint("host.status", {}, ENDPOINT);
    const refused = await socketAt(0);
    expect((await readOpen(refused)).token).toBe(expired.token);
    refused.fireFrame(releasedRefusal());
    const invited = await socketAt(1);
    const open = await readOpen(invited);
    expect(open.token).toBe(SIGN_IN);
    await admitStatus(invited, open);
    await expect(pending).resolves.toMatchObject({ ready: true });
    expect(harness.sockets.map((socket) => openToken(socket))).toEqual([
      expired.token,
      SIGN_IN,
    ]);
    expect(harness.state.hostRowReads).toEqual([]);
  });

  it("opens the stream's sign-in at once after a released host refuses the probe, and again after a drop, while authn answers nothing", async () => {
    vi.useFakeTimers();
    harness.state.mode = "unavailable";
    const opened = await openCliHostSession(auth(), HOST_ID, false, null);
    expect(opened.kind).toBe("ok");
    if (opened.kind !== "ok") throw new Error("session did not open");
    await openStream(opened.session);
    for (const first of [0, 2]) {
      const probe = await socketAt(first);
      expect((await readOpen(probe)).token).toBe(NO_HOST_TOKEN_PROBE);
      probe.fireFrame(releasedRefusal());
      const invited = await socketAt(first + 1);
      const open = await readOpen(invited);
      expect(open.token).toBe(SIGN_IN);
      invited.fireFrame({
        kind: "openAck",
        manifest: open.manifest,
        optionalManifest: open.optionalManifest,
      });
      if (first === 0)
        invited.onclose?.({ code: 1006, reason: "drop", wasClean: false });
    }
    expect(harness.sockets.map((socket) => openToken(socket))).toEqual([
      NO_HOST_TOKEN_PROBE,
      SIGN_IN,
      NO_HOST_TOKEN_PROBE,
      SIGN_IN,
    ]);
    expect(harness.state.hostRowReads).toEqual([]);
    opened.session.dispose();
  });

  it("re-presents the held expired token after a current host names the probe's refusal", async () => {
    harness.state.mode = "unavailable";
    const expired = expiredJwt(Date.now());
    hold(expired);
    const firstCall = callHostRpcAtEndpoint("host.status", {}, ENDPOINT);
    const first = await socketAt(0);
    expect((await readOpen(first)).token).toBe(expired.token);
    first.fireFrame(expiredTokenRefusal());
    const probe = await socketAt(1);
    expect((await readOpen(probe)).token).toBe(NO_HOST_TOKEN_PROBE);
    probe.fireFrame(namedProbeRefusal());
    await expect(toAgentCliError(firstCall)).rejects.toMatchObject({
      exitCode: 1,
    });

    const nextCall = callHostRpcAtEndpoint("host.status", {}, ENDPOINT);
    const second = await socketAt(2);
    const open = await readOpen(second);
    expect(open.token).toBe(expired.token);
    await admitStatus(second, open);
    await expect(nextCall).resolves.toMatchObject({ ready: true });
    expect(harness.sockets.map((socket) => openToken(socket))).toEqual([
      expired.token,
      NO_HOST_TOKEN_PROBE,
      expired.token,
    ]);
    expect(harness.state.hostRowReads).toEqual([]);
  });

  it("never sends the sign-in when a current host names the probe's refusal after authn has no row for this computer", async () => {
    harness.state.mode = "not-admitted";
    const pending = callHostRpcAtEndpoint("host.status", {}, ENDPOINT);
    const probe = await socketAt(0);
    expect((await readOpen(probe)).token).toBe(NO_HOST_TOKEN_PROBE);
    probe.fireFrame(namedProbeRefusal());
    await expect(toAgentCliError(pending)).rejects.toMatchObject({
      exitCode: 1,
    });
    expect(harness.sockets.map((socket) => openToken(socket))).toEqual([
      NO_HOST_TOKEN_PROBE,
    ]);
    expect(harness.state.hostRowReads).toEqual([]);
  });

  describe("a held token the clock calls usable, which the host refuses as expired", () => {
    const CACHED = "cached-token-the-clock-calls-usable";

    function holdUsable(): void {
      hold({ token: CACHED, expiresAtMs: Date.now() + 60 * 60 * 1000 });
    }

    it("unary: asks authn for a fresh mint, and the next call opens the placeholder", async () => {
      holdUsable();
      const refused = callHostRpcAtEndpoint("host.status", {}, ENDPOINT);
      const first = await socketAt(0);
      expect((await readOpen(first)).token).toBe(CACHED);
      expect(harness.state.grants).toBe(0);

      first.fireFrame(expiredTokenRefusal());

      await expect(toAgentCliError(refused)).rejects.toMatchObject({
        exitCode: 1,
      });
      await vi.waitFor(
        () => expect(harness.state.grants).toBeGreaterThan(0),
        WAIT,
      );
      const next = callHostRpcAtEndpoint("host.status", {}, ENDPOINT);
      const probe = await socketAt(1);
      expect((await readOpen(probe)).token).toBe(NO_HOST_TOKEN_PROBE);
      probe.fireFrame(namedProbeRefusal());
      // A current host named its refusal of the probe: the held token is
      // presented again, and the host admits it.
      const again = await socketAt(2);
      const open = await readOpen(again);
      expect(open.token).toBe(CACHED);
      await admitStatus(again, open);
      await expect(next).resolves.toMatchObject({ ready: true });
    });

    it("stream: opens the placeholder next and asks authn for a fresh mint", async () => {
      holdUsable();
      const opened = await openCliHostSession(auth(), HOST_ID, false, null);
      if (opened.kind !== "ok") throw new Error("session did not open");
      await openStream(opened.session);
      const first = await socketAt(0);
      expect((await readOpen(first)).token).toBe(CACHED);
      expect(harness.state.grants).toBe(0);

      first.fireFrame(expiredTokenRefusal());

      const probe = await socketAt(1);
      expect((await readOpen(probe)).token).toBe(NO_HOST_TOKEN_PROBE);
      await vi.waitFor(
        () => expect(harness.state.grants).toBeGreaterThan(0),
        WAIT,
      );
      opened.session.dispose();
    });
  });
});

describe("CLI local doors while authn takes the mint and never answers it", () => {
  // The mint's own request deadline: past it the mint answers `unavailable`.
  const MINT_BUDGET_MS = 10_000;
  const FIRST_OPEN = "the first socket opens at once with the probe";
  const THREE_HOSTS = [
    {
      host: "a released host",
      refusal: releasedRefusal(),
      sendsSignIn: true,
    },
    {
      host: "a current personal host",
      refusal: ownerSignInRefusal(),
      sendsSignIn: true,
    },
    {
      host: "a current team host",
      refusal: namedProbeRefusal(),
      sendsSignIn: false,
    },
  ] as const;

  beforeEach(() => {
    vi.useFakeTimers();
    harness.state.mode = "black-hole";
  });

  /** Opens every socket the transport dials from now on, as the host would. */
  async function openEveryRedial(
    opened: Set<InstanceType<typeof harness.ScriptSocket>>,
    forMs: number,
  ): Promise<void> {
    for (let elapsed = 0; elapsed < forMs; elapsed += 500) {
      await vi.advanceTimersByTimeAsync(500);
      for (const socket of harness.sockets) {
        if (opened.has(socket)) continue;
        opened.add(socket);
        socket.fireOpen();
      }
    }
  }

  it.each(THREE_HOSTS)(
    `unary: ${FIRST_OPEN} for $host`,
    async ({ refusal, sendsSignIn }) => {
      const settled = callHostRpcAtEndpoint("host.status", {}, ENDPOINT).then(
        (value) => ({ value, error: null }),
        (error: unknown) => ({ value: null, error }),
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(harness.sockets).toHaveLength(1);
      const first = await socketAt(0);
      expect((await readOpen(first)).token).toBe(NO_HOST_TOKEN_PROBE);
      expect(harness.state.hung).toBeGreaterThan(0);
      first.fireFrame(refusal);

      if (sendsSignIn) {
        const invited = await socketAt(1);
        const open = await readOpen(invited);
        expect(open.token).toBe(SIGN_IN);
        await admitStatus(invited, open);
        expect((await settled).value).toMatchObject({ ready: true });
        return;
      }
      // A current team host takes no sign-in: only the mint's token opens it,
      // and the call waits for that alone, for as long as the mint may take.
      await openEveryRedial(new Set([first]), MINT_BUDGET_MS - 1_000);
      expect(harness.sockets.map((socket) => openToken(socket))).toEqual([
        NO_HOST_TOKEN_PROBE,
      ]);
      expect(await Promise.race([settled, Promise.resolve("waiting")])).toBe(
        "waiting",
      );
      await vi.advanceTimersByTimeAsync(2_000);
      expect((await settled).error).toMatchObject({
        message: "No host-only token is held for this host",
      });
      expect(harness.sockets).toHaveLength(1);
    },
  );

  it.each(THREE_HOSTS)(
    `stream: ${FIRST_OPEN} for $host`,
    async ({ refusal, sendsSignIn }) => {
      const opened = await openCliHostSession(auth(), HOST_ID, false, null);
      if (opened.kind !== "ok") throw new Error("session did not open");
      await openStream(opened.session);

      await vi.advanceTimersByTimeAsync(0);
      expect(harness.sockets).toHaveLength(1);
      const first = await socketAt(0);
      expect((await readOpen(first)).token).toBe(NO_HOST_TOKEN_PROBE);
      expect(harness.state.hung).toBeGreaterThan(0);
      first.fireFrame(refusal);

      if (sendsSignIn) {
        const invited = await socketAt(1);
        expect((await readOpen(invited)).token).toBe(SIGN_IN);
      } else {
        await openEveryRedial(new Set([first]), MINT_BUDGET_MS);
        expect(
          harness.sockets.map((socket) => openToken(socket)),
        ).not.toContain(SIGN_IN);
      }
      opened.session.dispose();
    },
  );

  it("unary: opens a held token that ran out at once, with the mint unanswered", async () => {
    const expired = expiredJwt(Date.now());
    hold(expired);
    const pending = callHostRpcAtEndpoint("host.status", {}, ENDPOINT);

    await vi.advanceTimersByTimeAsync(0);
    expect(harness.sockets).toHaveLength(1);
    const socket = await socketAt(0);
    const open = await readOpen(socket);
    expect(open.token).toBe(expired.token);
    await admitStatus(socket, open);
    await expect(pending).resolves.toMatchObject({ ready: true });
    expect(harness.state.hostRowReads).toEqual([]);
  });

  it("stream: opens a held token that ran out at once, with the mint unanswered", async () => {
    const expired = expiredJwt(Date.now());
    hold(expired);
    const opened = await openCliHostSession(auth(), HOST_ID, false, null);
    if (opened.kind !== "ok") throw new Error("session did not open");
    await openStream(opened.session);

    await vi.advanceTimersByTimeAsync(0);
    expect(harness.sockets).toHaveLength(1);
    const socket = await socketAt(0);
    expect((await readOpen(socket)).token).toBe(expired.token);
    expect(harness.state.hostRowReads).toEqual([]);
    opened.session.dispose();
  });
});
