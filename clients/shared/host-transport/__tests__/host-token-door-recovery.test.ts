import { describe, expect, it, vi } from "vitest";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import { RECONNECT_INITIAL_BACKOFF_MS } from "@traycer/protocol/host-transport/remote/config";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import { MutableBearerLease } from "@traycer-clients/shared/auth/bearer-source";
import type { StreamAuthRevalidator } from "@traycer-clients/shared/auth/bearer-revalidator";
import {
  createHostTokenSource,
  createMemoryHostTokenPersistence,
  type HostTokenMintOutcome,
  type HostTokenSource,
} from "@traycer-clients/shared/auth/host-token-source";
import {
  hostTokenRevalidator,
  type HostTokenRevalidator,
} from "@traycer-clients/shared/auth/host-token-lease";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";
import { createRemoteHostTransport } from "../remote/create-remote-transport";
import { retireAllRemoteSessions } from "../remote/active-remote-sessions";
import { RemoteMuxTestPeer } from "./remote-mux-test-peer";
import {
  hostDoorStateOfRefusal,
  type HostDoorStateKind,
} from "../host-door-state";

const USER_ID = "user-a";
const HOST_ID = "computer-a";
const NOW = 1_000_000;

function refusal(
  code: string,
  doorReason: string | undefined,
  retryable: boolean,
): FatalErrorDetails {
  return {
    code,
    reason: "refused at the host door",
    incompatibleMethods: null,
    upgradeGuidance: null,
    ...(doorReason === undefined ? {} : { doorReason }),
    ...(retryable ? { retryable: true } : {}),
  };
}

interface RecoveryHarness {
  readonly tokens: HostTokenSource;
  readonly mintCalls: string[];
  readonly states: HostDoorStateKind[];
  readonly signInCalls: string[];
  readonly recover: HostTokenRevalidator;
}

async function harness(
  outcomes: readonly HostTokenMintOutcome[],
  signInRecovery: StreamAuthRevalidator | null,
): Promise<RecoveryHarness> {
  const queued = [...outcomes];
  const mintCalls: string[] = [];
  const states: HostDoorStateKind[] = [];
  const signInCalls: string[] = [];
  const tokens = createHostTokenSource({
    persistence: createMemoryHostTokenPersistence(),
    mint: () => {
      mintCalls.push(HOST_ID);
      const outcome = queued.shift();
      if (outcome === undefined) throw new Error("unexpected token mint");
      return Promise.resolve(outcome);
    },
    signIn: (userId) => (userId === USER_ID ? "signed-in" : null),
    now: () => NOW,
  });
  await tokens.adopt(USER_ID, HOST_ID, {
    token: "held-token",
    expiresAtMs: NOW + 10_000,
  });
  const recovery = signInRecovery ?? {
    revalidateForReconnect: () => {
      signInCalls.push("sign-in");
      return Promise.resolve("rotated" as const);
    },
  };
  return {
    tokens,
    mintCalls,
    states,
    signInCalls,
    recover: hostTokenRevalidator({
      tokens,
      currentUserId: () => USER_ID,
      hostId: HOST_ID,
      signInRecovery: recovery,
      onState: (_hostId, state) => states.push(state),
      now: () => NOW,
    }),
  };
}

function tokenOutcome(token: string): HostTokenMintOutcome {
  return {
    kind: "ok",
    token: { token, expiresAtMs: NOW + 20_000 },
  };
}

