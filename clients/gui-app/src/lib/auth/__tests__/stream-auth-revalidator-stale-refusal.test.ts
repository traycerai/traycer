import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MutableBearerLease } from "@traycer-clients/shared/auth/bearer-source";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import {
  createReleasedHostMemory,
  releasedSignOnForLocalRow,
  type ReleasedSignOnRow,
} from "@traycer-clients/shared/host-transport/released-sign-on";
import { trackHostTokenMints } from "@traycer-clients/shared/auth/host-token-lease";
import {
  makeStubSocketFactory,
  type StubStreamWebSocket,
} from "@traycer-clients/shared/host-transport/__testing__/stub-stream-socket";
import { WsStreamClient } from "@traycer-clients/shared/host-transport/ws-stream-client";
import type { IStreamSession } from "@traycer-clients/shared/host-transport/i-stream-session";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";
import { AUTHENTICATED_USER_FIXTURE_ID } from "@traycer-clients/shared/test-fixtures/authenticated-user";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { RECONNECT_MAX_BACKOFF_MS } from "@traycer/protocol/host-transport/remote/config";
import { AuthService } from "@/lib/auth/auth-service";
import { createStreamAuthRevalidator } from "@/lib/auth/stream-auth-revalidator";

/**
 * A host refuses the sign-in a window's stream presented, and the window's
 * live bearer has meanwhile moved to another (a sibling window's refresh).
 * The refusal judged a sign-in the window no longer holds, so the stream
 * answers it itself and the app's recovery, which rotates on authn's verdict
 * on the CURRENT sign-in, is never asked: no `revalidateCurrentContext` (and
 * so no `validateToken`), no refresh spent, no no-progress counted, and one
 * redial presents the live bearer.
 *
 * The app's real `createStreamAuthRevalidator` is the stream's recovery, over
 * a real `AuthService` whose `revalidateCurrentContext` is spied on, passing
 * through to the real method.
 */

const USER_ID = AUTHENTICATED_USER_FIXTURE_ID;
const HOST_TOKEN = "host-only-token";
const SIGN_IN_A = "window-sign-in-a";
const SIGN_IN_B = "window-sign-in-b";
const WAIT = { interval: 10 };
const PERSONAL_ROW: ReleasedSignOnRow = {
  owner: { kind: "user", id: USER_ID },
  sandbox: null,
};
const NO_MINTS = trackHostTokenMints(
  {
    current: () => null,
    obtain: () => Promise.resolve({ kind: "no-sign-in" }),
    loaded: () => true,
    whenLoaded: () => Promise.resolve(),
    lastFailureOf: () => null,
  },
  createReleasedHostMemory(),
);

const RELEASED_REFUSAL = {
  kind: "fatalError",
  details: {
    code: "UNAUTHORIZED",
    reason: "released-host-token-refusal",
    incompatibleMethods: null,
    upgradeGuidance: null,
  },
} as const;

