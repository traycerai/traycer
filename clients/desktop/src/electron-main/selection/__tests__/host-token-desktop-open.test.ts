import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHostTokenSource,
  createMemoryHostTokenPersistence,
} from "@traycer-clients/shared/auth/host-token-source";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { BrowserSessionsStreamClient } from "@traycer-clients/shared/host-transport/browser-sessions-stream-client";
import { HostInventoryStreamClient } from "@traycer-clients/shared/host-transport/host-inventory-stream-client";
import { LOCAL_OWNER_JAR_CASES } from "@traycer-clients/shared/test-fixtures/local-owner-jar-cases";
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
import { openBrowserSessionsTransport } from "../../browser-sessions/browser-sessions-transport";
import { createLocalHostInventoryStreamClient } from "../local-host-inventory-subscription";

const SIGN_IN_TOKEN = "main-sign-in-token";
const HOST_TOKEN = "main-host-token";

async function openLocalBrowserTransport(
  target: HostDirectoryEntry,
): Promise<ReturnType<typeof openBrowserSessionsTransport>> {
  const provider = newProvider();
  signIn(provider, USER_A, SIGN_IN_TOKEN);
  const hostTokens = createHostTokenSource({
    persistence: createMemoryHostTokenPersistence(),
    mint: () => Promise.resolve({ kind: "no-sign-in" }),
    signIn: null,
    now: () => Date.now(),
  });
  await hostTokens.adopt(USER_A, target.hostId, {
    token: HOST_TOKEN,
    expiresAtMs: Date.now() + 60_000,
  });
  const websocketUrl = target.websocketUrl;
  if (websocketUrl === null)
    throw new Error("the local host has no websocket URL");
  return openBrowserSessionsTransport(target, USER_A, {
    authnBaseUrl: () => "https://authn.test",
    bearer: liveBearer(provider),
    cloudAuthorized: () => true,
    endpoint: () => ({
      hostId: target.hostId,
      websocketUrl,
    }),
    appVersion: "1.0.0-test",
    hostTokens,
  });
}

describe("desktop main local streams open with host tokens", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeNativeWebSocket);
    FakeNativeWebSocket.instances.length = 0;
  });

  afterEach(async () => {
    for (const socket of FakeNativeWebSocket.instances)
      socket.fireClose(1006, "test teardown");
    await settle();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("uses the host token on inventory and browser-session opens, never the sign-in token", async () => {
    const provider = newProvider();
    signIn(provider, USER_A, SIGN_IN_TOKEN);
    const hostTokens = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: () => Promise.resolve({ kind: "no-sign-in" }),
      signIn: null,
      now: () => Date.now(),
    });
    await hostTokens.adopt(USER_A, mockLocalHostEntry.hostId, {
      token: HOST_TOKEN,
      expiresAtMs: Date.now() + 60_000,
    });

    const websocketUrl = mockLocalHostEntry.websocketUrl;
    if (websocketUrl === null)
      throw new Error("the mock local host has no websocket URL");
    const endpoint = { hostId: mockLocalHostEntry.hostId, websocketUrl };
    const localHost = () => endpoint;
    const inventoryClient = createLocalHostInventoryStreamClient({
      hostTokens,
      localHost,
      bearer: liveBearer(provider),
      appVersion: "1.0.0-test",
    });
    const inventoryWsStreamClient = inventoryClient(endpoint, USER_A);
    const inventory = new HostInventoryStreamClient({
      wsStreamClient: inventoryWsStreamClient,
      callbacks: {
        onSnapshot: () => undefined,
        onConnectionStatus: () => undefined,
      },
    });
    await vi.waitFor(() =>
      expect(FakeNativeWebSocket.instances).toHaveLength(1),
    );
    const inventorySocket = FakeNativeWebSocket.instances[0];
    if (inventorySocket === undefined)
      throw new Error("inventory socket missing");
    inventorySocket.fireOpen();
    await settle();

    const browserTransport = openBrowserSessionsTransport(
      mockLocalHostEntry,
      USER_A,
      {
        authnBaseUrl: () => "https://authn.test",
        bearer: liveBearer(provider),
        cloudAuthorized: () => true,
        endpoint: localHost,
        appVersion: "1.0.0-test",
        hostTokens,
      },
    );
    if (browserTransport === null)
      throw new Error("local browser-session transport did not build");
    const browserSessions = new BrowserSessionsStreamClient({
      wsStreamClient: browserTransport.wsStreamClient,
      scope: { kind: "independent" },
      callbacks: {
        onServerFrame: () => undefined,
        onConnectionStatus: () => undefined,
      },
    });
    await vi.waitFor(() =>
      expect(FakeNativeWebSocket.instances).toHaveLength(2),
    );
    const browserSocket = FakeNativeWebSocket.instances[1];
    if (browserSocket === undefined) throw new Error("browser socket missing");
    browserSocket.fireOpen();
    await settle();

    expect(sentFramesOfKind(inventorySocket, "open")[0]?.token).toBe(
      HOST_TOKEN,
    );
    expect(sentFramesOfKind(browserSocket, "open")[0]?.token).toBe(HOST_TOKEN);
    expect(sentTokens()).not.toContain(SIGN_IN_TOKEN);

    browserSessions.close();
    browserTransport.close();
    inventory.close();
    inventoryWsStreamClient.close("test complete");
  });

  it.each(LOCAL_OWNER_JAR_CASES)(
    "applies the main jar lane to a local entry with $name",
    async ({ owner, omitOwner, previousOwner, admitted }) => {
      const entryFor = (currentOwner: typeof owner): HostDirectoryEntry =>
        omitOwner
          ? { ...mockLocalHostEntry }
          : { ...mockLocalHostEntry, owner: currentOwner };
      const socketsBefore = FakeNativeWebSocket.instances.length;

      if (previousOwner !== undefined) {
        const prior = await openLocalBrowserTransport(entryFor(previousOwner));
        expect(prior).not.toBeNull();
        prior?.close();
      }

      const transport = await openLocalBrowserTransport(entryFor(owner));
      expect(transport !== null).toBe(admitted);
      if (transport === null) {
        expect(FakeNativeWebSocket.instances).toHaveLength(socketsBefore);
        return;
      }

      const sessions = new BrowserSessionsStreamClient({
        wsStreamClient: transport.wsStreamClient,
        scope: { kind: "independent" },
        callbacks: {
          onServerFrame: () => undefined,
          onConnectionStatus: () => undefined,
        },
      });
      await vi.waitFor(() =>
        expect(FakeNativeWebSocket.instances).toHaveLength(socketsBefore + 1),
      );
      const browserSocket = FakeNativeWebSocket.instances[socketsBefore];
      if (browserSocket === undefined)
        throw new Error("browser-session socket missing");
      browserSocket.fireOpen();
      await settle();
      expect(sentFramesOfKind(browserSocket, "open")[0]?.token).toBe(
        HOST_TOKEN,
      );
      expect(sentTokens()).not.toContain(SIGN_IN_TOKEN);
      sessions.close();
      transport.close();
    },
  );
});
