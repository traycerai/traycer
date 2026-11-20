import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHostTokenSource,
  createMemoryHostTokenPersistence,
} from "@traycer-clients/shared/auth/host-token-source";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { HostInventoryStreamClient } from "@traycer-clients/shared/host-transport/host-inventory-stream-client";
import {
  FakeNativeWebSocket,
  liveBearer,
  newProvider,
  sentFramesOfKind,
  sentTokens,
  settle,
  signIn,
  USER_A,
  USER_B,
} from "@traycer-clients/shared/test-fixtures/dial-gate-harness";
import { processReleasedHosts } from "@traycer-clients/shared/host-transport/released-sign-on";
import { createLocalHostInventoryStreamClient } from "../local-host-inventory-subscription";

const SIGN_IN_TOKEN = "main-sign-in-token";
const SIGN_IN_B = "main-sign-in-token-b";
const HOST_TOKEN = "main-host-token";
const HOST_TOKEN_B = "main-host-token-b";
const RELEASED_HOST = { ...mockLocalHostEntry, version: "1.5.4" };

type RowOwner = "personal" | "team";

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function ownershipBody(owner: RowOwner): unknown {
  return {
    hosts: [
      owner === "team"
        ? {
            hostId: RELEASED_HOST.hostId,
            owner: { kind: "team", id: "team-1", name: "Team" },
            kind: "machine",
            remoteAccess: false,
          }
        : {
            hostId: RELEASED_HOST.hostId,
            owner: { kind: "user", id: USER_A },
            kind: "personal",
            remoteAccess: false,
          },
    ],
  };
}

function installFetch(owner: RowOwner): void {
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(requestUrl(input));
      if (url.pathname === "/api/v3/hosts") {
        return new Response(JSON.stringify(ownershipBody(owner)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("unexpected", { status: 500 });
    },
  );
}

function releasedRefusal(): string {
  return JSON.stringify({
    kind: "fatalError",
    details: {
      code: "UNAUTHORIZED",
      reason: "released-host-token-refusal",
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  });
}

async function openInventory(owner: RowOwner): Promise<{
  readonly statuses: string[];
  readonly close: () => void;
}> {
  installFetch(owner);
  const provider = newProvider();
  signIn(provider, USER_A, SIGN_IN_TOKEN);
  const hostTokens = createHostTokenSource({
    persistence: createMemoryHostTokenPersistence(),
    mint: () =>
      Promise.resolve({ kind: "unavailable", detail: "authn offline" }),
    signIn: (userId) => (userId === USER_A ? SIGN_IN_TOKEN : null),
    now: () => Date.now(),
  });
  const websocketUrl = RELEASED_HOST.websocketUrl;
  if (websocketUrl === null) {
    throw new Error("the mock local host has no websocket URL");
  }
  await hostTokens.adopt(
    USER_A,
    RELEASED_HOST.hostId,
    { token: HOST_TOKEN, expiresAtMs: Date.now() + 60_000 },
    hostTokens.era(USER_A),
  );
  const endpoint = {
    hostId: RELEASED_HOST.hostId,
    websocketUrl,
    version: RELEASED_HOST.version,
  };
  const inventoryClient = createLocalHostInventoryStreamClient({
    authnBaseUrl: "https://authn.test",
    hostTokens,
    localHost: () => endpoint,
    bearer: liveBearer(provider),
    appVersion: "1.0.0-test",
  });
  const stream = inventoryClient(endpoint, USER_A);
  if (stream === null)
    throw new Error("local inventory stream client did not build");
  const statuses: string[] = [];
  const inventory = new HostInventoryStreamClient({
    wsStreamClient: stream,
    callbacks: {
      onSnapshot: () => undefined,
      onConnectionStatus: (status) => {
        statuses.push(status);
      },
    },
  });
  return {
    statuses,
    close: () => {
      inventory.close();
      stream.close("test complete");
    },
  };
}

async function refusedOpen(): Promise<FakeNativeWebSocket> {
  await vi.waitFor(() => expect(FakeNativeWebSocket.instances).toHaveLength(1));
  const socket = FakeNativeWebSocket.instances[0];
  if (socket === undefined) throw new Error("inventory socket missing");
  socket.fireOpen();
  await vi.waitFor(() =>
    expect(sentFramesOfKind(socket, "open")).toHaveLength(1),
  );
  expect(sentFramesOfKind(socket, "open")[0]?.token).toBe(HOST_TOKEN);
  socket.fireMessage(releasedRefusal());
  await settle();
  return socket;
}

describe("desktop inventory push against a released local host", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeNativeWebSocket);
    FakeNativeWebSocket.instances.length = 0;
  });

  afterEach(async () => {
    processReleasedHosts.forgetAll();
    for (const socket of FakeNativeWebSocket.instances) {
      socket.fireClose(1006, "test teardown");
    }
    await settle();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("opens the person's own computer with the sign-in after the host-only token is refused", async () => {
    const opened = await openInventory("personal");
    await refusedOpen();
    await vi.waitFor(() =>
      expect(
        FakeNativeWebSocket.instances.length >= 2 ||
          opened.statuses.includes("closed"),
      ).toBe(true),
    );
    expect(FakeNativeWebSocket.instances).toHaveLength(2);
    const signInSocket = FakeNativeWebSocket.instances[1];
    if (signInSocket === undefined) throw new Error("sign-in socket missing");
    signInSocket.fireOpen();
    await vi.waitFor(() =>
      expect(sentFramesOfKind(signInSocket, "open")).toHaveLength(1),
    );
    expect(sentTokens()).toEqual([HOST_TOKEN, SIGN_IN_TOKEN]);
    opened.close();
  });

  it("never sends the sign-in when authn says the computer is a team's", async () => {
    const opened = await openInventory("team");
    await refusedOpen();
    await vi.waitFor(() =>
      expect(
        FakeNativeWebSocket.instances.length >= 2 ||
          opened.statuses.includes("closed"),
      ).toBe(true),
    );
    expect(sentTokens()).not.toContain(SIGN_IN_TOKEN);
    expect(sentTokens()).toEqual([HOST_TOKEN]);
    opened.close();
  });

  it("keeps the next person's sign-in off a host the previous person admitted", async () => {
    const first = await openInventoryFor({
      userId: USER_A,
      signInToken: SIGN_IN_TOKEN,
      hostToken: HOST_TOKEN,
      rowOwnerId: USER_A,
    });
    await refusedOpen();
    await vi.waitFor(() =>
      expect(FakeNativeWebSocket.instances.length).toBeGreaterThanOrEqual(2),
    );
    const admitted = FakeNativeWebSocket.instances[1];
    if (admitted === undefined) throw new Error("sign-in socket missing");
    admitted.fireOpen();
    await vi.waitFor(() =>
      expect(sentFramesOfKind(admitted, "open")).toHaveLength(1),
    );
    const open = sentFramesOfKind(admitted, "open")[0];
    if (open === undefined) throw new Error("sign-in open missing");
    expect(open.token).toBe(SIGN_IN_TOKEN);
    admitted.fireMessage(
      JSON.stringify({
        kind: "openAck",
        manifest: open.manifest,
        capabilities: ["credentialUpdate"],
      }),
    );
    await vi.waitFor(() => expect(first.statuses).toContain("open"));
    first.close();
    await settle();
    FakeNativeWebSocket.instances.length = 0;

    const second = await openInventoryFor({
      userId: USER_B,
      signInToken: SIGN_IN_B,
      hostToken: HOST_TOKEN_B,
      rowOwnerId: USER_A,
    });
    await vi.waitFor(() =>
      expect(FakeNativeWebSocket.instances).toHaveLength(1),
    );
    const dial = FakeNativeWebSocket.instances[0];
    if (dial === undefined) throw new Error("next person's socket missing");
    dial.fireOpen();
    await vi.waitFor(() =>
      expect(sentFramesOfKind(dial, "open")).toHaveLength(1),
    );
    expect(sentFramesOfKind(dial, "open")[0]?.token).toBe(HOST_TOKEN_B);
    dial.fireMessage(releasedRefusal());
    await vi.waitFor(() => {
      const redial = FakeNativeWebSocket.instances[1];
      if (
        redial !== undefined &&
        sentFramesOfKind(redial, "open").length === 0
      ) {
        redial.fireOpen();
      }
      expect(
        second.statuses.includes("closed") ||
          FakeNativeWebSocket.instances.length >= 2,
      ).toBe(true);
    });
    expect(FakeNativeWebSocket.instances).toHaveLength(1);
    expect(second.statuses).toContain("closed");
    expect(sentTokens()).not.toContain(SIGN_IN_B);
    second.close();
  });
});