function makeService(): AuthService {
  const host = new MockRunnerHost({
    signInUrl:
      "https://auth.traycer.ai/sign-in?redirect_uri=traycer%3A%2F%2Fauth",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  return new AuthService({ runnerHost: host });
}

function readOpenToken(socket: StubStreamWebSocket): unknown {
  const frame: unknown = JSON.parse(socket.textSent[0]);
  if (typeof frame !== "object" || frame === null) {
    throw new Error("open frame was not an object");
  }
  return Reflect.get(frame, "token");
}

async function openFrameToken(socket: StubStreamWebSocket): Promise<unknown> {
  socket.fireOpen();
  await vi.waitFor(
    () => expect(socket.textSent.length).toBeGreaterThan(0),
    WAIT,
  );
  return readOpenToken(socket);
}

describe("a host's refusal of a sign-in the window's lease has replaced, through the app's recovery", () => {
  const sessions: IStreamSession[] = [];

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    for (const session of sessions.splice(0)) session.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  interface StreamRig {
    readonly sockets: StubStreamWebSocket[];
    readonly statuses: string[];
    readonly revalidations: () => number;
  }

  function streamWithAppRecovery(signIn: MutableBearerLease): StreamRig {
    const service = makeService();
    const revalidate = vi.spyOn(service, "revalidateCurrentContext");
    const { factory, sockets } = makeStubSocketFactory();
    const hostToken = new MutableBearerLease(HOST_TOKEN, USER_ID);
    const client = new WsStreamClient({
      clientIdentity: TEST_CLIENT_IDENTITY,
      registry: hostStreamRpcRegistry,
      endpoint: () => mockLocalHostEntry,
      hostId: mockLocalHostEntry.hostId,
      bearer: () => hostToken,
      userId: USER_ID,
      releasedSignOn: releasedSignOnForLocalRow(
        () => PERSONAL_ROW,
        mockLocalHostEntry.hostId,
        USER_ID,
        () => signIn,
        createStreamAuthRevalidator(service),
        NO_MINTS,
        createReleasedHostMemory(),
      ),
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
      door: {
        admitted: () => () => undefined,
        refused: () => undefined,
      },
    });
    const session = client.subscribe("git.subscribeStatus", {
      hostId: mockLocalHostEntry.hostId,
      runningDir: "/repo",
      ignoreWhitespace: false,
      freshNonce: null,
    });
    const statuses: string[] = [];
    session.onStatusChange((status) => {
      statuses.push(status);
    });
    sessions.push(session);
    return {
      sockets,
      statuses,
      revalidations: () => revalidate.mock.calls.length,
    };
  }

  async function presentedSignInA(
    signIn: MutableBearerLease,
  ): Promise<StreamRig> {
    const rig = streamWithAppRecovery(signIn);
    await vi.waitFor(() => expect(rig.sockets).toHaveLength(1), WAIT);
    expect(await openFrameToken(rig.sockets[0])).toBe(HOST_TOKEN);
    rig.sockets[0].fireText(RELEASED_REFUSAL);
    await vi.waitFor(() => expect(rig.sockets).toHaveLength(2), WAIT);
    expect(await openFrameToken(rig.sockets[1])).toBe(SIGN_IN_A);
    return rig;
  }

  it("never asks the recovery, and redials once presenting the live bearer", async () => {
    const signIn = new MutableBearerLease(SIGN_IN_A, USER_ID);
    const { sockets, statuses, revalidations } = await presentedSignInA(signIn);

    signIn.rotate(SIGN_IN_B);
    sockets[1].fireText(RELEASED_REFUSAL);
    await vi.waitFor(() => expect(sockets).toHaveLength(3), WAIT);

    expect(await openFrameToken(sockets[2])).toBe(SIGN_IN_B);
    expect(revalidations()).toBe(0);
    expect(sockets).toHaveLength(3);
    expect(statuses).not.toContain("closed");
  });

  it("counts no no-progress refusal across more stale refusals than the bound allows", async () => {
    const signIn = new MutableBearerLease(SIGN_IN_A, USER_ID);
    const { sockets, statuses, revalidations } = await presentedSignInA(signIn);

    for (let round = 1; round <= 4; round += 1) {
      const next = `window-sign-in-newer-${round}`;
      signIn.rotate(next);
      sockets[round].fireText(RELEASED_REFUSAL);
      await vi.waitFor(() => expect(sockets).toHaveLength(round + 2), WAIT);
      expect(await openFrameToken(sockets[round + 1])).toBe(next);
    }
    await vi.advanceTimersByTimeAsync(RECONNECT_MAX_BACKOFF_MS);

    expect(revalidations()).toBe(0);
    expect(statuses).not.toContain("closed");
  });

  it("still asks the recovery when the lease holds no bearer", async () => {
    const signIn = new MutableBearerLease(SIGN_IN_A, USER_ID);
    const { sockets, revalidations } = await presentedSignInA(signIn);

    signIn.rotate("");
    sockets[1].fireText(RELEASED_REFUSAL);

    await vi.waitFor(() => expect(revalidations()).toBe(1), WAIT);
  });
});
