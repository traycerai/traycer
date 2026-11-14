import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHostTokenSource,
  createMemoryHostTokenPersistence,
  type HostTokenSource,
} from "@traycer-clients/shared/auth/host-token-source";
import type { DefaultRequestContextProvider } from "@traycer-clients/shared/auth/request-context-provider";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import {
  cloudVerdictOf,
  FakeNativeWebSocket,
  liveBearer,
  newProvider,
  openAckFrame,
  sentFramesOfKind,
  settle,
  signIn,
  signInUnverified,
  USER_A,
  USER_B,
  verdictUpdatesSent,
  sentTokens,
} from "@traycer-clients/shared/test-fixtures/dial-gate-harness";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import { buildHostStreamClient } from "@/hooks/host/use-host-stream-client-for";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";

// The local branch of `buildHostStreamClient` builds a `WsStreamClient`
// directly. It opens with the host-only token of the user it was built for,
// whichever account is live when it first dials, and never with a sign-in token.

const HOST_TOKEN_A = "host-token-for-user-a";

const LOCAL_ENDPOINT = {
  hostId: mockLocalHostEntry.hostId,
  websocketUrl: mockLocalHostEntry.websocketUrl,
};
const LONG_WAIT_MS = 20_000;

describe("buildHostStreamClient for a local host", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeNativeWebSocket);
    FakeNativeWebSocket.instances.length = 0;
  });

  afterEach(async () => {
    for (const native of FakeNativeWebSocket.instances) {
      native.fireClose(1006, "test");
    }
    await settle();
    useAuthStore.setState(useAuthStore.getInitialState(), true);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function hostTokensForUserA(): Promise<HostTokenSource> {
    const source = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: () => Promise.resolve({ kind: "no-sign-in" }),
      signIn: null,
      now: () => Date.now(),
    });
    await source.adopt(USER_A, mockLocalHostEntry.hostId, {
      token: HOST_TOKEN_A,
      expiresAtMs: Date.now() + 60 * 60 * 1000,
    });
    return source;
  }

  async function build(
    provider: DefaultRequestContextProvider,
    cloudAuthorized: () => boolean,
  ) {
    const client = buildHostStreamClient({
      target: mockLocalHostEntry,
      endpoint: () => LOCAL_ENDPOINT,
      bearer: liveBearer(provider),
      cloudAuthorized,
      authnBaseUrl: "http://localhost:5005",
      auth: null,
      hostTokens: await hostTokensForUserA(),
      userId: USER_A,
      proactiveWakeEligible: false,
      autoStart: false,
    });
    if (client === null) {
      throw new Error("the local host stream client did not build");
    }
    return client;
  }

  /** Dials until the first socket exists, or fails the test after `maxMs`. */
  async function untilFirstSocket(maxMs: number): Promise<FakeNativeWebSocket> {
    for (let elapsed = 0; elapsed < maxMs; elapsed += 500) {
      if (FakeNativeWebSocket.instances.length > 0) {
        break;
      }
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(FakeNativeWebSocket.instances).toHaveLength(1);
    const native = FakeNativeWebSocket.instances[0];
    native.fireOpen();
    await settle();
    return native;
  }

  it("sends no token of the other user when it is built while that user is live", async () => {
    const provider = newProvider();
    signIn(provider, USER_B, "token-b");
    const client = await build(provider, cloudVerdictOf(provider));

    const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
    const statuses: StreamConnectionStatus[] = [];
    session.onStatusChange((status) => {
      statuses.push(status);
    });
    await vi.advanceTimersByTimeAsync(LONG_WAIT_MS);

    expect(statuses).toContain("reconnecting");
    expect(FakeNativeWebSocket.instances).toHaveLength(0);

    signIn(provider, USER_A, "token-a");
    const native = await untilFirstSocket(60_000);

    expect(sentFramesOfKind(native, "open")[0].token).toBe(HOST_TOKEN_A);
    expect(sentTokens()).not.toContain("token-a");
    session.close();
  });

  it("sends no token of the other user when it signs in after a signed-out first read", async () => {
    const provider = newProvider();
    const client = await build(provider, cloudVerdictOf(provider));

    const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
    const statuses: StreamConnectionStatus[] = [];
    session.onStatusChange((status) => {
      statuses.push(status);
    });
    await settle();
    expect(FakeNativeWebSocket.instances).toHaveLength(0);

    signIn(provider, USER_B, "token-b");
    await vi.advanceTimersByTimeAsync(LONG_WAIT_MS);

    expect(statuses).toContain("reconnecting");
    expect(FakeNativeWebSocket.instances).toHaveLength(0);

    signIn(provider, USER_A, "token-a");
    const native = await untilFirstSocket(60_000);

    expect(sentFramesOfKind(native, "open")[0].token).toBe(HOST_TOKEN_A);
    expect(sentTokens()).not.toContain("token-a");
    session.close();
  });

  it("sends no verdict of the other user when the account store follows the context", async () => {
    const provider = newProvider();
    signInUnverified(provider, USER_A, "token-a");
    useAuthStore.setState({ status: "unverified" });
    const client = await build(provider, () =>
      authorizesCloudCapability(useAuthStore.getState().status),
    );
    const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
    const native = await untilFirstSocket(60_000);
    expect(sentFramesOfKind(native, "open")[0].cloudAuthorized).toBe(false);
    native.fireMessage(openAckFrame(["cloudVerdictUpdate"], null));
    await settle();
    expect(sentFramesOfKind(native, "subscribe")).toHaveLength(1);

    // The order AuthService commits in: the context first, then the store.
    signIn(provider, USER_B, "token-b");
    useAuthStore.setState({ status: "signed-in" });
    client.notifyCloudVerdictChanged();
    await settle();

    expect(verdictUpdatesSent(native)).not.toContain(true);
    session.close();
  });
});