describe("host-token refusal recovery", () => {
  it("silently mints a replacement for token_expired", async () => {
    const test = await harness([tokenOutcome("fresh-token")], null);

    await expect(
      test.recover.revalidateRefused(
        refusal("UNAUTHORIZED", "token_expired", false),
      ),
    ).resolves.toBe("rotated");

    expect(test.mintCalls).toEqual([HOST_ID]);
    expect(test.tokens.current(USER_ID, HOST_ID)?.token).toBe("fresh-token");
    expect(test.states).toEqual([]);
    expect(test.signInCalls).toEqual([]);
  });

  it("mints again for token_expired after an unavailable replacement", async () => {
    const test = await harness(
      [
        { kind: "unavailable", detail: "authn answered HTTP 503" },
        tokenOutcome("fresh-token"),
      ],
      null,
    );
    const expired = refusal("UNAUTHORIZED", "token_expired", false);

    await expect(test.recover.revalidateRefused(expired)).resolves.toBe(
      "network-error",
    );
    expect(test.tokens.current(USER_ID, HOST_ID)?.token).toBe("held-token");
    await expect(test.recover.revalidateRefused(expired)).resolves.toBe(
      "rotated",
    );

    expect(test.mintCalls).toEqual([HOST_ID, HOST_ID]);
    expect(test.tokens.current(USER_ID, HOST_ID)?.token).toBe("fresh-token");
    expect(test.states).toEqual(["token-unavailable"]);
  });

  it("mints once for not_admitted and raises state only when that fresh token is refused again", async () => {
    const test = await harness([tokenOutcome("fresh-token")], null);
    const refusalDetails = refusal("UNAUTHORIZED", "not_admitted", false);

    await expect(test.recover.revalidateRefused(refusalDetails)).resolves.toBe(
      "rotated",
    );
    await expect(test.recover.revalidateRefused(refusalDetails)).resolves.toBe(
      "rejected",
    );

    expect(test.mintCalls).toEqual([HOST_ID]);
    expect(test.states).toEqual(["not-admitted"]);
    expect(test.signInCalls).toEqual([]);
  });

  it("mints again for not_admitted after an unavailable replacement", async () => {
    const test = await harness(
      [
        { kind: "unavailable", detail: "authn answered HTTP 503" },
        tokenOutcome("fresh-token"),
      ],
      null,
    );
    const notAdmitted = refusal("UNAUTHORIZED", "not_admitted", false);

    await expect(test.recover.revalidateRefused(notAdmitted)).resolves.toBe(
      "network-error",
    );
    expect(test.tokens.current(USER_ID, HOST_ID)?.token).toBe("held-token");
    await expect(test.recover.revalidateRefused(notAdmitted)).resolves.toBe(
      "rotated",
    );

    expect(test.mintCalls).toEqual([HOST_ID, HOST_ID]);
    expect(test.tokens.current(USER_ID, HOST_ID)?.token).toBe("fresh-token");
    expect(test.states).toEqual(["token-unavailable"]);
  });

  it("routes session_revoked through sign-in recovery without minting a host token", async () => {
    const signInCalls: string[] = [];
    const signInRecovery: StreamAuthRevalidator = {
      revalidateForReconnect: () => {
        signInCalls.push("refresh");
        return Promise.resolve("rotated");
      },
    };
    const test = await harness([], signInRecovery);

    await expect(
      test.recover.revalidateRefused(
        refusal("UNAUTHORIZED", "session_revoked", false),
      ),
    ).resolves.toBe("rejected");

    expect(signInCalls).toEqual(["refresh"]);
    expect(test.mintCalls).toEqual([]);
  });

  it("treats absent and unknown reasons as host states without sign-in recovery", async () => {
    const test = await harness([], null);
    const absent = refusal("UNAUTHORIZED", undefined, false);
    const unknown = refusal("UNAUTHORIZED", "future_reason", false);

    await expect(test.recover.revalidateRefused(absent)).resolves.toBe(
      "rejected",
    );
    await expect(test.recover.revalidateRefused(unknown)).resolves.toBe(
      "rejected",
    );

    expect(hostDoorStateOfRefusal(absent)).toBe("older-host");
    expect(hostDoorStateOfRefusal(unknown)).toBe("unrecognised-refusal");
    expect(test.mintCalls).toEqual([]);
    expect(test.signInCalls).toEqual([]);
  });

  it("uses sign-in recovery once when authn rejects the held sign-in token", async () => {
    let calls = 0;
    const signInRecovery: StreamAuthRevalidator = {
      revalidateForReconnect: () => {
        calls += 1;
        return Promise.resolve("rotated");
      },
    };
    const test = await harness(
      [{ kind: "sign-in-rejected" }, tokenOutcome("fresh-after-sign-in")],
      signInRecovery,
    );

    await expect(
      test.recover.revalidateRefused(
        refusal("UNAUTHORIZED", "token_expired", false),
      ),
    ).resolves.toBe("rotated");

    expect(calls).toBe(1);
    expect(test.mintCalls).toEqual([HOST_ID, HOST_ID]);
    expect(test.tokens.current(USER_ID, HOST_ID)?.token).toBe(
      "fresh-after-sign-in",
    );
  });

  it("retries retryable not_admitted on plain backoff without mint or state", async () => {
    vi.useFakeTimers();
    const relayPeer = new RemoteMuxTestPeer();
    relayPeer.refuseFirstOpen(refusal("UNAUTHORIZED", "not_admitted", true));
    const mintCalls: string[] = [];
    const stateCalls: HostDoorStateKind[] = [];
    const tokens = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: (hostId) => {
        mintCalls.push(hostId);
        return Promise.resolve(tokenOutcome("unexpected-fresh-token"));
      },
      signIn: (userId) => (userId === USER_ID ? "signed-in" : null),
      now: () => Date.now(),
    });
    await tokens.adopt(USER_ID, HOST_ID, {
      token: "held-token",
      expiresAtMs: Date.now() + 60_000,
    });
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            grant: "relay-pass",
            role: "client",
            expires_in: 300,
            session_grant: "held-token",
            session_grant_expires_in: 3_600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const transport = createRemoteHostTransport({
      hostId: HOST_ID,
      userId: USER_ID,
      relayAttachUrl: "wss://relay.test/attach",
      authnBaseUrl: "https://authn.test",
      hostPublicKey: relayPeer.hostPublicKey,
      bearer: () => new MutableBearerLease("signed-in", USER_ID),
      hostTokens: tokens,
      door: null,
      onState: (_hostId, state) => stateCalls.push(state),
      cloudAuthorized: () => true,
      auth: {
        revalidateForReconnect: () => Promise.resolve("rotated"),
      },
      clock: null,
      rpcRegistry: hostRpcRegistry,
      streamRegistry: hostStreamRpcRegistry,
      webSocketFactory: relayPeer.factory,
      requestId: () => "retryable-door-request",
      evidence: NO_TRANSPORT_EVIDENCE,
      clientIdentity: TEST_CLIENT_IDENTITY,
      proactiveWakeEligible: false,
    });
    if (transport === null)
      throw new Error("retryable-door transport did not build");

    try {
      transport.session.start();
      await vi.waitFor(() => expect(relayPeer.openCount).toBe(1));
      expect(mintCalls).toEqual([]);
      expect(stateCalls).toEqual([]);
      expect(transport.session.isClosed()).toBe(false);

      await vi.advanceTimersByTimeAsync(RECONNECT_INITIAL_BACKOFF_MS * 2);
      await vi.waitFor(() => expect(relayPeer.openCount).toBe(2));
      await vi.waitFor(() => expect(transport.session.isReady()).toBe(true));

      expect(mintCalls).toEqual([]);
      expect(stateCalls).toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(relayPeer.errors).toEqual([]);
    } finally {
      transport.session.close();
      retireAllRemoteSessions();
      vi.useRealTimers();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });
});
