import { NO_HOST_TOKEN_PROBE } from "@traycer/protocol/framework/door-reason";
import type { HostTokenTable } from "@traycer-clients/shared/auth/host-token-store";
import { processReleasedHosts } from "@traycer-clients/shared/host-transport/released-sign-on";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMonitor } from "../monitor";

const USER_ID = "monitor-test-user";
const HOST_ID = "11111111-1111-4111-8111-111111111111";
const SIGN_IN = "monitor-test-sign-in";
const TEAM_REFUSAL = "Session grant verification failed: ERR_JWS_INVALID";
const WAIT = { timeout: 2_000, interval: 10 };

const monitorHarness = vi.hoisted(() => {
  class ScriptSocket {
    readonly sent: string[] = [];
    readonly dialStarted = Promise.resolve();
    closed: { readonly code: number; readonly reason: string } | null = null;
    onopen: ((event: { readonly type: "open" }) => void) | null = null;
    onmessage:
      | ((
          event:
            | { readonly type: "text"; readonly data: string }
            | { readonly type: "binary"; readonly data: Uint8Array },
        ) => void)
      | null = null;
    onerror: ((event: { readonly message: string }) => void) | null = null;
    onclose:
      | ((event: {
          readonly code: number;
          readonly reason: string;
          readonly wasClean: boolean;
        }) => void)
      | null = null;

    send(data: string | Uint8Array): void {
      if (typeof data === "string") this.sent.push(data);
    }

    close(code: number, reason: string): void {
      this.closed = { code, reason };
    }

    fireOpen(): void {
      this.onopen?.({ type: "open" });
    }

    fireFrame(frame: unknown): void {
      this.onmessage?.({ type: "text", data: JSON.stringify(frame) });
    }
  }

  return {
    ScriptSocket,
    sockets: [] as InstanceType<typeof ScriptSocket>[],
    state: {
      hostTokenTable: new Map() as HostTokenTable,
      reader: new AbortController(),
      grants: 0,
    },
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  };
});

vi.mock("../../internal/host-auth", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../internal/host-auth")>();
  return {
    ...actual,
    resolveHostAuth: async () => ({
      token: SIGN_IN,
      authnBaseUrl: "https://authn.test",
      userId: USER_ID,
    }),
  };
});

vi.mock("../../internal/agent-session-capability", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../internal/agent-session-capability")
    >();
  return {
    ...actual,
    PROCESS_AGENT_ENVIRONMENT: () => undefined,
    readAgentCommandCredential: () => ({ kind: "outside-agent-session" }),
  };
});

vi.mock("../../logger", () => ({
  createCliLogger: () => monitorHarness.logger,
  errorFromUnknown: (value: unknown) =>
    value instanceof Error ? value : new Error(String(value)),
}));

vi.mock("../../host/pid-metadata", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../host/pid-metadata")>();
  return {
    ...actual,
    readHostPidMetadata: async () => ({
      pid: 1,
      hostId: HOST_ID,
      version: "test",
      websocketUrl: "ws://127.0.0.1:9/rpc",
      startedAt: "2026-01-01T00:00:00.000Z",
      processStartIdentity: null,
      processStartIdentityRead: "absent",
      layer0: null,
      layer0Slot: null,
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

vi.mock("../../auth/host-credential-mint", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../auth/host-credential-mint")>();
  return {
    ...actual,
    createCliHostCredentialMintFlow: () => null,
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
        load: async () => monitorHarness.state.hostTokenTable,
        update: async (
          change: (table: HostTokenTable) => HostTokenTable,
        ): Promise<HostTokenTable> => {
          monitorHarness.state.hostTokenTable = change(
            monitorHarness.state.hostTokenTable,
          );
          return monitorHarness.state.hostTokenTable;
        },
      }),
    };
  },
);

vi.mock("../../../../shared/host-transport/whatwg-stream-ws-factory", () => ({
  createWhatwgStreamWebSocketFactory: () => ({
    create: () => {
      const socket = new monitorHarness.ScriptSocket();
      monitorHarness.sockets.push(socket);
      return socket;
    },
  }),
}));

vi.mock("../../runner/std-write", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../runner/std-write")>();
  return {
    ...actual,
    stdoutReaderClosed: () => monitorHarness.state.reader.signal,
    writeStdout: () => undefined,
    writeStderr: () => undefined,
    writeStdoutForAck: () => ({
      confirmation: Promise.resolve(true),
      eventualOutcome: Promise.resolve(true),
    }),
  };
});

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) return input;
  if (typeof input === "string") return new URL(input);
  return new URL(input.url);
}

function openToken(
  socket: InstanceType<typeof monitorHarness.ScriptSocket>,
): string | null {
  for (const raw of socket.sent) {
    const frame: unknown = JSON.parse(raw);
    if (
      typeof frame === "object" &&
      frame !== null &&
      "kind" in frame &&
      frame.kind === "open" &&
      "token" in frame &&
      typeof frame.token === "string"
    )
      return frame.token;
  }
  return null;
}