async function openInventoryFor(input: {
  readonly userId: string;
  readonly signInToken: string;
  readonly hostToken: string;
  readonly rowOwnerId: string;
}): Promise<{
  readonly statuses: string[];
  readonly close: () => void;
}> {
  vi.stubGlobal(
    "fetch",
    async (request: RequestInfo | URL): Promise<Response> => {
      const url = new URL(requestUrl(request));
      if (url.pathname === "/api/v3/hosts") {
        return new Response(
          JSON.stringify({
            hosts: [
              {
                hostId: RELEASED_HOST.hostId,
                owner: { kind: "user", id: input.rowOwnerId },
                kind: "personal",
                remoteAccess: false,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("unexpected", { status: 500 });
    },
  );
  const provider = newProvider();
  signIn(provider, input.userId, input.signInToken);
  const hostTokens = createHostTokenSource({
    persistence: createMemoryHostTokenPersistence(),
    mint: () =>
      Promise.resolve({ kind: "unavailable", detail: "authn offline" }),
    signIn: (userId) => (userId === input.userId ? input.signInToken : null),
    now: () => Date.now(),
  });
  const websocketUrl = RELEASED_HOST.websocketUrl;
  if (websocketUrl === null) {
    throw new Error("the mock local host has no websocket URL");
  }
  await hostTokens.adopt(
    input.userId,
    RELEASED_HOST.hostId,
    { token: input.hostToken, expiresAtMs: Date.now() + 60_000 },
    hostTokens.era(input.userId),
  );
  const endpoint = {
    hostId: RELEASED_HOST.hostId,
    websocketUrl,
    version: RELEASED_HOST.version,
  };
  const inventoryClient = createLocalHostInventoryStreamClient({
    authnBaseUrl: "https://authn.test",
    hostTokens,
    localHost: () => endpoint,
    bearer: liveBearer(provider),
    appVersion: "1.0.0-test",
  });
  const stream = inventoryClient(endpoint, input.userId);
  if (stream === null)
    throw new Error("local inventory stream client did not build");
  const statuses: string[] = [];
  const inventory = new HostInventoryStreamClient({
    wsStreamClient: stream,
    callbacks: {
      onSnapshot: () => undefined,
      onConnectionStatus: (status) => {
        statuses.push(status);
      },
    },
  });
  return {
    statuses,
    close: () => {
      inventory.close();
      stream.close("test complete");
    },
  };
}
