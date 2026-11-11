import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";
import type { DefaultRequestContextProvider } from "@traycer-clients/shared/auth/request-context-provider";
import { mockLocalHostEntry } from "../../host-client/mock/mock-host-directory";
import {
  cloudVerdictOf,
  FakeNativeWebSocket,
  liveBearer,
  NEVER_MS,
  newProvider,
  openAckFrame,
  requireContext,
  sentFramesOfKind,
  settle,
  signIn,
  signInUnverified,
  USER_A,
  USER_B,
  verdictUpdatesSent,
  sentTokens,
} from "../../test-fixtures/dial-gate-harness";
import type {
  HostCredentialMintFlow,
  HostCredentialMintOutcome,
  HostCredentialMintRequest,
} from "../host-credential-mint-flow";
import type { StreamConnectionStatus } from "../i-stream-session";
import { createWhatwgStreamWebSocketFactory } from "../whatwg-stream-ws-factory";
import { hostDialGate } from "../ws-dial-gate";
import type { HostEndpointProvider } from "../ws-rpc-client";
import { WsStreamClient } from "../ws-stream-client";

const REDIAL_BACKOFF_MS = 50;
const REDIAL_WINDOW_MS = 500;
// The retry timer waits the answer's retryAfterMs, floored at 1 s, plus up to 250 ms of jitter.
const PROVISION_RETRY_WINDOW_MS = 2_000;
const HOST_UUID = "6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7";
const LOCAL_ENDPOINT = {
  hostId: mockLocalHostEntry.hostId,
  websocketUrl: mockLocalHostEntry.websocketUrl,
};
const UUID_ENDPOINT = {
  hostId: HOST_UUID,
  websocketUrl: mockLocalHostEntry.websocketUrl,
};
const PROVISIONED: HostCredentialMintOutcome = {
  kind: "provisioned",
  token: "host-token",
  refreshToken: "host-refresh-token",
  familyId: "family-1",
  provisionedAt: "2026-10-19T00:00:00.000Z",
  expiresIn: 3_600,
};
const PENDING_ELSEWHERE: HostCredentialMintOutcome = {
  kind: "pending-elsewhere",
  retryAfterMs: 1_000,
};

/** A mint flow that answers with `outcomes` in order, then repeats the last. */
function scriptedMint(outcomes: readonly HostCredentialMintOutcome[]): {
  readonly flow: HostCredentialMintFlow;
  readonly requests: HostCredentialMintRequest[];
} {
  const requests: HostCredentialMintRequest[] = [];
  return {
    requests,
    flow: (request) => {
      requests.push(request);
      const outcome = outcomes[Math.min(requests.length, outcomes.length) - 1];
      return Promise.resolve(outcome);
    },
  };
}

