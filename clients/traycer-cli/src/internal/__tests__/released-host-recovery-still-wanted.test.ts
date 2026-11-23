import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";
import { processReleasedHosts } from "@traycer-clients/shared/host-transport/released-sign-on";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { StoredCredentials } from "@traycer/protocol/config/credentials";
import type { HostTokenTable } from "../../../../shared/auth/host-token-store";
import {
  makeStubSocketFactory,
  type StubStreamWebSocket,
} from "../../../../shared/host-transport/__testing__/stub-stream-socket";
import { WsStreamClient } from "../../../../shared/host-transport/ws-stream-client";
import type { Environment } from "../../runner/environment";
import { createCliCredentialsStore } from "../../store/credentials-store";
import {
  callHostRpcAtResolvedEndpoint,
  PLAIN_DISPATCH,
  toAgentCliError,
} from "../host-rpc";
import { requireCliHostSession } from "../cli-host-tokens";

// A refused sign-in's recovery, as the CLI wires it (the real token source, the
// real credentials store over a file in a temp directory, the real stream and
// unary clients), with the recovery's adopting read of the stored sign-in held.
// The caller that asked for the recovery ends while that read is held: nothing
// may start a rotation afterwards, neither a refresh at authn nor the store's.

const USER_ID = "user-1";
const SIGN_IN = "still-wanted-sign-in";
const HELD_TOKEN = "still-wanted-held-host-token";
const WAIT = { timeout: 2_000, interval: 10 };
/** Past the longest redial backoff: a negative assertion is a fake-clock advance past its budget. */
const PAST_EVERY_BACKOFF_MS = 120_000;

const harness = vi.hoisted(() => {
  class UnarySocket {
    onopen: ((event: { readonly type: "open" }) => void) | null = null;
    onmessage: ((event: { readonly data: string }) => void) | null = null;
    onerror: ((event: { readonly type: "error" }) => void) | null = null;
    onclose:
      | ((event: {
          readonly code: number;
          readonly reason: string;
          readonly wasClean: boolean;
        }) => void)
      | null = null;
    readonly sent: string[] = [];
    send(data: string): void {
      this.sent.push(data);
    }
    close(_code: number, _reason: string): void {}
    fireOpen(): void {
      this.onopen?.({ type: "open" });
    }
    fireMessage(frame: unknown): void {
      this.onmessage?.({ data: JSON.stringify(frame) });
    }
  }
  return {
    UnarySocket,
    sockets: [] as InstanceType<typeof UnarySocket>[],
    state: {
      credentialsPath: "",
      table: new Map() as HostTokenTable,
      /** While set, the store's read answers only once this settles; the file is read first. */
      readHold: null as Promise<void> | null,
      readsTaken: 0,
      rotationsStarted: 0,
      refreshesAsked: 0,
    },
  };
});

vi.mock("../host-auth", () => ({
  resolveHostAuth: async () => ({
    token: SIGN_IN,
    authnBaseUrl: "https://authn.test",
    userId: USER_ID,
  }),
}));

vi.mock("../../logger", () => {
  const logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  return {
    createCliLogger: () => logger,
    noopLogger: logger,
    errorFromUnknown: (value: unknown) =>
      value instanceof Error ? value : new Error(String(value)),
  };
});

vi.mock("../../store/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../store/paths")>();
  return {
    ...actual,
    cliCredentialsPath: (environment: Environment): string =>
      harness.state.credentialsPath === ""
        ? actual.cliCredentialsPath(environment)
        : harness.state.credentialsPath,
  };
});

vi.mock("../../../../shared/auth/auth-validation", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../../shared/auth/auth-validation")
    >();
  return {
    ...actual,
    refreshOnceAbortable: async (): Promise<never> => {
      harness.state.refreshesAsked += 1;
      throw new Error("authn was asked for a refresh no test expected");
    },
  };
});

