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
} from "@traycer-clients/shared/test-fixtures/dial-gate-harness";
import { createLocalHostInventoryStreamClient } from "../local-host-inventory-subscription";

const SIGN_IN_TOKEN = "main-sign-in-token";
const HOST_TOKEN = "main-host-token";
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
  if (stream === null) throw new Error("local inventory stream client did not build");
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
  await vi.waitFor(() =>
    expect(FakeNativeWebSocket.instances).toHaveLength(1),
  );
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
      expect(FakeNativeWebSocket.instances.length >= 2 || opened.statuses.includes("closed")).toBe(
        true,
      ),
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
});
