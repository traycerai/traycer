import { MutableBearerLease } from "@traycer-clients/shared/auth/bearer-source";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";
import { AUTHENTICATED_USER_FIXTURE_ID } from "@traycer-clients/shared/test-fixtures/authenticated-user";
import type { FatalErrorDetails } from "@traycer/protocol/framework/index";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { afterEach, describe, expect, it, vi } from "vitest";
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
const HOST_TOKEN = "gui-host-token";
const SIGN_IN = "gui-person-sign-in";
const WAIT = { timeout: 2_000, interval: 10 };

const clients: WsStreamClient<typeof hostStreamRpcRegistry>[] = [];

function releasedRefusal(): {
  readonly kind: "fatalError";
  readonly details: FatalErrorDetails;
} {
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

function openStream(): {
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
    bearer: () => new MutableBearerLease(HOST_TOKEN, USER_ID),
    userId: USER_ID,
    releasedSignOn: {
      signIn: () => new MutableBearerLease(SIGN_IN, USER_ID),
      recovery: null,
      allowed: () => Promise.resolve(true),
      hostTokenUnobtainable: () => false,
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
  await vi.waitFor(() => expect(socket.textSent.length).toBeGreaterThan(0), WAIT);
  return readFrame(socket.textSent[0]);
}

async function admitSignIn(): Promise<void> {
  const { sockets } = openStream();
  await vi.waitFor(() => expect(sockets.length).toBeGreaterThanOrEqual(1), WAIT);
  const refused = await openFrame(sockets[0]);
  expect(refused.token).toBe(HOST_TOKEN);
  sockets[0].fireText(releasedRefusal());
  await vi.waitFor(() => expect(sockets.length).toBeGreaterThanOrEqual(2), WAIT);
  const admitted = await openFrame(sockets[1]);
  expect(admitted.token).toBe(SIGN_IN);
  sockets[1].fireText({
    kind: "openAck",
    manifest: admitted.manifest,
    capabilities: ["credentialUpdate"],
  });
  await vi.waitFor(() => expect(sockets[1].textSent.length).toBeGreaterThan(0), WAIT);
}

async function firstOpenToken(): Promise<unknown> {
  const { sockets } = openStream();
  await vi.waitFor(() => expect(sockets.length).toBeGreaterThanOrEqual(1), WAIT);
  const opened = await openFrame(sockets[0]);
  return opened.token;
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
  afterEach(() => {
    for (const client of clients.splice(0)) client.close("test-done");
    processReleasedHosts.forgetAll();
    cleanup();
    setSignedOut();
    resetNegotiatedStreamVersions();
    resetNegotiatedManifests();
    vi.useRealTimers();
  });

  it("starts the next dial with the host-only token after signing out and back in", async () => {
    await admitSignIn();
    setSignedIn();
    render(
      <EpicSessionLifecycleBridge>
        <div />
      </EpicSessionLifecycleBridge>,
    );
    act(() => {
      setSignedOut();
    });
    act(() => {
      setSignedIn();
    });
    expect(await firstOpenToken()).toBe(HOST_TOKEN);
  });
});