vi.mock("../../store/credentials-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../store/credentials-store")>();
  return {
    ...actual,
    createCliCredentialsStore: () => {
      const real = actual.createCliCredentialsStore();
      return {
        ...real,
        read: async () => {
          const snapshot = await real.read();
          harness.state.readsTaken += 1;
          await harness.state.readHold;
          return snapshot;
        },
        rotate: (args: Parameters<typeof real.rotate>[0]) => {
          harness.state.rotationsStarted += 1;
          return real.rotate(args);
        },
      };
    },
  };
});

vi.mock("@traycer-clients/shared/auth/host-token-file", () => ({
  createHostTokenFilePersistence: () => ({
    load: async () => harness.state.table,
    update: async (change: (table: HostTokenTable) => HostTokenTable) => {
      harness.state.table = change(harness.state.table);
      return harness.state.table;
    },
  }),
}));

vi.mock("@traycer-clients/shared/host-transport/remote/grant-client", () => ({
  mintHostTokenViaHttp: async () => ({ kind: "unavailable", detail: "none" }),
}));

vi.mock("../../../../shared/host-transport/whatwg-ws-factory", () => ({
  createWhatwgWebSocketFactory: () => ({
    create: () => {
      const socket = new harness.UnarySocket();
      harness.sockets.push(socket);
      return socket;
    },
  }),
}));

let hostCount = 0;
let hostId = "";
let workDir = "";

beforeEach(async () => {
  vi.useFakeTimers();
  harness.sockets.splice(0);
  harness.state.readHold = null;
  harness.state.readsTaken = 0;
  harness.state.rotationsStarted = 0;
  harness.state.refreshesAsked = 0;
  hostCount += 1;
  // A named reason is remembered per computer for the whole process.
  hostId = `44444444-4444-4444-8444-${String(hostCount).padStart(12, "0")}`;
  harness.state.table = new Map([
    [
      USER_ID,
      new Map([
        [hostId, { token: HELD_TOKEN, expiresAtMs: Date.now() + 3_600_000 }],
      ]),
    ],
  ]);
  processReleasedHosts.forgetAll();
  workDir = await mkdtemp(join(tmpdir(), "traycer-still-wanted-"));
  harness.state.credentialsPath = join(workDir, "credentials");
  const credentials: StoredCredentials = {
    token: SIGN_IN,
    refreshToken: `rt-${SIGN_IN}`,
    savedAt: "2026-01-01T00:00:00.000Z",
    user: { id: USER_ID, email: "user@example.test", name: "User" },
  };
  const store = createCliCredentialsStore();
  await store.signIn(credentials, false, null);
  store.dispose();
});

afterEach(async () => {
  processReleasedHosts.forgetAll();
  vi.useRealTimers();
  harness.state.credentialsPath = "";
  await rm(workDir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  });
});

