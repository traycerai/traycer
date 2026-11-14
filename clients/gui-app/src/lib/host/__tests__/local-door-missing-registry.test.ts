import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHostTokenSource,
  createMemoryHostTokenPersistence,
  type HostTokenMintOutcome,
} from "@traycer-clients/shared/auth/host-token-source";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { STREAM_CAPABILITY_HOST_CREDENTIAL_PROVISION } from "@traycer/protocol/framework/stream-ws-protocol";
import {
  FakeNativeWebSocket,
  liveBearer,
  newProvider,
  openAckFrame,
  sentFramesOfKind,
  settle,
  signIn,
  USER_A,
} from "@traycer-clients/shared/test-fixtures/dial-gate-harness";
import { DEFAULT_INITIAL_BACKOFF_MS } from "@traycer-clients/shared/host-transport/transport-config";
import type { HostCredentialMintRunner } from "@/lib/auth/host-credential-provisioning";
import {
  resetHostCredentialProvisioning,
  setHostCredentialMintRunner,
} from "@/lib/auth/host-credential-provisioning";
import { buildHostStreamClient } from "@/hooks/host/use-host-stream-client-for";

const USER_ID = USER_A;
const HOST_ID = "e7f51e2d-8b0b-4ffc-b732-8c3c69c53c5a";
const SIGN_IN_TOKEN = "sign-in-token";

describe("local host token open when the computer has no registry row", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeNativeWebSocket);
    FakeNativeWebSocket.instances.length = 0;
  });

  afterEach(async () => {
    setHostCredentialMintRunner(null);
    resetHostCredentialProvisioning();
    for (const socket of FakeNativeWebSocket.instances)
      socket.fireClose(1006, "test teardown");
    await settle();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("registers before OPEN and hands that same credential to provisioning", async () => {
    const hostTokenMints: string[] = [];
    const mintOutcomes: HostTokenMintOutcome[] = [
      { kind: "not-admitted" },
      {
        kind: "ok",
        token: {
          token: "host-token-after-registration",
          expiresAtMs: Date.now() + 60_000,
        },
      },
    ];
    const hostTokens = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: (hostId) => {
        hostTokenMints.push(hostId);
        const outcome = mintOutcomes.shift();
        if (outcome === undefined)
          throw new Error("unexpected host token mint");
        return Promise.resolve(outcome);
      },
      signIn: (userId) => (userId === USER_ID ? SIGN_IN_TOKEN : null),
      now: () => Date.now(),
    });
    const credentialMintRequests: string[] = [];
    const runner: HostCredentialMintRunner = (request) => {
      credentialMintRequests.push(`${request.hostId}:${request.reason}`);
      return Promise.resolve({
        kind: "provisioned",
        token: "host-credential-access",
        refreshToken: "host-credential-refresh",
        familyId: "family-a",
        provisionedAt: "2026-11-14T00:00:00Z",
        expiresIn: 300,
      });
    };
    setHostCredentialMintRunner(runner);
    const provider = newProvider();
    signIn(provider, USER_ID, SIGN_IN_TOKEN);
    const client = buildHostStreamClient({
      target: { ...mockLocalHostEntry, hostId: HOST_ID },
      endpoint: () =>
        mockLocalHostEntry.websocketUrl === null
          ? null
          : {
              hostId: HOST_ID,
              websocketUrl: mockLocalHostEntry.websocketUrl,
            },
      bearer: liveBearer(provider),
      cloudAuthorized: () => true,
      authnBaseUrl: "https://authn.test",
      auth: null,
      hostTokens,
      userId: USER_ID,
      proactiveWakeEligible: false,
      autoStart: false,
    });
    if (client === null) throw new Error("local stream client did not build");
    const session = client.subscribe("epic.subscribe", { epicId: "epic-a" });

    await vi.waitFor(() => expect(hostTokenMints).toEqual([HOST_ID, HOST_ID]));
    await vi.advanceTimersByTimeAsync(DEFAULT_INITIAL_BACKOFF_MS);
    await vi.waitFor(() =>
      expect(FakeNativeWebSocket.instances).toHaveLength(1),
    );
    const socket = FakeNativeWebSocket.instances[0];
    socket.fireOpen();
    await vi.waitFor(() =>
      expect(sentFramesOfKind(socket, "open")).toHaveLength(1),
    );
    const open = sentFramesOfKind(socket, "open")[0];
    expect(open.token).toBe("host-token-after-registration");
    expect(JSON.stringify(open)).not.toContain(SIGN_IN_TOKEN);

    socket.fireMessage(
      openAckFrame([STREAM_CAPABILITY_HOST_CREDENTIAL_PROVISION], "missing"),
    );
    await vi.waitFor(() =>
      expect(
        sentFramesOfKind(socket, "hostCredentialProvision"),
      ).toContainEqual({
        kind: "hostCredentialProvision",
        token: "host-credential-access",
        refreshToken: "host-credential-refresh",
        familyId: "family-a",
        provisionedAt: "2026-11-14T00:00:00Z",
      }),
    );

    expect(hostTokenMints).toEqual([HOST_ID, HOST_ID]);
    expect(credentialMintRequests).toEqual([`${HOST_ID}:missing`]);
    session.close();
    client.close("test complete");
  });
});