function openFrame(
  socket: InstanceType<typeof monitorHarness.ScriptSocket>,
): Record<string, unknown> {
  for (const raw of socket.sent) {
    const frame: unknown = JSON.parse(raw);
    if (
      typeof frame === "object" &&
      frame !== null &&
      "kind" in frame &&
      frame.kind === "open"
    )
      return frame;
  }
  throw new Error("open frame missing");
}

async function socketAt(
  index: number,
): Promise<InstanceType<typeof monitorHarness.ScriptSocket>> {
  await vi.waitFor(
    () => expect(monitorHarness.sockets.length).toBeGreaterThan(index),
    WAIT,
  );
  const socket = monitorHarness.sockets[index];
  if (socket === undefined) throw new Error("monitor socket missing");
  await vi.waitFor(() => expect(socket.onopen).not.toBeNull(), WAIT);
  return socket;
}

async function readOpen(
  socket: InstanceType<typeof monitorHarness.ScriptSocket>,
): Promise<Record<string, unknown>> {
  socket.fireOpen();
  await vi.waitFor(() => expect(openToken(socket)).not.toBeNull(), WAIT);
  return openFrame(socket);
}

function fatal(
  doorReason: "token_expired" | "not_admitted",
  reason: string,
): Record<string, unknown> {
  return {
    kind: "fatalError",
    details: {
      code: "UNAUTHORIZED",
      reason,
      doorReason,
      retryable: false,
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  };
}

let monitorRun: Promise<void> | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  monitorRun = null;
  monitorHarness.sockets.splice(0);
  monitorHarness.state.hostTokenTable = new Map();
  monitorHarness.state.reader = new AbortController();
  monitorHarness.state.grants = 0;
  processReleasedHosts.forgetAll();
  vi.stubGlobal(
    "fetch",
    async (
      input: RequestInfo | URL,
      init: RequestInit | undefined,
    ): Promise<Response> => {
      const url = requestUrl(input);
      const method = init?.method ?? "GET";
      if (method === "POST" && url.pathname.endsWith("/session-grant")) {
        monitorHarness.state.grants += 1;
        return new Response("authn unavailable", { status: 503 });
      }
      if (method === "GET" && url.pathname.startsWith("/api/v3/hosts"))
        return new Response("authn unavailable", { status: 503 });
      return new Response("not found", { status: 404 });
    },
  );
});

afterEach(async () => {
  monitorHarness.state.reader.abort();
  if (monitorRun !== null) await monitorRun.catch(() => undefined);
  processReleasedHosts.forgetAll();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("traycer monitor local released-host sign-in", () => {
  it("re-presents the held token after the unknown-row probe is declined", async () => {
    const expiredAt = Date.now() - 11 * 60 * 1000;
    const token = expiredJwt(expiredAt);
    monitorHarness.state.hostTokenTable = new Map([
      [USER_ID, new Map([[HOST_ID, { token, expiresAtMs: expiredAt }]])],
    ]);

    const running = runMonitor({ agentId: "agent-a", epicId: "epic-a" });
    monitorRun = running;
    void running.catch(() => undefined);
    await vi.waitFor(
      () => expect(monitorHarness.state.grants).toBeGreaterThan(0),
      WAIT,
    );
    await vi.advanceTimersByTimeAsync(500);
    const first = await socketAt(0);
    const firstOpen = await readOpen(first);
    expect(firstOpen.token).toBe(token);
    first.fireFrame(fatal("token_expired", "host token expired"));

    await vi.waitFor(
      () => expect(monitorHarness.state.grants).toBeGreaterThan(1),
      WAIT,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    const probe = await socketAt(1);
    expect((await readOpen(probe)).token).toBe(NO_HOST_TOKEN_PROBE);
    probe.fireFrame(fatal("not_admitted", TEAM_REFUSAL));

    await vi.waitFor(
      () => expect(monitorHarness.state.grants).toBeGreaterThan(2),
      WAIT,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    const admitted = await socketAt(2);
    const admittedOpen = await readOpen(admitted);
    expect(admittedOpen.token).toBe(token);
    admitted.fireFrame({
      kind: "openAck",
      manifest: admittedOpen.manifest,
      optionalManifest: admittedOpen.optionalManifest,
    });
    await vi.waitFor(() =>
      expect(
        admitted.sent.some((raw) => raw.includes('"kind":"subscribe"')),
      ).toBe(true),
    );
    expect(monitorHarness.sockets.map(openToken)).toEqual([
      token,
      NO_HOST_TOKEN_PROBE,
      token,
    ]);
    expect(monitorHarness.sockets.map(openToken)).not.toContain(SIGN_IN);

    monitorHarness.state.reader.abort();
    await expect(running).resolves.toBeUndefined();
  });
});

function expiredJwt(nowMs: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(nowMs / 1000) }),
  ).toString("base64url");
  return `${header}.${payload}.`;
}
