import { MutableBearerLease } from "@traycer-clients/shared/auth/bearer-source";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";
import { AUTHENTICATED_USER_FIXTURE_ID } from "@traycer-clients/shared/test-fixtures/authenticated-user";
import type { FatalErrorDetails } from "@traycer/protocol/framework/index";
import { NO_HOST_TOKEN_PROBE } from "@traycer/protocol/framework/door-reason";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { EpicSessionLifecycleBridge } from "@/providers/auth-lifecycle-bridge";
import { useAuthStore } from "@/stores/auth/auth-store";
import { processReleasedHosts } from "@traycer-clients/shared/host-transport/released-sign-on";
import { resetNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { resetNegotiatedStreamVersions } from "@traycer-clients/shared/host-transport/negotiated-stream-version-registry";
import {
  makeStubSocketFactory,
  type StubStreamWebSocket,
} from "@traycer-clients/shared/host-transport/__testing__/stub-stream-socket";
import { WsStreamClient } from "@traycer-clients/shared/host-transport/ws-stream-client";

const USER_ID = AUTHENTICATED_USER_FIXTURE_ID;
const HOST_ID = "gui-sign-out-released-host";
const SIGN_IN = "gui-person-sign-in";
const WAIT = { interval: 10 };

const clients: WsStreamClient<typeof hostStreamRpcRegistry>[] = [];

function notAdmittedProbeRefusal(): {
  readonly kind: "fatalError";
  readonly details: FatalErrorDetails;
} {
  return {
    kind: "fatalError",
    details: {
      code: "UNAUTHORIZED",
      reason: "the host has not admitted this sign-in",
      doorReason: "not_admitted",
      retryable: false,
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  };
}

function readFrame(raw: string): Record<string, unknown> {
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

function openStream(hostToken: string | null): {
  readonly sockets: StubStreamWebSocket[];
  readonly client: WsStreamClient<typeof hostStreamRpcRegistry>;
} {
  const { factory, sockets } = makeStubSocketFactory();
  const client = new WsStreamClient({
    clientIdentity: TEST_CLIENT_IDENTITY,
    registry: hostStreamRpcRegistry,
    endpoint: () => ({
      hostId: HOST_ID,
      websocketUrl: "ws://127.0.0.1:9/rpc",
    }),
    hostId: HOST_ID,
    bearer: () =>
      hostToken === null ? null : new MutableBearerLease(hostToken, USER_ID),
    userId: USER_ID,
    releasedSignOn: {
      signIn: () => new MutableBearerLease(SIGN_IN, USER_ID),
      recovery: null,
      hostTokenUnobtainable: () => hostToken === null,
      ownerSignInEligible: () => hostToken === null,
      heldTokenRefused: () => false,
      forgetHeldRefusal: () => undefined,
      mayPresentSignIn: () => true,
      hosts: processReleasedHosts,
    },
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
  });
  clients.push(client);
  client.subscribe("git.subscribeStatus", {
    hostId: HOST_ID,
    runningDir: "/repo",
    ignoreWhitespace: false,
    freshNonce: null,
  });
  return { sockets, client };
}

async function openFrame(
  socket: StubStreamWebSocket,
): Promise<Record<string, unknown>> {
  socket.fireOpen();
  await vi.waitFor(
    () => expect(socket.textSent.length).toBeGreaterThan(0),
    WAIT,
  );
  return readFrame(socket.textSent[0]);
}

function setSignedIn(): void {
  useAuthStore.setState({
    status: "signed-in",
    profile: {
      userId: USER_ID,
      userName: "person@example.com",
      email: "person@example.com",
    },
    contextMetadata: { userId: USER_ID, username: "person@example.com" },
    signedOutCause: null,
  });
}

function setSignedOut(): void {
  useAuthStore.setState({
    status: "signed-out",
    profile: null,
    contextMetadata: null,
    signedOutCause: null,
  });
}

describe("released host memory across a gui sign-out", () => {
  beforeEach(() => {
    // The stream's waits and reconnect backoff run on this clock; `vi.waitFor`
    // advances it by its interval on every check.
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    for (const client of clients.splice(0)) client.close("test-done");
    processReleasedHosts.forgetAll();
    cleanup();
    setSignedOut();
    resetNegotiatedStreamVersions();
    resetNegotiatedManifests();
    vi.useRealTimers();
  });

  it("forgets a host remembered as released when the person signs out", () => {
    setSignedIn();
    render(
      <EpicSessionLifecycleBridge>
        <div />
      </EpicSessionLifecycleBridge>,
    );
    processReleasedHosts.signInAdmitted(
      USER_ID,
      processReleasedHosts.currentInstance(HOST_ID),
    );
    expect(processReleasedHosts.opensReleasedWay(USER_ID, HOST_ID)).toBe(true);

    act(() => setSignedOut());

    expect(processReleasedHosts.opensReleasedWay(USER_ID, HOST_ID)).toBe(false);
  });

  it("probes again after sign-out clears a declined probe", async () => {
    setSignedIn();
    render(
      <EpicSessionLifecycleBridge>
        <div />
      </EpicSessionLifecycleBridge>,
    );

    const first = openStream(null);
    await vi.waitFor(() => expect(first.sockets).toHaveLength(1), WAIT);
    const probe = await openFrame(first.sockets[0]);
    expect(probe.token).toBe(NO_HOST_TOKEN_PROBE);
    first.sockets[0]?.fireText(notAdmittedProbeRefusal());
    await vi.waitFor(() =>
      expect(processReleasedHosts.probeDeclined(USER_ID, HOST_ID)).toBe(true),
    );
    first.client.close("probe declined");

    act(() => setSignedOut());
    expect(processReleasedHosts.probeDeclined(USER_ID, HOST_ID)).toBe(false);
    act(() => setSignedIn());

    const next = openStream(null);
    await vi.waitFor(() => expect(next.sockets).toHaveLength(1), WAIT);
    expect((await openFrame(next.sockets[0])).token).toBe(NO_HOST_TOKEN_PROBE);
  });
});
