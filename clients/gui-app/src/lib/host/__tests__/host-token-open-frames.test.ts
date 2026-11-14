import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostTokenRevalidator } from "@traycer-clients/shared/auth/host-token-lease";
import {
  createHostTokenSource,
  createMemoryHostTokenPersistence,
  type HostTokenMintOutcome,
  type HostTokenSource,
} from "@traycer-clients/shared/auth/host-token-source";
import type { HostOwnerPrincipal } from "@traycer/protocol/host/host-status";
import { SESSION_CAPABILITY_CREDENTIAL_UPDATE } from "@traycer/protocol/host-transport/mux";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import {
  FakeNativeWebSocket,
  liveBearer,
  newProvider,
  sentFramesOfKind,
  sentTokens,
  settle,
  signIn,
  openAckFrame,
  USER_A,
} from "@traycer-clients/shared/test-fixtures/dial-gate-harness";
import { DefaultRequestContextProvider } from "@traycer-clients/shared/auth/request-context-provider";
import { buildHostStreamClient } from "@/hooks/host/use-host-stream-client-for";
import {
  clearHostDoorState,
  hostDoorStateFor,
} from "@/stores/host/host-door-state-store";
import { noteHostTokenRenewal } from "@/lib/host/host-door-observer";
import { deriveWindowNarration } from "@/lib/host/window-narration";
import { DEFAULT_INITIAL_BACKOFF_MS } from "@traycer-clients/shared/host-transport/transport-config";

type HostTokenRevalidatorDependencies = Parameters<
  typeof import("@traycer-clients/shared/auth/host-token-lease").hostTokenRevalidator
>[0];

const { revalidateRefusedSpy } = vi.hoisted(() => ({
  revalidateRefusedSpy: vi.fn<HostTokenRevalidator["revalidateRefused"]>(),
}));

vi.mock(
  "@traycer-clients/shared/auth/host-token-lease",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/auth/host-token-lease")
      >();
    return {
      ...actual,
      hostTokenRevalidator: (deps: HostTokenRevalidatorDependencies) => {
        const real = actual.hostTokenRevalidator(deps);
        const revalidateRefused: HostTokenRevalidator["revalidateRefused"] =
          async (refusal) => {
            await revalidateRefusedSpy(refusal);
            return real.revalidateRefused(refusal);
          };
        return {
          ...real,
          revalidateRefused,
        };
      },
    };
  },
);

const SIGN_IN_TOKEN = "sign-in-token";

const LOCAL_DOOR_CASES: ReadonlyArray<{
  readonly name: string;
  readonly entry: HostDirectoryEntry & { readonly owner: HostOwnerPrincipal };
}> = [
  {
    name: "personal computer",
    entry: {
      ...mockLocalHostEntry,
      hostId: "local-personal-computer",
      owner: { kind: "user", id: USER_A },
    },
  },
  {
    name: "team computer",
    entry: {
      ...mockLocalHostEntry,
      hostId: "local-team-computer",
      owner: { kind: "team", id: "team-a", name: "Alpha" },
    },
  },
];