describe("a stream client is bound to the user it was built for", () => {
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeNativeWebSocket);
    FakeNativeWebSocket.instances.length = 0;
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
    for (const native of FakeNativeWebSocket.instances) {
      native.fireClose(1006, "test");
    }
    await settle();
    expect(hostDialGate.stats()).toMatchObject({ connecting: 0, queued: 0 });
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function buildClient(
    provider: DefaultRequestContextProvider,
    endpoint: HostEndpointProvider,
    hostCredentialMint: HostCredentialMintFlow | null,
  ): WsStreamClient<typeof hostStreamRpcRegistry> {
    return new WsStreamClient({
      clientIdentity: TEST_CLIENT_IDENTITY,
      registry: hostStreamRpcRegistry,
      endpoint,
      hostId: null,
      bearer: liveBearer(provider),
      userId: USER_A,
      cloudAuthorized: cloudVerdictOf(provider),
      auth: null,
      clock: null,
      hostCredentialMint,
      onHostCredentialState: null,
      evidence: NO_TRANSPORT_EVIDENCE,
      webSocketFactory: createWhatwgStreamWebSocketFactory(),
      dialTimeoutMs: NEVER_MS,
      openAckTimeoutMs: NEVER_MS,
      pingIntervalMs: NEVER_MS,
      pongTimeoutMs: NEVER_MS,
      initialBackoffMs: REDIAL_BACKOFF_MS,
      maxBackoffMs: REDIAL_BACKOFF_MS,
    });
  }

  function subscribe(client: WsStreamClient<typeof hostStreamRpcRegistry>): {
    readonly statuses: StreamConnectionStatus[];
    readonly onStatus: (
      listener: (status: StreamConnectionStatus) => void,
    ) => void;
  } {
    const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
    cleanups.push(() => {
      session.close();
    });
    const statuses: StreamConnectionStatus[] = [];
    session.onStatusChange((status) => {
      statuses.push(status);
    });
    return {
      statuses,
      onStatus: (listener) => {
        session.onStatusChange(listener);
      },
    };
  }

  /** The socket of the first dial, with its open frame sent and no ack yet. */
  async function openFirstSocket(): Promise<FakeNativeWebSocket> {
    await settle();
    expect(FakeNativeWebSocket.instances).toHaveLength(1);
    const native = FakeNativeWebSocket.instances[0];
    native.fireOpen();
    await settle();
    expect(sentFramesOfKind(native, "open")).toHaveLength(1);
    return native;
  }

  async function ack(
    native: FakeNativeWebSocket,
    capabilities: readonly string[],
    hostCredentialState: string | null,
  ): Promise<void> {
    native.fireMessage(openAckFrame(capabilities, hostCredentialState));
    await settle();
    await settle();
    expect(sentFramesOfKind(native, "subscribe")).toHaveLength(1);
  }

  describe("the bearer", () => {
    it("backs off and reports it while the user it was built for is signed out", async () => {
      const provider = newProvider();
      const client = buildClient(provider, () => LOCAL_ENDPOINT, null);

      const { statuses } = subscribe(client);
      await vi.advanceTimersByTimeAsync(REDIAL_WINDOW_MS);

      expect(statuses).toContain("reconnecting");
      expect(FakeNativeWebSocket.instances).toHaveLength(0);
    });

    it("never sends the other user bearer when the first subscribe comes after an account switch", async () => {
      const provider = newProvider();
      signIn(provider, USER_A, "token-a");
      const client = buildClient(provider, () => LOCAL_ENDPOINT, null);
      signIn(provider, USER_B, "token-b");

      const { statuses } = subscribe(client);
      await vi.advanceTimersByTimeAsync(REDIAL_WINDOW_MS);

      expect(statuses).toContain("reconnecting");
      expect(FakeNativeWebSocket.instances).toHaveLength(0);
      expect(sentTokens()).not.toContain("token-b");

      signIn(provider, USER_A, "token-a2");
      await vi.advanceTimersByTimeAsync(REDIAL_WINDOW_MS);
      const native = await openFirstSocket();

      expect(sentFramesOfKind(native, "open")[0].token).toBe("token-a2");
    });

    it("never sends the other user bearer when it signs in after the first read found none", async () => {
      const provider = newProvider();
      const client = buildClient(provider, () => LOCAL_ENDPOINT, null);

      const { statuses } = subscribe(client);
      await settle();
      expect(FakeNativeWebSocket.instances).toHaveLength(0);

      signIn(provider, USER_B, "token-b");
      await vi.advanceTimersByTimeAsync(REDIAL_WINDOW_MS);

      expect(statuses).toContain("reconnecting");
      expect(FakeNativeWebSocket.instances).toHaveLength(0);
      expect(sentTokens()).not.toContain("token-b");

      signIn(provider, USER_A, "token-a");
      await vi.advanceTimersByTimeAsync(REDIAL_WINDOW_MS);
      const native = await openFirstSocket();

      expect(sentFramesOfKind(native, "open")[0].token).toBe("token-a");
    });

    it("never sends the other user bearer when the endpoint appears after an account switch", async () => {
      const provider = newProvider();
      signIn(provider, USER_A, "token-a");
      let endpoint: typeof LOCAL_ENDPOINT | null = null;
      const client = buildClient(provider, () => endpoint, null);

      const { statuses } = subscribe(client);
      await settle();
      expect(FakeNativeWebSocket.instances).toHaveLength(0);

      signIn(provider, USER_B, "token-b");
      endpoint = LOCAL_ENDPOINT;
      await vi.advanceTimersByTimeAsync(REDIAL_WINDOW_MS);

      expect(statuses).toContain("reconnecting");
      expect(FakeNativeWebSocket.instances).toHaveLength(0);
      expect(sentTokens()).not.toContain("token-b");

      signIn(provider, USER_A, "token-a");
      await vi.advanceTimersByTimeAsync(REDIAL_WINDOW_MS);
      const native = await openFirstSocket();

      expect(sentFramesOfKind(native, "open")[0].token).toBe("token-a");
    });
  });

  describe("the cloud verdict", () => {
    it("sends no verdict of the other user when the account switched before the ack", async () => {
      const provider = newProvider();
      signInUnverified(provider, USER_A, "token-a");
      const client = buildClient(provider, () => LOCAL_ENDPOINT, null);
      subscribe(client);
      const native = await openFirstSocket();
      expect(sentFramesOfKind(native, "open")[0].cloudAuthorized).toBe(false);

      signIn(provider, USER_B, "token-b");
      await ack(native, ["cloudVerdictUpdate"], null);

      expect(verdictUpdatesSent(native)).not.toContain(true);
    });

    it("sends no verdict of the other user when the account switched while the handshake finished", async () => {
      const provider = newProvider();
      signInUnverified(provider, USER_A, "token-a");
      const client = buildClient(provider, () => LOCAL_ENDPOINT, null);
      const { onStatus } = subscribe(client);
      onStatus((status) => {
        if (status === "open") {
          signIn(provider, USER_B, "token-b");
        }
      });
      const native = await openFirstSocket();
      expect(sentFramesOfKind(native, "open")[0].cloudAuthorized).toBe(false);

      await ack(native, ["cloudVerdictUpdate"], null);

      expect(requireContext(provider).identity.userId).toBe(USER_B);
      expect(verdictUpdatesSent(native)).not.toContain(true);
    });

    it("sends no verdict of the other user when a push follows an account switch", async () => {
      const provider = newProvider();
      signInUnverified(provider, USER_A, "token-a");
      const client = buildClient(provider, () => LOCAL_ENDPOINT, null);
      subscribe(client);
      const native = await openFirstSocket();
      await ack(native, ["cloudVerdictUpdate"], null);

      signIn(provider, USER_B, "token-b");
      client.notifyCloudVerdictChanged();
      await settle();

      expect(verdictUpdatesSent(native)).not.toContain(true);
    });

    it("still pushes a same-user promotion in place", async () => {
      const provider = newProvider();
      signInUnverified(provider, USER_A, "token-a");
      const client = buildClient(provider, () => LOCAL_ENDPOINT, null);
      subscribe(client);
      const native = await openFirstSocket();
      await ack(native, ["cloudVerdictUpdate"], null);

      requireContext(provider).setCloudAuthorized(true);
      client.notifyCloudVerdictChanged();
      await settle();

      expect(verdictUpdatesSent(native)).toEqual([true]);
    });

    it("still pushes a same-user demotion in place", async () => {
      const provider = newProvider();
      signIn(provider, USER_A, "token-a");
      const client = buildClient(provider, () => LOCAL_ENDPOINT, null);
      subscribe(client);
      const native = await openFirstSocket();
      expect(sentFramesOfKind(native, "open")[0].cloudAuthorized).toBe(true);
      await ack(native, ["cloudVerdictUpdate"], null);

      requireContext(provider).setCloudAuthorized(false);
      client.notifyCloudVerdictChanged();
      await settle();

      expect(verdictUpdatesSent(native)).toEqual([false]);
    });

    it("keeps the verdict live across a same-user re-sign-in", async () => {
      const provider = newProvider();
      signInUnverified(provider, USER_A, "token-a");
      const client = buildClient(provider, () => LOCAL_ENDPOINT, null);
      subscribe(client);
      const native = await openFirstSocket();
      await ack(native, ["cloudVerdictUpdate"], null);

      signIn(provider, USER_A, "token-a2");
      client.notifyCloudVerdictChanged();
      await settle();

      expect(verdictUpdatesSent(native)).toEqual([true]);
    });
  });

  describe("the host credential mint", () => {
    it("starts no mint and sends no provision frame when the account switched before the ack", async () => {
      const provider = newProvider();
      signIn(provider, USER_A, "token-a");
      const mint = scriptedMint([PROVISIONED]);
      const client = buildClient(provider, () => UUID_ENDPOINT, mint.flow);
      subscribe(client);
      const native = await openFirstSocket();

      signIn(provider, USER_B, "token-b");
      await ack(native, ["hostCredentialProvision"], "missing");
      await settle();

      expect(sentFramesOfKind(native, "hostCredentialProvision")).toEqual([]);
      expect(mint.requests).toEqual([]);
    });

    it("sends the provision frame when the account did not change", async () => {
      const provider = newProvider();
      signIn(provider, USER_A, "token-a");
      const mint = scriptedMint([PROVISIONED]);
      const client = buildClient(provider, () => UUID_ENDPOINT, mint.flow);
      subscribe(client);
      const native = await openFirstSocket();

      await ack(native, ["hostCredentialProvision"], "missing");
      await settle();

      expect(mint.requests).toEqual([{ hostId: HOST_UUID, reason: "missing" }]);
      expect(sentFramesOfKind(native, "hostCredentialProvision")).toHaveLength(
        1,
      );
    });

    it("starts no retry mint and sends no provision frame when the account switched before the retry timer", async () => {
      const provider = newProvider();
      signIn(provider, USER_A, "token-a");
      const mint = scriptedMint([PENDING_ELSEWHERE, PROVISIONED]);
      const client = buildClient(provider, () => UUID_ENDPOINT, mint.flow);
      subscribe(client);
      const native = await openFirstSocket();
      await ack(native, ["hostCredentialProvision"], "missing");
      await settle();
      expect(mint.requests).toHaveLength(1);

      signIn(provider, USER_B, "token-b");
      await vi.advanceTimersByTimeAsync(PROVISION_RETRY_WINDOW_MS);
      await settle();

      expect(sentFramesOfKind(native, "hostCredentialProvision")).toEqual([]);
      expect(mint.requests).toHaveLength(1);
    });

    it("retries the mint and sends the provision frame when the account did not change", async () => {
      const provider = newProvider();
      signIn(provider, USER_A, "token-a");
      const mint = scriptedMint([PENDING_ELSEWHERE, PROVISIONED]);
      const client = buildClient(provider, () => UUID_ENDPOINT, mint.flow);
      subscribe(client);
      const native = await openFirstSocket();
      await ack(native, ["hostCredentialProvision"], "missing");
      await settle();
      expect(mint.requests).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(PROVISION_RETRY_WINDOW_MS);
      await settle();

      expect(mint.requests).toHaveLength(2);
      expect(sentFramesOfKind(native, "hostCredentialProvision")).toHaveLength(
        1,
      );
    });
  });
});
