import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  createHostTokenSource,
  createMemoryHostTokenPersistence,
  type HostTokenSource,
} from "@traycer-clients/shared/auth/host-token-source";
import { HostRuntime } from "@traycer-clients/shared/host-client/host-runtime";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import {
  FakeNativeWebSocket,
  liveBearer,
  newProvider,
  openAckFrame,
  sentFramesOfKind,
  settle,
  signIn,
  USER_A,
  USER_B,
} from "@traycer-clients/shared/test-fixtures/dial-gate-harness";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import { STREAM_CAPABILITY_CREDENTIAL_UPDATE } from "@traycer/protocol/framework/stream-ws-protocol";
import { createFakeRunnerHost } from "../../../../__tests__/create-fake-runner-host";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { openDurableStreamTransport } from "@/lib/host/durable-stream-transport";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { useAuthStore } from "@/stores/auth/auth-store";

// The app's own wiring end to end: the host runtime, the durable transport that
// forwards the runtime's rotation signal, and the real local stream client
// `buildHostStreamClient` builds, against a fake host socket.

const HOST_ID = mockLocalHostEntry.hostId;
const OTHER_HOST_ID = "another-computer";
const HELD_TOKEN = "own-host-token";
const RENEWED_TOKEN = "own-host-token-renewed";

/** A fake host socket that says when the client wrote a frame carrying `token`. */
class AwaitableSocket extends FakeNativeWebSocket {
  private readonly waiting = new Map<string, () => void>();

  override send(data: string): void {
    super.send(data);
    for (const [token, arrived] of this.waiting) {
      if (data.includes(JSON.stringify(token))) arrived();
    }
  }

  frameCarrying(token: string): Promise<void> {
    return new Promise((resolve) => {
      this.waiting.set(token, resolve);
    });
  }
}

describe("a host-only token change and an open local stream", () => {
  const disposers: Array<() => void> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", AwaitableSocket);
    FakeNativeWebSocket.instances.length = 0;
  });

  afterEach(async () => {
    for (const dispose of disposers.splice(0).reverse()) dispose();
    for (const socket of FakeNativeWebSocket.instances)
      socket.fireClose(1006, "test teardown");
    await settle();
    useAuthStore.setState(useAuthStore.getInitialState(), true);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function store(
    tokens: HostTokenSource,
    userId: string,
    hostId: string,
    token: string,
  ): Promise<void> {
    const stored = await tokens.adopt(
      userId,
      hostId,
      { token, expiresAtMs: Date.now() + 3_600_000 },
      tokens.era(userId),
      () => true,
    );
    expect(stored).toBe(true);
  }

  it("sends no credentialUpdate for another computer's or another person's token, and one for its own", async () => {
    const hostTokens = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: () => Promise.resolve({ kind: "no-sign-in" }),
      signIn: null,
      now: () => Date.now(),
    });
    await store(hostTokens, USER_A, HOST_ID, HELD_TOKEN);

    const provider = newProvider();
    signIn(provider, USER_A, "sign-in-token");
    const runnerHost = createFakeRunnerHost({ hostTokens });
    const runtime = new HostRuntime<HostRpcRegistry>({
      runnerHost,
      onHostTokenRenewal: () => undefined,
      registry: hostRpcRegistry,
      messenger: new MockHostMessenger<HostRpcRegistry>({
        registry: hostRpcRegistry,
        requestId: () => "request-1",
        handlers: {},
      }),
      singleAttemptMessenger: null,
      requestContextProvider: provider,
      directory: {
        list: () => Promise.resolve([mockLocalHostEntry]),
        findById: (hostId) => (hostId === HOST_ID ? mockLocalHostEntry : null),
        refresh: () => Promise.resolve([mockLocalHostEntry]),
        refreshForEra: () => Promise.resolve([mockLocalHostEntry]),
        invalidateInFlightRefresh: () => undefined,
      },
      invalidator: createHostQueryInvalidator(new QueryClient()),
      schedulingPolicy: hostRpcSchedulingPolicy,
      authorityRegistry: null,
      requestCoordinator: null,
      selectedHostId: () => null,
      connectionRegistry: null,
    });
    runtime.start();
    disposers.push(() => runtime.dispose());

    const transport = openDurableStreamTransport({
      target: mockLocalHostEntry,
      userId: USER_A,
      endpoint: () => ({
        hostId: HOST_ID,
        websocketUrl: mockLocalHostEntry.websocketUrl,
      }),
      bearer: liveBearer(provider),
      auth: { revalidateForReconnect: () => Promise.resolve("rotated") },
      runnerHost,
      subscribeBearerRotation: (onRotation) =>
        runtime.hostClient.onBearerRotated(onRotation),
      subscribeCloudVerdictChange: (onChange) =>
        runtime.hostClient.onCloudVerdictChanged(onChange),
      subscribeEndpointChange: () => () => undefined,
      notifyRecoveredForNamedHost: () => undefined,
    });
    disposers.push(transport.close);

    const session = transport.wsStreamClient.subscribe("epic.subscribe", {
      epicId: "epic-1",
    });
    disposers.push(() => session.close());
    await settle();
    expect(FakeNativeWebSocket.instances).toHaveLength(1);
    const socket = FakeNativeWebSocket.instances[0];
    if (!(socket instanceof AwaitableSocket))
      throw new Error("the stream did not dial the fake host socket");
    socket.fireOpen();
    await settle();
    expect(sentFramesOfKind(socket, "open")[0].token).toBe(HELD_TOKEN);
    socket.fireMessage(
      openAckFrame([STREAM_CAPABILITY_CREDENTIAL_UPDATE], null),
    );
    await settle();
    expect(sentFramesOfKind(socket, "subscribe")).toHaveLength(1);

    // Another computer's token for this person, and this computer's token for
    // another person.
    await store(hostTokens, USER_A, OTHER_HOST_ID, "other-computer-token");
    await store(hostTokens, USER_B, HOST_ID, "other-person-token");
    // Then the session's own pair, whose frame bounds the wait: anything the
    // two changes above caused is on the socket ahead of it.
    const renewedSent = socket.frameCarrying(RENEWED_TOKEN);
    await store(hostTokens, USER_A, HOST_ID, RENEWED_TOKEN);
    await renewedSent;
    await settle();

    expect(sentFramesOfKind(socket, "credentialUpdate")).toEqual([
      { kind: "credentialUpdate", token: RENEWED_TOKEN },
    ]);
  });
});