describe("local stream host-token open frame", () => {
  beforeEach(() => {
    revalidateRefusedSpy.mockClear();
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

  async function tokensWithLocalCredential(
    hostId: string,
    token: string,
  ): Promise<HostTokenSource> {
    const tokens = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: () => Promise.resolve({ kind: "no-sign-in" }),
      signIn: null,
      now: () => Date.now(),
    });
    await tokens.adopt(
      USER_A,
      hostId,
      {
        token,
        expiresAtMs: Date.now() + 3_600_000,
      },
      tokens.era(USER_A),
    );
    return tokens;
  }

  function buildLocalClient(
    target: HostDirectoryEntry,
    provider: DefaultRequestContextProvider,
    hostTokens: HostTokenSource,
  ) {
    const client = buildHostStreamClient({
      target,
      endpoint: () =>
        target.websocketUrl === null
          ? null
          : { hostId: target.hostId, websocketUrl: target.websocketUrl },
      bearer: liveBearer(provider),
      cloudAuthorized: () => true,
      authnBaseUrl: "https://authn.test",
      auth: null,
      hostTokens,
      userId: USER_A,
      proactiveWakeEligible: false,
      autoStart: false,
    });
    if (client === null) throw new Error("local stream client did not build");
    return client;
  }

  async function connectLocalStream(
    target: HostDirectoryEntry,
    provider: DefaultRequestContextProvider,
    hostTokens: HostTokenSource,
  ) {
    const client = buildLocalClient(target, provider, hostTokens);
    const session = client.subscribe("epic.subscribe", { epicId: "epic-a" });
    await vi.waitFor(() =>
      expect(FakeNativeWebSocket.instances).toHaveLength(1),
    );
    const socket = FakeNativeWebSocket.instances[0];
    socket.fireOpen();
    await settle();
    return { client, session, socket };
  }

  it.each(LOCAL_DOOR_CASES)(
    "opens a $name with a host token and never puts sign-in in OPEN",
    async ({ entry }) => {
      const provider = newProvider();
      signIn(provider, USER_A, SIGN_IN_TOKEN);
      const hostToken = `${entry.hostId}-token`;
      const { client, session, socket } = await connectLocalStream(
        entry,
        provider,
        await tokensWithLocalCredential(entry.hostId, hostToken),
      );

      const open = sentFramesOfKind(socket, "open")[0];
      expect(open.token).toBe(hostToken);
      expect(JSON.stringify(open)).not.toContain(SIGN_IN_TOKEN);
      expect(sentTokens()).not.toContain(SIGN_IN_TOKEN);
      session.close();
      client.close("test complete");
    },
  );

  it("does not throw, mint or raise state when signed out", async () => {
    const provider = newProvider();
    let mints = 0;
    const hostTokens = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: () => {
        mints += 1;
        return Promise.resolve({ kind: "no-sign-in" });
      },
      signIn: () => null,
      now: () => Date.now(),
    });
    const client = buildLocalClient(mockLocalHostEntry, provider, hostTokens);
    const session = client.subscribe("epic.subscribe", { epicId: "epic-a" });
    await settle();

    expect(mints).toBe(0);
    expect(FakeNativeWebSocket.instances).toHaveLength(0);
    expect(hostDoorStateFor(mockLocalHostEntry.hostId)).toBeNull();
    session.close();
  });

  it("does not mint or open when signed in but VerifiedSignIn has not verified the user", async () => {
    const provider = newProvider();
    signIn(provider, USER_A, SIGN_IN_TOKEN);
    let mints = 0;
    let verifiedSignInReads = 0;
    const hostTokens = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: () => {
        mints += 1;
        return Promise.resolve({ kind: "no-sign-in" });
      },
      signIn: () => {
        verifiedSignInReads += 1;
        return null;
      },
      now: () => Date.now(),
    });
    const client = buildLocalClient(mockLocalHostEntry, provider, hostTokens);
    const session = client.subscribe("epic.subscribe", { epicId: "epic-a" });
    await settle();
    await vi.waitFor(() => expect(verifiedSignInReads).toBeGreaterThan(0));
    await expect(
      hostTokens.obtain(USER_A, mockLocalHostEntry.hostId, false, null),
    ).resolves.toEqual({ kind: "no-sign-in" });

    expect(mints).toBe(0);
    expect(FakeNativeWebSocket.instances).toHaveLength(0);
    expect(sentTokens()).toEqual([]);
    expect(hostDoorStateFor(mockLocalHostEntry.hostId)).toBeNull();
    session.close();
    client.close("test complete");
  });

  it("admits a member's first team-computer open with no cover and one authn mint", async () => {
    const provider = newProvider();
    signIn(provider, USER_A, SIGN_IN_TOKEN);
    const entry = {
      ...mockLocalHostEntry,
      hostId: "local-first-team-computer",
      owner: { kind: "team", id: "team-a", name: "Alpha" },
    };
    const hostToken = "team-computer-host-token";
    const mintCalls: string[] = [];
    const hostTokens = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: (hostId) => {
        mintCalls.push(hostId);
        return Promise.resolve({
          kind: "ok",
          token: { token: hostToken, expiresAtMs: Date.now() + 60_000 },
        });
      },
      signIn: (userId) => (userId === USER_A ? SIGN_IN_TOKEN : null),
      now: () => Date.now(),
    });
    const client = buildLocalClient(entry, provider, hostTokens);
    const session = client.subscribe("epic.subscribe", { epicId: "epic-a" });
    let connected = false;
    session.onStatusChange((status) => {
      connected = status === "open";
    });
    await vi.waitFor(() => expect(mintCalls).toEqual([entry.hostId]));
    await vi.advanceTimersByTimeAsync(DEFAULT_INITIAL_BACKOFF_MS);
    await settle();
    await vi.waitFor(() =>
      expect(FakeNativeWebSocket.instances).toHaveLength(1),
    );
    const socket = FakeNativeWebSocket.instances[0];
    socket.fireOpen();
    await vi.waitFor(() =>
      expect(sentFramesOfKind(socket, "open")).toHaveLength(1),
    );
    const open = sentFramesOfKind(socket, "open")[0];
    socket.fireMessage(
      JSON.stringify({ kind: "openAck", manifest: open.manifest }),
    );
    await vi.waitFor(() => expect(connected).toBe(true));

    expect(open.token).toBe(hostToken);
    expect(JSON.stringify(open)).not.toContain(SIGN_IN_TOKEN);
    expect(mintCalls).toEqual([entry.hostId]);
    expect(hostDoorStateFor(entry.hostId)).toBeNull();
    expect(
      deriveWindowNarration({
        attached: true,
        effectiveHostId: entry.hostId,
        targetHostId: entry.hostId,
        leases: [{ hostId: entry.hostId, status: "ready", dead: null }],
        hasBeenServed: true,
        localHostExpected: true,
        discoveryConcluded: true,
        localHostId: entry.hostId,
        doorState: hostDoorStateFor(entry.hostId),
      }),
    ).toEqual({ kind: "silent" });

    session.close();
    client.close("test complete");
  });

  it("keeps access-check-delayed after a cached-token stream is admitted", async () => {
    const hostId = "local-delayed-after-admission";
    clearHostDoorState(hostId);
    const provider = newProvider();
    signIn(provider, USER_A, SIGN_IN_TOKEN);
    const hostTokens = await tokensWithLocalCredential(
      hostId,
      "cached-host-token",
    );
    noteHostTokenRenewal(hostId, true);
    expect(hostDoorStateFor(hostId)?.kind).toBe("access-check-delayed");

    const { client, session, socket } = await connectLocalStream(
      { ...mockLocalHostEntry, hostId },
      provider,
      hostTokens,
    );
    const open = sentFramesOfKind(socket, "open")[0];
    expect(open.token).toBe("cached-host-token");
    const statuses: string[] = [];
    session.onStatusChange((status) => statuses.push(status));
    socket.fireMessage(openAckFrame([], null));
    await vi.waitFor(() => expect(statuses).toContain("open"));

    expect(hostDoorStateFor(hostId)?.kind).toBe("access-check-delayed");
    noteHostTokenRenewal(hostId, false);
    expect(hostDoorStateFor(hostId)).toBeNull();

    session.close();
    client.close("test complete");
    clearHostDoorState(hostId);
  });

  it("clears keys-unavailable when a cached-token stream is admitted", async () => {
    const hostId = "local-keys-unavailable-after-admission";
    clearHostDoorState(hostId);
    const provider = newProvider();
    signIn(provider, USER_A, SIGN_IN_TOKEN);
    const hostTokens = await tokensWithLocalCredential(
      hostId,
      "cached-host-token",
    );
    const target = { ...mockLocalHostEntry, hostId };
    const client = buildLocalClient(target, provider, hostTokens);
    const session = client.subscribe("epic.subscribe", { epicId: "epic-a" });
    const statuses: string[] = [];
    session.onStatusChange((status) => statuses.push(status));
    const firstSocket = await vi.waitFor(() => {
      expect(FakeNativeWebSocket.instances).toHaveLength(1);
      return FakeNativeWebSocket.instances[0];
    });
    firstSocket.fireOpen();
    await vi.waitFor(() =>
      expect(sentFramesOfKind(firstSocket, "open")).toHaveLength(1),
    );
    firstSocket.fireMessage(openAckFrame([], null));
    await vi.waitFor(() => expect(statuses).toContain("open"));
    firstSocket.fireMessage(
      JSON.stringify({
        kind: "fatalError",
        details: {
          code: "NETWORK_ERROR",
          reason: "the host has not fetched its verification keys",
          doorReason: "keys_unavailable",
          retryable: true,
          incompatibleMethods: null,
          upgradeGuidance: null,
        },
      }),
    );
    await vi.waitFor(() =>
      expect(hostDoorStateFor(hostId)?.kind).toBe("keys-unavailable"),
    );
    await vi.waitFor(() => expect(statuses).toContain("reconnecting"));

    await vi.advanceTimersByTimeAsync(DEFAULT_INITIAL_BACKOFF_MS);
    const admittedSocket = await vi.waitFor(() => {
      expect(FakeNativeWebSocket.instances).toHaveLength(2);
      return FakeNativeWebSocket.instances[1];
    });
    admittedSocket.fireOpen();
    await vi.waitFor(() =>
      expect(sentFramesOfKind(admittedSocket, "open")).toHaveLength(1),
    );
    expect(sentFramesOfKind(admittedSocket, "open")[0]?.token).toBe(
      "cached-host-token",
    );
    admittedSocket.fireMessage(openAckFrame([], null));
    await vi.waitFor(() =>
      expect(statuses.filter((status) => status === "open")).toHaveLength(2),
    );

    expect(hostDoorStateFor(hostId)).toBeNull();
    session.close();
    client.close("test complete");
    clearHostDoorState(hostId);
  });

  it("self-heals an expired local token through reconnect backoff after authn returns", async () => {
    const provider = newProvider();
    signIn(provider, USER_A, SIGN_IN_TOKEN);
    const hostId = "local-token-self-heal";
    const target = { ...mockLocalHostEntry, hostId };
    const initialTokenExpiresAtMs = Date.now() + 60_000;
    const renewedTokenExpiresAtMs = Date.now() + 30_000;
    const outcomes: HostTokenMintOutcome[] = [
      { kind: "unavailable", detail: "authn offline during renewal" },
      {
        kind: "ok",
        token: {
          token: "renewed-after-authn-returns",
          expiresAtMs: renewedTokenExpiresAtMs,
        },
      },
      { kind: "unavailable", detail: "authn still offline after refusal" },
      {
        kind: "ok",
        token: {
          token: "fresh-after-outage",
          expiresAtMs: Date.now() + 60_000,
        },
      },
    ];
    let mintCalls = 0;
    const hostTokens = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: () => {
        mintCalls += 1;
        const outcome = outcomes.shift();
        if (outcome === undefined)
          throw new Error("unexpected host-token mint");
        return Promise.resolve(outcome);
      },
      signIn: (userId) => (userId === USER_A ? SIGN_IN_TOKEN : null),
      now: () => Date.now(),
    });
    await hostTokens.adopt(
      USER_A,
      hostId,
      {
        token: "held-before-outage",
        expiresAtMs: initialTokenExpiresAtMs,
      },
      hostTokens.era(USER_A),
    );
    const client = buildLocalClient(target, provider, hostTokens);
    const session = client.subscribe("epic.subscribe", { epicId: "epic-a" });
    let connected = false;
    session.onStatusChange((status) => {
      connected = status === "open";
    });
    await vi.waitFor(() =>
      expect(FakeNativeWebSocket.instances).toHaveLength(1),
    );
    const firstSocket = FakeNativeWebSocket.instances[0];
    firstSocket.fireOpen();
    await vi.waitFor(() =>
      expect(sentFramesOfKind(firstSocket, "open")).toHaveLength(1),
    );
    firstSocket.fireMessage(
      openAckFrame([SESSION_CAPABILITY_CREDENTIAL_UPDATE], null),
    );
    await vi.waitFor(() => expect(connected).toBe(true));

    const renewal = await hostTokens.renew(USER_A, [hostId]);
    expect(renewal).toEqual({ kind: "renewed", delayed: [hostId] });
    noteHostTokenRenewal(
      hostId,
      renewal.kind === "renewed" && renewal.delayed.includes(hostId),
    );
    expect(hostDoorStateFor(hostId)?.kind).toBe("access-check-delayed");
    expect(firstSocket.closed).toBeNull();
    expect(sentFramesOfKind(firstSocket, "open")).toHaveLength(1);

    const recoveredRenewal = await hostTokens.renew(USER_A, [hostId]);
    expect(recoveredRenewal).toEqual({ kind: "renewed", delayed: [] });
    noteHostTokenRenewal(
      hostId,
      recoveredRenewal.kind === "renewed" &&
        recoveredRenewal.delayed.includes(hostId),
    );
    client.notifyBearerRotated();
    await vi.waitFor(() =>
      expect(sentFramesOfKind(firstSocket, "credentialUpdate")).toContainEqual({
        kind: "credentialUpdate",
        token: "renewed-after-authn-returns",
      }),
    );
    expect(hostDoorStateFor(hostId)).toBeNull();
    expect(firstSocket.closed).toBeNull();
    expect(sentFramesOfKind(firstSocket, "open")).toHaveLength(1);

    vi.setSystemTime(renewedTokenExpiresAtMs + 1);
    firstSocket.fireMessage(
      JSON.stringify({
        kind: "fatalError",
        details: {
          code: "UNAUTHORIZED",
          reason: "host token expired",
          doorReason: "token_expired",
          incompatibleMethods: null,
          upgradeGuidance: null,
        },
      }),
    );
    await vi.waitFor(() => expect(mintCalls).toBe(3));
    await vi.waitFor(() =>
      expect(hostDoorStateFor(hostId)?.kind).toBe("token-expired"),
    );

    await vi.advanceTimersToNextTimerAsync();
    await vi.waitFor(() => expect(mintCalls).toBe(4));
    expect(FakeNativeWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersToNextTimerAsync();
    await vi.waitFor(() =>
      expect(FakeNativeWebSocket.instances).toHaveLength(2),
    );
    const recoveredSocket = FakeNativeWebSocket.instances[1];
    recoveredSocket.fireOpen();
    await vi.waitFor(() =>
      expect(sentFramesOfKind(recoveredSocket, "open")).toHaveLength(1),
    );
    const recoveredOpen = sentFramesOfKind(recoveredSocket, "open")[0];
    expect(recoveredOpen.token).toBe("fresh-after-outage");
    recoveredSocket.fireMessage(openAckFrame([], null));
    await vi.waitFor(() => expect(hostDoorStateFor(hostId)).toBeNull());

    expect(mintCalls).toBe(4);
    expect(connected).toBe(true);
    session.close();
    client.close("test complete");
    clearHostDoorState(hostId);
  });

  it("mints again after a real local open is admitted between not_admitted refusals", async () => {
    const hostId = "local-admitted-between-refusals";
    clearHostDoorState(hostId);
    const provider = newProvider();
    signIn(provider, USER_A, SIGN_IN_TOKEN);
    const outcomes: HostTokenMintOutcome[] = [
      {
        kind: "ok",
        token: {
          token: "fresh-after-first-refusal",
          expiresAtMs: Date.now() + 60_000,
        },
      },
      {
        kind: "ok",
        token: {
          token: "fresh-after-second-refusal",
          expiresAtMs: Date.now() + 60_000,
        },
      },
    ];
    let mintCalls = 0;
    const hostTokens = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: () => {
        mintCalls += 1;
        const outcome = outcomes.shift();
        if (outcome === undefined) throw new Error("unexpected token mint");
        return Promise.resolve(outcome);
      },
      signIn: (userId) => (userId === USER_A ? SIGN_IN_TOKEN : null),
      now: () => Date.now(),
    });
    await hostTokens.adopt(
      USER_A,
      hostId,
      { token: "initial-held-token", expiresAtMs: Date.now() + 60_000 },
      hostTokens.era(USER_A),
    );
    const client = buildLocalClient(
      { ...mockLocalHostEntry, hostId },
      provider,
      hostTokens,
    );
    const session = client.subscribe("epic.subscribe", { epicId: "epic-a" });
    const statuses: string[] = [];
    session.onStatusChange((status) => statuses.push(status));

    const firstSocket = await vi.waitFor(() => {
      expect(FakeNativeWebSocket.instances).toHaveLength(1);
      return FakeNativeWebSocket.instances[0];
    });
    firstSocket.fireOpen();
    await vi.waitFor(() =>
      expect(sentFramesOfKind(firstSocket, "open")).toHaveLength(1),
    );
    firstSocket.fireMessage(openAckFrame([], null));
    await vi.waitFor(() => expect(statuses).toContain("open"));
    firstSocket.fireMessage(
      JSON.stringify({
        kind: "fatalError",
        details: {
          code: "UNAUTHORIZED",
          reason: "host did not admit the token",
          doorReason: "not_admitted",
          incompatibleMethods: null,
          upgradeGuidance: null,
        },
      }),
    );

    await vi.waitFor(() => expect(mintCalls).toBe(1));
    expect(hostTokens.current(USER_A, hostId)?.token).toBe(
      "fresh-after-first-refusal",
    );
    await vi.advanceTimersToNextTimerAsync();
    const admittedSocket = await vi.waitFor(() => {
      expect(FakeNativeWebSocket.instances).toHaveLength(2);
      return FakeNativeWebSocket.instances[1];
    });
    admittedSocket.fireOpen();
    await vi.waitFor(() =>
      expect(sentFramesOfKind(admittedSocket, "open")).toHaveLength(1),
    );
    expect(sentFramesOfKind(admittedSocket, "open")[0]?.token).toBe(
      "fresh-after-first-refusal",
    );
    admittedSocket.fireMessage(openAckFrame([], null));
    await vi.waitFor(() =>
      expect(statuses.filter((status) => status === "open")).toHaveLength(2),
    );
    admittedSocket.fireMessage(
      JSON.stringify({
        kind: "fatalError",
        details: {
          code: "UNAUTHORIZED",
          reason: "host did not admit the token",
          doorReason: "not_admitted",
          incompatibleMethods: null,
          upgradeGuidance: null,
        },
      }),
    );

    await vi.waitFor(() => expect(mintCalls).toBe(2));
    expect(hostTokens.current(USER_A, hostId)?.token).toBe(
      "fresh-after-second-refusal",
    );
    expect(hostDoorStateFor(hostId)).toBeNull();
    expect(statuses).not.toContain("closed");

    session.close();
    client.close("test complete");
    clearHostDoorState(hostId);
  });

  it.each([
    { reason: "clock_skew", state: "clock-skew" },
    { reason: "enrolment_broken", state: "enrolment-broken" },
    { reason: "host_claimed", state: "host-claimed" },
  ])(
    "ends a stream on $reason without host-token revalidation",
    async ({ reason, state }) => {
      const hostId = `local-${reason}`;
      clearHostDoorState(hostId);
      const provider = newProvider();
      signIn(provider, USER_A, SIGN_IN_TOKEN);
      const tokens = await tokensWithLocalCredential(hostId, `${hostId}-token`);
      const target = { ...mockLocalHostEntry, hostId };
      const { client, session, socket } = await connectLocalStream(
        target,
        provider,
        tokens,
      );
      let closed = false;
      session.onStatusChange((status) => {
        closed = status === "closed";
      });
      await vi.waitFor(() =>
        expect(sentFramesOfKind(socket, "open")).toHaveLength(1),
      );
      socket.fireMessage(openAckFrame([], null));
      await settle();
      socket.fireMessage(
        JSON.stringify({
          kind: "fatalError",
          details: {
            code: "UNAUTHORIZED",
            reason: "host refused the session",
            doorReason: reason,
            incompatibleMethods: null,
            upgradeGuidance: null,
          },
        }),
      );
      await settle();

      expect(hostDoorStateFor(hostId)?.kind).toBe(state);
      expect(revalidateRefusedSpy).not.toHaveBeenCalled();
      expect(closed).toBe(true);
      session.close();
      client.close("test complete");
      clearHostDoorState(hostId);
    },
  );

  it.each([
    { code: "FORBIDDEN", state: null, retryable: false },
    { code: "TEAM_MEMBERSHIP_REQUIRED", state: "older-host", retryable: false },
    { code: "TEAM_MEMBERSHIP_UNAVAILABLE", state: null, retryable: false },
    { code: "INCOMPATIBLE", state: null, retryable: false },
    { code: "REMOTE_ACCESS_OFF", state: null, retryable: false },
    { code: "HOST_RESTARTING", state: null, retryable: false },
    { code: "UNAUTHORIZED", state: null, retryable: true },
    { code: "TEAM_MEMBERSHIP_REQUIRED", state: null, retryable: true },
    { code: "TEAM_MEMBERSHIP_UNAVAILABLE", state: null, retryable: true },
  ])(
    "records the expected state for a reasonless local fatal $code (retryable=$retryable)",
    async ({ code, state, retryable }) => {
      const hostId = `local-no-reason-${code}`;
      clearHostDoorState(hostId);
      const provider = newProvider();
      signIn(provider, USER_A, SIGN_IN_TOKEN);
      const { client, session, socket } = await connectLocalStream(
        { ...mockLocalHostEntry, hostId },
        provider,
        await tokensWithLocalCredential(hostId, `${hostId}-token`),
      );
      const statuses: string[] = [];
      session.onStatusChange((status) => statuses.push(status));
      await vi.waitFor(() =>
        expect(sentFramesOfKind(socket, "open")).toHaveLength(1),
      );
      socket.fireMessage(openAckFrame([], null));
      await settle();
      socket.fireMessage(
        JSON.stringify({
          kind: "fatalError",
          details: {
            code,
            reason: "host refusal without a door reason",
            ...(retryable ? { retryable: true } : {}),
            incompatibleMethods: null,
            upgradeGuidance: null,
          },
        }),
      );
      await settle();

      expect(hostDoorStateFor(hostId)?.kind ?? null).toBe(state);
      if (retryable) {
        await vi.waitFor(() => expect(statuses).toContain("reconnecting"));
        expect(statuses).not.toContain("closed");
        await vi.advanceTimersByTimeAsync(DEFAULT_INITIAL_BACKOFF_MS);
        await vi.waitFor(() =>
          expect(FakeNativeWebSocket.instances).toHaveLength(2),
        );
      } else {
        expect(statuses).toContain("closed");
      }
      session.close();
      client.close("test complete");
      clearHostDoorState(hostId);
    },
  );
});