/** A released host's refusal of a credential it does not know: no reason named. */
function releasedRefusal(): Record<string, unknown> {
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

/** Holds the store's next reads until the returned function releases them. */
function holdStoreReads(): () => void {
  const held: { release: () => void } = { release: () => undefined };
  harness.state.readsTaken = 0;
  harness.state.readHold = new Promise<void>((resolve) => {
    held.release = resolve;
  });
  return () => held.release();
}

describe("a refused sign-in's recovery whose adopting read is held", () => {
  it("starts no rotation when the stream closes while the read is held", async () => {
    const session = await requireCliHostSession(
      { token: SIGN_IN, authnBaseUrl: "https://authn.test", userId: USER_ID },
      hostId,
      null,
    );
    const { factory, sockets } = makeStubSocketFactory();
    const client = new WsStreamClient({
      clientIdentity: TEST_CLIENT_IDENTITY,
      registry: hostStreamRpcRegistry,
      endpoint: () => ({ hostId, websocketUrl: "ws://127.0.0.1:9/rpc" }),
      hostId,
      bearer: () => session.bearer,
      userId: USER_ID,
      releasedSignOn: session.releasedSignOn,
      auth: null,
      clock: null,
      hostCredentialMint: null,
      onHostCredentialState: null,
      evidence: NO_TRANSPORT_EVIDENCE,
      webSocketFactory: factory,
      dialTimeoutMs: 1_000,
      openAckTimeoutMs: 1_000,
      pingIntervalMs: 25_000,
      pongTimeoutMs: 50_000,
      initialBackoffMs: 10,
      maxBackoffMs: 1_000,
      door: { admitted: () => () => undefined, refused: () => undefined },
    });
    const stream = client.subscribe("git.subscribeStatus", {
      hostId,
      runningDir: "/repo",
      ignoreWhitespace: false,
      freshNonce: null,
    });
    try {
      // The held token is refused the released way; the redial presents the sign-in.
      const first = await socketAt(sockets, 0);
      first.fireText(releasedRefusal());
      const second = await socketAt(sockets, 1);
      expect(tokenOf(second)).toBe(SIGN_IN);
      const release = holdStoreReads();

      // The host refuses the sign-in: the recovery reads the stored one first.
      second.fireText(releasedRefusal());
      await vi.waitFor(() => expect(harness.state.readsTaken).toBe(1), WAIT);
      // The stream closes while that read is held.
      stream.close();
      release();
      await vi.advanceTimersByTimeAsync(PAST_EVERY_BACKOFF_MS);

      expect(harness.state.rotationsStarted).toBe(0);
      expect(harness.state.refreshesAsked).toBe(0);
    } finally {
      stream.close();
      client.close("test-done");
      session.dispose();
    }
  });

  it("starts no rotation when the unary call's caller ends while the read is held", async () => {
    const ended = new AbortController();
    const call = toAgentCliError(
      callHostRpcAtResolvedEndpoint(
        "agent.list",
        { epicId: "epic-1", senderAgentId: "agent-1", scope: "user" as const },
        { hostId, websocketUrl: "ws://127.0.0.1:9/rpc" },
        { token: SIGN_IN, authnBaseUrl: "https://authn.test", userId: USER_ID },
        { ...PLAIN_DISPATCH, signal: ended.signal },
      ),
    ).then(
      () => null,
      (error: unknown) => error,
    );

    // The held token is refused the released way; the call dials again with the sign-in.
    await refuseOpen(0);
    await refuseOpenAfterHolding(1, ended);
    await vi.advanceTimersByTimeAsync(PAST_EVERY_BACKOFF_MS);
    await call;

    expect(harness.state.rotationsStarted).toBe(0);
    expect(harness.state.refreshesAsked).toBe(0);
  });
});

async function socketAt(
  sockets: readonly StubStreamWebSocket[],
  index: number,
): Promise<StubStreamWebSocket> {
  await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(index), WAIT);
  const socket = sockets[index];
  if (socket === undefined) throw new Error("socket missing");
  socket.fireOpen();
  await vi.waitFor(
    () => expect(socket.textSent.length).toBeGreaterThan(0),
    WAIT,
  );
  return socket;
}

function tokenOf(socket: StubStreamWebSocket): unknown {
  const frame: unknown = JSON.parse(socket.textSent[0] ?? "null");
  return typeof frame === "object" && frame !== null && "token" in frame
    ? frame.token
    : null;
}

/** The unary call's `index`th socket opens, writes its OPEN, and the host refuses it. */
async function openUnarySocket(
  index: number,
): Promise<InstanceType<typeof harness.UnarySocket>> {
  await vi.waitFor(
    () => expect(harness.sockets.length).toBeGreaterThan(index),
    WAIT,
  );
  const socket = harness.sockets[index];
  if (socket === undefined) throw new Error("socket missing");
  socket.fireOpen();
  await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(0), WAIT);
  return socket;
}

async function refuseOpen(index: number): Promise<void> {
  const socket = await openUnarySocket(index);
  socket.fireMessage(releasedRefusal());
}

/** Refuses socket `index`, holds the recovery's read, and ends the call's caller while it is held. */
async function refuseOpenAfterHolding(
  index: number,
  ended: AbortController,
): Promise<void> {
  const socket = await openUnarySocket(index);
  const release = holdStoreReads();
  socket.fireMessage(releasedRefusal());
  await vi.waitFor(() => expect(harness.state.readsTaken).toBe(1), WAIT);
  ended.abort();
  release();
}
