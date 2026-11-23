import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostTokenTable } from "../../../../shared/auth/host-token-store";
import { CLI_ERROR_CODES } from "../../runner/errors";
import { callHostRpcAtEndpoint, toAgentCliError } from "../host-rpc";
import { nextCasePerson } from "./case-person-test-support";

// The call to an explicit endpoint, over the real client, against a socket
// factory that records every dial. Authn is a token table and a mint that
// records what it is asked; no host is dialed.

// The person this case signs in as, one no earlier case used: the process-scope
// judge of a sign-in is kept per person.
let USER_ID = nextCasePerson().userId;
const SIGN_IN = "locality-sign-in";
const HELD_TOKEN = "locality-held-host-token";
const HOST_ID = "44444444-4444-4444-8444-444444444444";
const WAIT_STEP_MS = 10;
const OPEN_DEADLINE_MS = 5_000;
const NOT_RUNNING_LINE = "The host is not running. Run `traycer host ensure`.";

const harness = vi.hoisted(() => {
  class RecordingSocket {
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
    readonly openWritten: Promise<void>;
    private noteOpenWritten: () => void = () => undefined;

    constructor() {
      this.openWritten = new Promise<void>((resolve) => {
        this.noteOpenWritten = resolve;
      });
    }

    send(data: string): void {
      this.sent.push(data);
      this.noteOpenWritten();
    }

    close(_code: number, _reason: string): void {}

    fireOpen(): void {
      this.onopen?.({ type: "open" });
    }
  }
  return {
    RecordingSocket,
    sockets: [] as InstanceType<typeof RecordingSocket>[],
    dialedUrls: [] as string[],
    mintsAsked: [] as string[],
    state: { table: new Map() as HostTokenTable },
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
  mintHostTokenViaHttp: async (request: { readonly hostId: string }) => {
    harness.mintsAsked.push(request.hostId);
    return { kind: "unavailable", detail: "none" };
  },
}));

vi.mock("../../../../shared/host-transport/whatwg-ws-factory", () => ({
  createWhatwgWebSocketFactory: () => ({
    create: (url: string) => {
      harness.dialedUrls.push(url);
      const socket = new harness.RecordingSocket();
      harness.sockets.push(socket);
      return socket;
    },
  }),
}));

const params = {
  epicId: "epic-1",
  senderAgentId: "agent-1",
  scope: "user" as const,
};

beforeEach(() => {
  USER_ID = nextCasePerson().userId;
  vi.useFakeTimers();
  harness.sockets.splice(0);
  harness.dialedUrls.splice(0);
  harness.mintsAsked.splice(0);
  // A usable host-only token is held, so a dial would put it on the wire.
  harness.state.table = new Map([
    [
      USER_ID,
      new Map([
        [HOST_ID, { token: HELD_TOKEN, expiresAtMs: Date.now() + 3_600_000 }],
      ]),
    ],
  ]);
});

afterEach(() => {
  vi.useRealTimers();
});

function callAt(websocketUrl: string): Promise<unknown> {
  return toAgentCliError(
    callHostRpcAtEndpoint("agent.list", params, {
      hostId: HOST_ID,
      websocketUrl,
    }),
  ).then(
    () => null,
    (error: unknown) => error,
  );
}

function openFrameOf(
  socket: InstanceType<typeof harness.RecordingSocket>,
): Record<string, unknown> | null {
  for (const raw of socket.sent) {
    const frame: unknown = JSON.parse(raw);
    if (
      typeof frame === "object" &&
      frame !== null &&
      "kind" in frame &&
      frame.kind === "open"
    ) {
      return Object.fromEntries(Object.entries(frame));
    }
  }
  return null;
}

// The doctor's RPC probe prints this error's message as "Could not complete an
// RPC handshake with the host: <message>" under "Host RPC probe failed".
describe("a call to an explicit endpoint that is not this machine's host", () => {
  it.each([
    ["another machine", "ws://example.com:9/rpc"],
    ["a private-network address", "ws://192.168.1.5:9/rpc"],
    ["this machine's name for itself", "ws://localhost:9/rpc"],
    ["an IPv6 loopback", "ws://[::1]:9/rpc"],
    ["another path on the loopback address", "ws://127.0.0.1:9/other"],
    ["no port", "ws://127.0.0.1/rpc"],
  ])(
    "opens no socket and sends neither token nor sign-in: %s",
    async (_name, websocketUrl) => {
      const error = await callAt(websocketUrl);
      await vi.advanceTimersByTimeAsync(OPEN_DEADLINE_MS);

      expect(error).toMatchObject({
        code: CLI_ERROR_CODES.HOST_NOT_RUNNING,
        message: NOT_RUNNING_LINE,
        exitCode: 1,
      });
      expect(harness.dialedUrls).toEqual([]);
      expect(harness.mintsAsked).toEqual([]);
    },
  );
});

describe("a call to an explicit endpoint that is this machine's host", () => {
  it("dials the one socket and writes its OPEN with the held host-only token", async () => {
    const url = "ws://127.0.0.1:9/rpc";
    const call = callAt(url);
    void call.catch(() => undefined);

    for (let waited = 0; harness.sockets.length === 0; waited += WAIT_STEP_MS) {
      if (waited >= OPEN_DEADLINE_MS) {
        throw new Error(`expected a socket to ${url}, none dialed`);
      }
      await vi.advanceTimersByTimeAsync(WAIT_STEP_MS);
    }
    const socket = harness.sockets[0];
    if (socket === undefined) throw new Error("socket missing");
    socket.fireOpen();
    for (let waited = 0; openFrameOf(socket) === null; waited += WAIT_STEP_MS) {
      if (waited >= OPEN_DEADLINE_MS) {
        throw new Error(`expected an OPEN frame on the socket to ${url}`);
      }
      await vi.advanceTimersByTimeAsync(WAIT_STEP_MS);
    }

    expect(harness.dialedUrls).toEqual([url]);
    expect(openFrameOf(socket)?.token).toBe(HELD_TOKEN);
  });
});
