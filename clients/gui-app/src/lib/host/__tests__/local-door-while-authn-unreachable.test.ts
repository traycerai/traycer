import { NO_HOST_TOKEN_PROBE } from "@traycer/protocol/framework/door-reason";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import type { StreamAuthRevalidator } from "@traycer-clients/shared/auth/bearer-revalidator";
import {
  createHostTokenSource,
  createMemoryHostTokenPersistence,
  type HostTokenMintOutcome,
  type HostTokenSource,
} from "@traycer-clients/shared/auth/host-token-source";
import { processReleasedHosts } from "@traycer-clients/shared/host-transport/released-sign-on";
import type { SessionDoorObserver } from "@traycer/protocol/host-transport/remote/auth";
import { DEFAULT_INITIAL_BACKOFF_MS } from "@traycer-clients/shared/host-transport/transport-config";
import {
  FakeNativeWebSocket,
  liveBearer,
  newProvider,
  openAckFrame,
  sentFramesOfKind,
  sentTokens,
  settle,
  signIn,
  USER_A,
} from "@traycer-clients/shared/test-fixtures/dial-gate-harness";
import { buildHostStreamClient } from "@/hooks/host/use-host-stream-client-for";
import {
  resetHostCredentialProvisioning,
  setHostCredentialMintRunner,
} from "@/lib/auth/host-credential-provisioning";
import {
  clearHostDoorState,
  hostDoorStateFor,
} from "@/stores/host/host-door-state-store";

const SIGN_IN_TOKEN = "sign-in-token";
const ELEVEN_MINUTES_MS = 11 * 60 * 1000;
const heard: FatalErrorDetails[] = [];
const HOST_ONLY_AFTER_MINT = "host-only-after-mint";
let presentedSignIn = SIGN_IN_TOKEN;
let streamAuth: StreamAuthRevalidator | null = null;
let activeClients: Array<() => void> = [];
let activeHostIds = new Set<string>();

type NamedDoorReason =
  | "not_admitted"
  | "owner_sign_in"
  | "not_provisioned"
  | "token_expired";

vi.mock("@/lib/host/host-door-observer", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/host/host-door-observer")>();
  return {
    ...actual,
    appHostDoorObserver: (hostId: string): SessionDoorObserver => {
      const door = actual.appHostDoorObserver(hostId);
      return {
        admitted: () => {
          door.admitted();
        },
        refused: (details) => {
          heard.push(details);
          door.refused(details);
        },
      };
    },
  };
});

function expiredJwt(nowMs: number): {
  readonly token: string;
  readonly expiresAtMs: number;
} {
  const expiresAtMs = nowMs - ELEVEN_MINUTES_MS;
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(expiresAtMs / 1000) }),
  ).toString("base64url");
  return { token: `${header}.${payload}.`, expiresAtMs };
}

function releasedRefusal(): string {
  return JSON.stringify({
    kind: "fatalError",
    details: {
      code: "UNAUTHORIZED",
      reason: "released-host-token-refusal",
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  });
}

function retryableProbeFatal(): string {
  return JSON.stringify({
    kind: "fatalError",
    details: {
      code: "UNAUTHORIZED",
      reason: "host still starting",
      retryable: true,
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  });
}

function namedRefusal(doorReason: NamedDoorReason): string {
  return JSON.stringify({
    kind: "fatalError",
    details: {
      code: "UNAUTHORIZED",
      reason: "current-host-refusal",
      doorReason,
      retryable: false,
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  });
}

function targetFor(
  hostId: string,
  owner: HostDirectoryEntry["owner"],
): HostDirectoryEntry {
  return { ...mockLocalHostEntry, hostId, owner };
}

async function tokensFor(
  hostId: string,
  outcomes: readonly HostTokenMintOutcome[],
  held: { readonly token: string; readonly expiresAtMs: number } | null,
): Promise<{
  readonly source: HostTokenSource;
  readonly mintCalls: () => number;
}> {
  const queue = [...outcomes];
  let mintCalls = 0;
  const source = createHostTokenSource({
    persistence: createMemoryHostTokenPersistence(),
    mint: () => {
      mintCalls += 1;
      return Promise.resolve(queue[mintCalls - 1]);
    },
    signIn: (userId) => (userId === USER_A ? SIGN_IN_TOKEN : null),
    now: () => Date.now(),
  });
  if (held !== null) {
    await source.adopt(USER_A, hostId, held, source.era(USER_A));
  }
  return { source, mintCalls: () => mintCalls };
}

/**
 * An app started while authn cannot be reached. The stored sign-in stays the
 * window's lease, but the session is unverified, so this source's `signIn`
 * returns null and every mint ends `no-sign-in` without asking authn.
 */
async function unverifiedTokens(
  hostId: string,
  held: { readonly token: string; readonly expiresAtMs: number } | null,
): Promise<{
  readonly source: HostTokenSource;
  readonly signInReads: () => number;
  readonly mintCalls: () => number;
}> {
  let signInReads = 0;
  let mintCalls = 0;
  const source = createHostTokenSource({
    persistence: createMemoryHostTokenPersistence(),
    mint: () => {
      mintCalls += 1;
      return Promise.resolve({
        kind: "unavailable",
        detail: "authn was asked",
      });
    },
    signIn: () => {
      signInReads += 1;
      return null;
    },
    now: () => Date.now(),
  });
  if (held !== null) {
    await source.adopt(USER_A, hostId, held, source.era(USER_A));
  }
  return {
    source,
    signInReads: () => signInReads,
    mintCalls: () => mintCalls,
  };
}

function openClient(
  hostId: string,
  source: HostTokenSource,
  owner: HostDirectoryEntry["owner"],
) {
  const provider = newProvider();
  signIn(provider, USER_A, presentedSignIn);
  const target = targetFor(hostId, owner);
  const client = buildHostStreamClient({
    target,
    endpoint: () =>
      target.websocketUrl === null
        ? null
        : { hostId: target.hostId, websocketUrl: target.websocketUrl },
    bearer: liveBearer(provider),
    cloudAuthorized: () => true,
    authnBaseUrl: "https://authn.test",
    auth: streamAuth,
    hostTokens: source,
    userId: USER_A,
    proactiveWakeEligible: false,
    autoStart: false,
  });
  if (client === null) throw new Error("local stream client did not build");
  const session = client.subscribe("epic.subscribe", { epicId: "epic-a" });
  activeHostIds.add(hostId);
  activeClients.push(() => {
    session.close();
    client.close("test teardown");
  });
  return { client, session };
}

async function socketAt(count: number): Promise<FakeNativeWebSocket> {
  if (FakeNativeWebSocket.instances.length < count) {
    await vi.advanceTimersToNextTimerAsync();
  }
  return socketCounted(count);
}

/** A dial the client starts on the current turn, with no backoff to advance. */
async function socketOnThisTurn(count: number): Promise<FakeNativeWebSocket> {
  await settle();
  return socketCounted(count);
}

async function socketCounted(count: number): Promise<FakeNativeWebSocket> {
  await vi.waitFor(() =>
    expect(FakeNativeWebSocket.instances).toHaveLength(count),
  );
  return FakeNativeWebSocket.instances[count - 1];
}

async function readOpen(
  socket: FakeNativeWebSocket,
): Promise<Record<string, unknown>> {
  socket.fireOpen();
  await vi.waitFor(() =>
    expect(sentFramesOfKind(socket, "open")).toHaveLength(1),
  );
  return sentFramesOfKind(socket, "open")[0];
}

describe("local stream while authn cannot mint", () => {
  beforeEach(() => {
    heard.length = 0;
    presentedSignIn = SIGN_IN_TOKEN;
    streamAuth = null;
    activeClients = [];
    activeHostIds = new Set();
    processReleasedHosts.forgetAll();
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeNativeWebSocket);
    FakeNativeWebSocket.instances.length = 0;
  });

  afterEach(async () => {
    for (const close of activeClients) close();
    setHostCredentialMintRunner(null);
    resetHostCredentialProvisioning();
    for (const socket of FakeNativeWebSocket.instances)
      socket.fireClose(1006, "test teardown");
    await settle();
    for (const hostId of activeHostIds) clearHostDoorState(hostId);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("opens with the held expired token and raises no door state", async () => {
    const hostId = "local-held-expired";
    clearHostDoorState(hostId);
    const expired = expiredJwt(Date.now());
    const { source, mintCalls } = await tokensFor(
      hostId,
      [
        { kind: "unavailable", detail: "authn offline" },
        { kind: "unavailable", detail: "authn still offline" },
      ],
      expired,
    );
    const { client, session } = openClient(hostId, source, {
      kind: "user",
      id: USER_A,
    });
    await vi.waitFor(() => expect(mintCalls()).toBeGreaterThanOrEqual(1));
    const socket = await socketAt(1);
    const open = await readOpen(socket);
    expect(open.token).toBe(expired.token);
    expect(hostDoorStateFor(hostId)).toBeNull();
    expect(heard).toEqual([]);
    socket.fireMessage(openAckFrame([], null));
    await settle();
    expect(hostDoorStateFor(hostId)).toBeNull();
    session.close();
    client.close("test complete");
    clearHostDoorState(hostId);
  });

  it("presents the held expired token again after a drop", async () => {
    const hostId = "local-held-expired-reconnect";
    clearHostDoorState(hostId);
    const expired = expiredJwt(Date.now());
    const unavailable: HostTokenMintOutcome = {
      kind: "unavailable",
      detail: "authn offline",
    };
    const { source, mintCalls } = await tokensFor(
      hostId,
      [unavailable, unavailable, unavailable, unavailable],
      expired,
    );
    const { client, session } = openClient(hostId, source, {
      kind: "user",
      id: USER_A,
    });
    await vi.waitFor(() => expect(mintCalls()).toBeGreaterThanOrEqual(1));
    const first = await socketAt(1);
    const opened = await readOpen(first);
    expect(opened.token).toBe(expired.token);
    first.fireMessage(openAckFrame([], null));
    await settle();
    first.fireClose(1006, "dropped");
    const second = await socketAt(2);
    const again = await readOpen(second);
    expect(again.token).toBe(expired.token);
    second.fireMessage(openAckFrame([], null));
    await settle();
    expect(hostDoorStateFor(hostId)).toBeNull();
    session.close();
    client.close("test complete");
    clearHostDoorState(hostId);
  });

  it.each([
    {
      name: "not-a-member",
      outcome: { kind: "not-a-member" } as const,
      door: "not-a-member" as const,
    },
    {
      name: "not-admitted",
      outcome: { kind: "not-admitted" } as const,
      door: "not-admitted" as const,
    },
    {
      name: "sign-in-rejected",
      outcome: { kind: "sign-in-rejected" } as const,
      door: null,
    },
  ])(
    "never presents the held expired token when the mint is $name",
    async ({ outcome, door }) => {
      const hostId = `local-refused-${outcome.kind}`;
      clearHostDoorState(hostId);
      const expired = expiredJwt(Date.now());
      const { source, mintCalls } = await tokensFor(
        hostId,
        [outcome, outcome, outcome, outcome],
        expired,
      );
      const { client, session } = openClient(hostId, source, {
        kind: "user",
        id: USER_A,
      });
      await vi.waitFor(() => expect(mintCalls()).toBeGreaterThanOrEqual(1));
      await vi.advanceTimersByTimeAsync(DEFAULT_INITIAL_BACKOFF_MS * 3);
      expect(sentTokens()).not.toContain(expired.token);
      expect(hostDoorStateFor(hostId)?.kind ?? null).toBe(door);
      session.close();
      client.close("test complete");
      clearHostDoorState(hostId);
    },
  );

  it("carries the fresh token on the next dial after the mint succeeds", async () => {
    const hostId = "local-fresh-after-outage";
    clearHostDoorState(hostId);
    const expired = expiredJwt(Date.now());
    const fresh = "fresh-after-outage";
    let admitFresh = false;
    let mintCalls = 0;
    const source = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: () => {
        mintCalls += 1;
        if (!admitFresh) {
          return Promise.resolve({
            kind: "unavailable",
            detail: "authn offline",
          });
        }
        return Promise.resolve({
          kind: "ok",
          token: { token: fresh, expiresAtMs: Date.now() + 60_000 },
        });
      },
      signIn: (userId) => (userId === USER_A ? SIGN_IN_TOKEN : null),
      now: () => Date.now(),
    });
    await source.adopt(USER_A, hostId, expired, source.era(USER_A));
    const { client, session } = openClient(hostId, source, {
      kind: "user",
      id: USER_A,
    });
    await vi.waitFor(() => expect(mintCalls).toBeGreaterThanOrEqual(1));
    const first = await socketAt(1);
    const opened = await readOpen(first);
    expect(opened.token).toBe(expired.token);
    first.fireMessage(openAckFrame([], null));
    await settle();
    admitFresh = true;
    first.fireClose(1006, "dropped");
    const second = await socketAt(2);
    await vi.waitFor(() =>
      expect(source.current(USER_A, hostId)?.token).toBe(fresh),
    );
    const again = await readOpen(second);
    expect(again.token).toBe(fresh);
    expect(hostDoorStateFor(hostId)).toBeNull();
    session.close();
    client.close("test complete");
    clearHostDoorState(hostId);
  });

  it("opens a released host with the sign-in after the held token is refused", async () => {
    const hostId = "local-released-held";
    clearHostDoorState(hostId);
    const expired = expiredJwt(Date.now());
    const unavailable: HostTokenMintOutcome = {
      kind: "unavailable",
      detail: "authn offline",
    };
    const { source, mintCalls } = await tokensFor(
      hostId,
      [unavailable, unavailable, unavailable],
      expired,
    );
    const { client, session } = openClient(hostId, source, {
      kind: "user",
      id: USER_A,
    });
    await vi.waitFor(() => expect(mintCalls()).toBeGreaterThanOrEqual(1));
    const first = await socketAt(1);
    const refused = await readOpen(first);
    expect(refused.token).toBe(expired.token);
    first.fireMessage(releasedRefusal());
    const second = await socketOnThisTurn(2);
    const open = await readOpen(second);
    expect(open.token).toBe(SIGN_IN_TOKEN);
    second.fireMessage(openAckFrame([], null));
    await settle();
    expect(hostDoorStateFor(hostId)?.kind ?? null).not.toBe("token-expired");
    expect(hostDoorStateFor(hostId)?.kind ?? null).not.toBe(
      "token-unavailable",
    );
    session.close();
    client.close("test complete");
    clearHostDoorState(hostId);
  });

  it("keeps token-expired through an invited sign-in refresh failure until a token is obtained", async () => {
    const hostId = "local-owner-sign-in-token-expired";
    clearHostDoorState(hostId);
    let allowFresh = false;
    let mintCalls = 0;
    async function nextOpenWithToken(
      afterSocketIndex: number,
      expectedToken: string,
    ): Promise<{
      readonly socket: FakeNativeWebSocket;
      readonly index: number;
    }> {
      let index = afterSocketIndex + 1;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
          await vi.waitFor(
            () =>
              expect(FakeNativeWebSocket.instances.length).toBeGreaterThan(
                index,
              ),
            { timeout: 2_000, interval: 10 },
          );
        } catch {
          const sequence = FakeNativeWebSocket.instances
            .map((candidate, candidateIndex) => {
              const tokens = sentFramesOfKind(candidate, "open").map(
                (frame) => frame.token,
              );
              const closed =
                candidate.closed === null
                  ? "open"
                  : JSON.stringify(candidate.closed);
              return `${candidateIndex}:${tokens.join(",") || "no open"}:${closed}`;
            })
            .join(" | ");
          throw new Error(
            `expected ${expectedToken}; observed sockets ${sequence}`,
          );
        }
        const candidate = FakeNativeWebSocket.instances.at(index);
        if (candidate === undefined) throw new Error("dial missing");
        const candidateIndex = index;
        index += 1;
        candidate.fireOpen();
        const open = await vi.waitFor(() => {
          const frame = sentFramesOfKind(candidate, "open").at(0);
          if (frame !== undefined) return frame;
          if (candidate.closed !== null) return null;
          throw new Error("dial has neither opened nor closed");
        });
        if (open === null) {
          await vi.advanceTimersToNextTimerAsync();
          continue;
        }
        if (open.token === expectedToken)
          return { socket: candidate, index: candidateIndex };
        await vi.advanceTimersToNextTimerAsync();
      }
      throw new Error(`expected ${expectedToken}`);
    }
    const source = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: () => {
        mintCalls += 1;
        if (!allowFresh) {
          return Promise.resolve({
            kind: "unavailable",
            detail: "authn offline",
          });
        }
        return Promise.resolve({
          kind: "ok",
          token: {
            token: HOST_ONLY_AFTER_MINT,
            expiresAtMs: Date.now() + 60_000,
          },
        });
      },
      signIn: (userId) => (userId === USER_A ? SIGN_IN_TOKEN : null),
      now: () => Date.now(),
    });
    const expired = expiredJwt(Date.now());
    await source.adopt(USER_A, hostId, expired, source.era(USER_A));
    let refreshCalls = 0;
    streamAuth = {
      revalidateForReconnect: () => {
        refreshCalls += 1;
        return Promise.resolve("network-error");
      },
    };
    const { client, session } = openClient(hostId, source, {
      kind: "user",
      id: USER_A,
    });
    await vi.waitFor(() => expect(mintCalls).toBeGreaterThanOrEqual(1));
    const held = await socketAt(1);
    held.fireOpen();
    await vi.waitFor(() =>
      expect(sentFramesOfKind(held, "open")).toHaveLength(1),
    );
    expect(sentFramesOfKind(held, "open")[0].token).toBe(expired.token);
    held.fireMessage(namedRefusal("token_expired"));
    await vi.waitFor(() =>
      expect(hostDoorStateFor(hostId)?.kind).toBe("token-expired"),
    );
    await vi.advanceTimersToNextTimerAsync();
    const probe = await socketAt(2);
    probe.fireOpen();
    await vi.waitFor(() =>
      expect(sentFramesOfKind(probe, "open")).toHaveLength(1),
    );
    expect(sentFramesOfKind(probe, "open")[0].token).toBe(NO_HOST_TOKEN_PROBE);
    expect(hostDoorStateFor(hostId)?.kind).toBe("token-expired");
    probe.fireMessage(namedRefusal("owner_sign_in"));
    const invitedDial = await nextOpenWithToken(1, SIGN_IN_TOKEN);
    const invited = invitedDial.socket;
    invited.fireMessage(namedRefusal("token_expired"));
    await vi.waitFor(() => expect(refreshCalls).toBe(1));
    await vi.waitFor(() => expect(heard).toHaveLength(2));
    expect(heard.map((details) => details.doorReason)).toEqual([
      "token_expired",
      "token_expired",
    ]);
    expect(hostDoorStateFor(hostId)?.kind).toBe("token-expired");
    allowFresh = true;
    await vi.advanceTimersToNextTimerAsync();
    const secondProbeDial = await nextOpenWithToken(
      invitedDial.index,
      NO_HOST_TOKEN_PROBE,
    );
    await vi.waitFor(() =>
      expect(source.current(USER_A, hostId)?.token).toBe(HOST_ONLY_AFTER_MINT),
    );
    secondProbeDial.socket.fireMessage(namedRefusal("owner_sign_in"));
    await vi.advanceTimersToNextTimerAsync();
    const admittedDial = await nextOpenWithToken(
      secondProbeDial.index,
      HOST_ONLY_AFTER_MINT,
    );
    expect(sentTokens()).toEqual([
      expired.token,
      NO_HOST_TOKEN_PROBE,
      SIGN_IN_TOKEN,
      NO_HOST_TOKEN_PROBE,
      HOST_ONLY_AFTER_MINT,
    ]);
    admittedDial.socket.fireMessage(openAckFrame([], null));
    await settle();
    expect(hostDoorStateFor(hostId)).toBeNull();
    session.close();
    client.close("test complete");
    clearHostDoorState(hostId);
  });

  it("opens with the placeholder, then the sign-in, when none is held", async () => {
    const hostId = "local-no-token";
    clearHostDoorState(hostId);
    const { source, mintCalls } = await tokensFor(
      hostId,
      [
        { kind: "unavailable", detail: "authn offline" },
        { kind: "unavailable", detail: "authn still offline" },
      ],
      null,
    );
    const { client, session } = openClient(hostId, source, {
      kind: "user",
      id: USER_A,
    });
    await vi.waitFor(() => expect(mintCalls()).toBeGreaterThanOrEqual(1));
    const probe = await socketAt(1);
    const probed = await readOpen(probe);
    expect(probed.token).toBe(NO_HOST_TOKEN_PROBE);
    probe.fireMessage(releasedRefusal());
    const second = await socketOnThisTurn(2);
    const open = await readOpen(second);
    expect(open.token).toBe(SIGN_IN_TOKEN);
    expect(sentTokens()).toEqual([NO_HOST_TOKEN_PROBE, SIGN_IN_TOKEN]);
    expect(heard).toEqual([]);
    session.close();
    client.close("test complete");
    clearHostDoorState(hostId);
  });

  it("sends the sign-in after its current personal host invites it", async () => {
    const hostId = "local-owner-sign-in-invitation";
    clearHostDoorState(hostId);
    const { source, mintCalls } = await tokensFor(
      hostId,
      [
        { kind: "unavailable", detail: "authn offline" },
        { kind: "unavailable", detail: "authn still offline" },
      ],
      null,
    );
    const { client, session } = openClient(hostId, source, {
      kind: "user",
      id: USER_A,
    });
    await vi.waitFor(() => expect(mintCalls()).toBe(1));
    const probe = await socketAt(1);
    const probed = await readOpen(probe);
    expect(probed.token).toBe(NO_HOST_TOKEN_PROBE);
    probe.fireMessage(namedRefusal("owner_sign_in"));
    const invited = await socketOnThisTurn(2);
    const open = await readOpen(invited);
    expect(open.token).toBe(SIGN_IN_TOKEN);
    expect(sentTokens()).toEqual([NO_HOST_TOKEN_PROBE, SIGN_IN_TOKEN]);
    invited.fireMessage(openAckFrame([], null));
    await settle();
    expect(processReleasedHosts.opensReleasedWay(USER_A, hostId)).toBe(false);
    expect(hostDoorStateFor(hostId)).toBeNull();
    session.close();
    client.close("test complete");
    clearHostDoorState(hostId);
  });

  it("probes again after not_provisioned, then sends sign-in when invited", async () => {
    const hostId = "local-not-provisioned-then-enrolled";
    clearHostDoorState(hostId);
    const unavailable: HostTokenMintOutcome = {
      kind: "unavailable",
      detail: "authn offline",
    };
    const { source, mintCalls } = await tokensFor(
      hostId,
      [unavailable, unavailable, unavailable],
      null,
    );
    const { client, session } = openClient(hostId, source, {
      kind: "user",
      id: USER_A,
    });
    await vi.waitFor(() => expect(mintCalls()).toBeGreaterThanOrEqual(1));
    const firstProbe = await socketAt(1);
    expect((await readOpen(firstProbe)).token).toBe(NO_HOST_TOKEN_PROBE);
    firstProbe.fireMessage(namedRefusal("not_provisioned"));

    const enrolledProbe = await socketAt(2);
    expect((await readOpen(enrolledProbe)).token).toBe(NO_HOST_TOKEN_PROBE);
    enrolledProbe.fireMessage(namedRefusal("owner_sign_in"));
    const invited = await socketOnThisTurn(3);
    expect((await readOpen(invited)).token).toBe(SIGN_IN_TOKEN);
    invited.fireMessage(openAckFrame([], null));
    await settle();

    expect(sentTokens()).toEqual([
      NO_HOST_TOKEN_PROBE,
      NO_HOST_TOKEN_PROBE,
      SIGN_IN_TOKEN,
    ]);
    expect(heard).toEqual([]);
    expect(hostDoorStateFor(hostId)).toBeNull();
    session.close();
    client.close("test complete");
    clearHostDoorState(hostId);
  });

  it("probes again after a host-token admission clears a declined probe", async () => {
    const hostId = "local-admitted-token-clears-probe-decline";
    clearHostDoorState(hostId);
    const { source, mintCalls } = await tokensFor(
      hostId,
      [
        { kind: "unavailable", detail: "authn offline" },
        {
          kind: "ok",
          token: {
            token: "admitted-after-probe-decline",
            expiresAtMs: Date.now() + 60_000,
          },
        },
      ],
      null,
    );
    const { client, session } = openClient(hostId, source, {
      kind: "user",
      id: USER_A,
    });
    await vi.waitFor(() => expect(mintCalls()).toBeGreaterThanOrEqual(1));

    const probe = await socketAt(1);
    expect((await readOpen(probe)).token).toBe(NO_HOST_TOKEN_PROBE);
    probe.fireMessage(namedRefusal("not_admitted"));
    expect(heard).toEqual([]);

    await vi.advanceTimersToNextTimerAsync();
    const admitted = await socketCounted(2);
    expect((await readOpen(admitted)).token).toBe(
      "admitted-after-probe-decline",
    );
    admitted.fireMessage(openAckFrame([], null));
    await settle();
    expect(hostDoorStateFor(hostId)).toBeNull();

    session.close();
    client.close("test complete");

    const later = await tokensFor(
      hostId,
      [{ kind: "unavailable", detail: "authn still offline" }],
      null,
    );
    const next = openClient(hostId, later.source, {
      kind: "user",
      id: USER_A,
    });
    await vi.waitFor(() => expect(later.mintCalls()).toBeGreaterThanOrEqual(1));
    const laterProbe = await socketCounted(3);
    expect((await readOpen(laterProbe)).token).toBe(NO_HOST_TOKEN_PROBE);
    expect(sentTokens()).toEqual([
      NO_HOST_TOKEN_PROBE,
      "admitted-after-probe-decline",
      NO_HOST_TOKEN_PROBE,
    ]);
    expect(heard).toEqual([]);
    next.session.close();
    next.client.close("test complete");
    clearHostDoorState(hostId);
  });

  it("keeps a token minted before an earlier expiry refusal presentable", async () => {
    const hostId = "local-refusal-races-token-mint";
    clearHostDoorState(hostId);
    const expired = expiredJwt(Date.now());
    const freshToken = "minted-before-refusal-handled";
    let freshExpiresAtMs = 0;
    let mintCalls = 0;
    const racingMint: {
      resolve: ((outcome: HostTokenMintOutcome) => void) | undefined;
    } = { resolve: undefined };
    let markRacingMintStarted: () => void = () => undefined;
    const racingMintStarted = new Promise<void>((resolve) => {
      markRacingMintStarted = resolve;
    });
    const source = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: () => {
        mintCalls += 1;
        if (mintCalls === 1)
          return Promise.resolve({
            kind: "unavailable",
            detail: "authn offline",
          });
        if (mintCalls === 2) {
          markRacingMintStarted();
          return new Promise<HostTokenMintOutcome>((resolve) => {
            racingMint.resolve = resolve;
          });
        }
        return Promise.resolve({
          kind: "unavailable",
          detail: "authn still offline",
        });
      },
      signIn: (userId) => (userId === USER_A ? SIGN_IN_TOKEN : null),
      now: () => Date.now(),
    });
    await source.adopt(USER_A, hostId, expired, source.era(USER_A));
    const { client, session } = openClient(hostId, source, {
      kind: "user",
      id: USER_A,
    });
    await vi.waitFor(() => expect(mintCalls).toBeGreaterThanOrEqual(1));
    const first = await socketAt(1);
    await racingMintStarted;
    expect((await readOpen(first)).token).toBe(expired.token);

    if (racingMint.resolve === undefined)
      throw new Error("racing token mint did not start");
    racingMint.resolve({
      kind: "ok",
      token: {
        token: freshToken,
        expiresAtMs: (freshExpiresAtMs = Date.now() + 60_000),
      },
    });
    await vi.waitFor(() =>
      expect(source.current(USER_A, hostId)?.token).toBe(freshToken),
    );
    first.fireMessage(namedRefusal("token_expired"));

    const recovered = await socketAt(2);
    expect((await readOpen(recovered)).token).toBe(freshToken);
    recovered.fireMessage(openAckFrame([], null));
    await settle();

    vi.setSystemTime(Math.max(Date.now(), freshExpiresAtMs) + 1);
    recovered.fireClose(1006, "dropped after token expiry");
    await vi.waitFor(() => expect(mintCalls).toBeGreaterThanOrEqual(3));
    const afterOutage = await socketAt(3);
    expect((await readOpen(afterOutage)).token).toBe(freshToken);
    afterOutage.fireMessage(openAckFrame([], null));
    await settle();
    expect(sentTokens()).toEqual([expired.token, freshToken, freshToken]);
    expect(sentTokens()).not.toContain(SIGN_IN_TOKEN);
    expect(hostDoorStateFor(hostId)).toBeNull();
    session.close();
    client.close("test complete");
    clearHostDoorState(hostId);
  });

  it("does not send sign-in when a team host refuses a host token by name", async () => {
    const hostId = "local-other-host-token-not-admitted";
    clearHostDoorState(hostId);
    const otherHostToken = expiredJwt(Date.now());
    const { source } = await tokensFor(
      hostId,
      [
        { kind: "unavailable", detail: "authn offline" },
        { kind: "unavailable", detail: "authn still offline" },
      ],
      otherHostToken,
    );
    const { client, session } = openClient(hostId, source, {
      kind: "team",
      id: "team-a",
      name: "Alpha",
    });
    const socket = await socketAt(1);
    await settle();
    expect((await readOpen(socket)).token).toBe(otherHostToken.token);
    socket.fireMessage(namedRefusal("not_admitted"));
    await vi.waitFor(() => expect(heard).toHaveLength(1));
    expect(sentTokens()).toEqual([otherHostToken.token]);
    expect(sentTokens()).not.toContain(SIGN_IN_TOKEN);
    expect(heard.map((details) => details.doorReason)).toEqual([
      "not_admitted",
    ]);
    session.close();
    client.close("test complete");
    clearHostDoorState(hostId);
  });

  it("probes again after a retryable answer, then admits with the sign-in", async () => {
    const hostId = "local-probe-retryable";
    clearHostDoorState(hostId);
    const { source, mintCalls } = await tokensFor(
      hostId,
      [
        { kind: "unavailable", detail: "authn offline" },
        { kind: "unavailable", detail: "authn still offline" },
        { kind: "unavailable", detail: "authn still offline" },
        { kind: "unavailable", detail: "authn still offline" },
      ],
      null,
    );
    const { client, session } = openClient(hostId, source, {
      kind: "user",
      id: USER_A,
    });
    await vi.waitFor(() => expect(mintCalls()).toBeGreaterThanOrEqual(1));
    const probe = await socketAt(1);
    const probed = await readOpen(probe);
    expect(probed.token).toBe(NO_HOST_TOKEN_PROBE);
    probe.fireMessage(retryableProbeFatal());
    // The first miss arms one backoff before the probe, so this reconnect
    // waits the next step. Stay under the dial timeout.
    await vi.advanceTimersByTimeAsync(DEFAULT_INITIAL_BACKOFF_MS * 4);
    const again = await socketOnThisTurn(2);
    const retried = await readOpen(again);
    expect(retried.token).toBe(NO_HOST_TOKEN_PROBE);
    again.fireMessage(releasedRefusal());
    const admitted = await socketOnThisTurn(3);
    const open = await readOpen(admitted);
    expect(open.token).toBe(SIGN_IN_TOKEN);
    admitted.fireMessage(openAckFrame([], null));
    await settle();
    expect(sentTokens()).toEqual([
      NO_HOST_TOKEN_PROBE,
      NO_HOST_TOKEN_PROBE,
      SIGN_IN_TOKEN,
    ]);
    expect(heard).toEqual([]);
    session.close();
    client.close("test complete");
    clearHostDoorState(hostId);
  });

  it("opens with the placeholder, then the sign-in, when the mint says this computer has no row", async () => {
    const hostId = "local-not-admitted";
    clearHostDoorState(hostId);
    const { source, mintCalls } = await tokensFor(
      hostId,
      [
        { kind: "not-admitted" },
        { kind: "not-admitted" },
        { kind: "not-admitted" },
      ],
      null,
    );
    const { client, session } = openClient(hostId, source, {
      kind: "user",
      id: USER_A,
    });
    await vi.waitFor(() => expect(mintCalls()).toBeGreaterThanOrEqual(1));
    const probe = await socketAt(1);
    const probed = await readOpen(probe);
    expect(probed.token).toBe(NO_HOST_TOKEN_PROBE);
    probe.fireMessage(releasedRefusal());
    const second = await socketOnThisTurn(2);
    const open = await readOpen(second);
    expect(open.token).toBe(SIGN_IN_TOKEN);
    session.close();
    client.close("test complete");
    clearHostDoorState(hostId);
  });

  it.each([
    {
      name: "a team row",
      owner: { kind: "team" as const, id: "team-a", name: "Alpha" },
    },
    {
      name: "another person's row",
      owner: { kind: "user" as const, id: "someone-else" },
    },
  ])("never sends the sign-in for $name", async ({ owner }) => {
    const hostId = `local-refused-row-${owner.kind}-${owner.id}`;
    clearHostDoorState(hostId);
    const { source, mintCalls } = await tokensFor(
      hostId,
      [
        { kind: "not-admitted" },
        { kind: "not-admitted" },
        { kind: "not-admitted" },
      ],
      null,
    );
    const { client, session } = openClient(hostId, source, owner);
    await vi.waitFor(() => expect(mintCalls()).toBeGreaterThanOrEqual(1));
    await vi.advanceTimersByTimeAsync(DEFAULT_INITIAL_BACKOFF_MS * 3);
    expect(sentTokens()).not.toContain(SIGN_IN_TOKEN);
    session.close();
    client.close("test complete");
    clearHostDoorState(hostId);
  });

  it("sends only the placeholder to a current team host on this machine when the app is offline and no token is held", async () => {
    const hostId = "local-team-host-offline";
    clearHostDoorState(hostId);
    const { source, mintCalls } = await tokensFor(
      hostId,
      [
        { kind: "unavailable", detail: "authn offline" },
        { kind: "unavailable", detail: "authn still offline" },
        { kind: "unavailable", detail: "authn still offline" },
      ],
      null,
    );
    const { client, session } = openClient(hostId, source, {
      kind: "user",
      id: USER_A,
    });
    await vi.waitFor(() => expect(mintCalls()).toBeGreaterThanOrEqual(1));
    const socket = await socketAt(1);
    const open = await readOpen(socket);
    expect(open.token).toBe(NO_HOST_TOKEN_PROBE);
    socket.fireMessage(namedRefusal("not_admitted"));
    await vi.advanceTimersByTimeAsync(DEFAULT_INITIAL_BACKOFF_MS * 4);
    expect(sentTokens()).toEqual([NO_HOST_TOKEN_PROBE]);
    expect(heard).toEqual([]);
    session.close();
    client.close("test complete");
    clearHostDoorState(hostId);
  });

  it("admits a held expired token on a team host without probing", async () => {
    const hostId = "local-team-held-expired-admitted";
    clearHostDoorState(hostId);
    const expired = expiredJwt(Date.now());
    const { source, mintCalls } = await tokensFor(
      hostId,
      [
        { kind: "unavailable", detail: "authn offline" },
        { kind: "unavailable", detail: "authn still offline" },
      ],
      expired,
    );
    const { client, session } = openClient(hostId, source, {
      kind: "team",
      id: "team-a",
      name: "Alpha",
    });
    await vi.waitFor(() => expect(mintCalls()).toBeGreaterThanOrEqual(1));
    const socket = await socketAt(1);
    expect((await readOpen(socket)).token).toBe(expired.token);
    socket.fireMessage(openAckFrame([], null));
    await settle();
    expect(sentTokens()).toEqual([expired.token]);
    expect(hostDoorStateFor(hostId)).toBeNull();
    expect(heard).toEqual([]);
    session.close();
    client.close("test complete");
    clearHostDoorState(hostId);
  });

  it("re-presents a refused held token on a team stream until the host admits it", async () => {
    const hostId = "local-team-held-expired-reconnect";
    clearHostDoorState(hostId);
    const expired = expiredJwt(Date.now());
    const unavailable: HostTokenMintOutcome = {
      kind: "unavailable",
      detail: "authn offline",
    };
    const { source, mintCalls } = await tokensFor(
      hostId,
      [unavailable, unavailable, unavailable, unavailable],
      expired,
    );
    const { client, session } = openClient(hostId, source, {
      kind: "team",
      id: "team-a",
      name: "Alpha",
    });
    await vi.waitFor(() => expect(mintCalls()).toBeGreaterThanOrEqual(1));
    const first = await socketAt(1);
    expect((await readOpen(first)).token).toBe(expired.token);
    first.fireMessage(namedRefusal("token_expired"));
    await vi.waitFor(() =>
      expect(hostDoorStateFor(hostId)?.kind).toBe("token-expired"),
    );
    await vi.advanceTimersToNextTimerAsync();
    const second = await socketAt(2);
    expect((await readOpen(second)).token).toBe(expired.token);
    second.fireMessage(namedRefusal("token_expired"));
    await vi.advanceTimersToNextTimerAsync();
    const third = await socketAt(3);
    expect((await readOpen(third)).token).toBe(expired.token);
    third.fireMessage(openAckFrame([], null));
    await settle();
    expect(sentTokens()).toEqual([expired.token, expired.token, expired.token]);
    expect(heard.map((details) => details.doorReason)).toEqual([
      "token_expired",
      "token_expired",
    ]);
    expect(hostDoorStateFor(hostId)).toBeNull();
    session.close();
    client.close("test complete");
    clearHostDoorState(hostId);
  });

  it("opens with the held expired token when the session is unverified", async () => {
    const hostId = "local-unverified-held";
    clearHostDoorState(hostId);
    const expired = expiredJwt(Date.now());
    const { source, signInReads, mintCalls } = await unverifiedTokens(
      hostId,
      expired,
    );
    const { client, session } = openClient(hostId, source, {
      kind: "user",
      id: USER_A,
    });
    await vi.waitFor(() => expect(signInReads()).toBeGreaterThanOrEqual(1));
    const socket = await socketAt(1);
    const open = await readOpen(socket);
    expect(open.token).toBe(expired.token);
    expect(mintCalls()).toBe(0);
    expect(hostDoorStateFor(hostId)).toBeNull();
    expect(heard).toEqual([]);
    socket.fireMessage(openAckFrame([], null));
    await settle();
    expect(sentTokens()).toEqual([expired.token]);
    expect(hostDoorStateFor(hostId)).toBeNull();
    session.close();
    client.close("test complete");
    clearHostDoorState(hostId);
  });

  it("opens with the placeholder, then the sign-in, when the session is unverified and none is held", async () => {
    const hostId = "local-unverified-none";
    clearHostDoorState(hostId);
    const { source, signInReads, mintCalls } = await unverifiedTokens(
      hostId,
      null,
    );
    const { client, session } = openClient(hostId, source, {
      kind: "user",
      id: USER_A,
    });
    await vi.waitFor(() => expect(signInReads()).toBeGreaterThanOrEqual(1));
    const probe = await socketAt(1);
    const probed = await readOpen(probe);
    expect(probed.token).toBe(NO_HOST_TOKEN_PROBE);
    probe.fireMessage(releasedRefusal());
    const second = await socketOnThisTurn(2);
    const open = await readOpen(second);
    expect(open.token).toBe(SIGN_IN_TOKEN);
    expect(mintCalls()).toBe(0);
    expect(sentTokens()).toEqual([NO_HOST_TOKEN_PROBE, SIGN_IN_TOKEN]);
    expect(heard).toEqual([]);
    session.close();
    client.close("test complete");
    clearHostDoorState(hostId);
  });

  it("opens a released host with the sign-in after the unverified session's held token is refused", async () => {
    const hostId = "local-unverified-released-held";
    clearHostDoorState(hostId);
    const expired = expiredJwt(Date.now());
    const { source, signInReads, mintCalls } = await unverifiedTokens(
      hostId,
      expired,
    );
    const { client, session } = openClient(hostId, source, {
      kind: "user",
      id: USER_A,
    });
    await vi.waitFor(() => expect(signInReads()).toBeGreaterThanOrEqual(1));
    const first = await socketAt(1);
    const refused = await readOpen(first);
    expect(refused.token).toBe(expired.token);
    first.fireMessage(releasedRefusal());
    const second = await socketOnThisTurn(2);
    const open = await readOpen(second);
    expect(open.token).toBe(SIGN_IN_TOKEN);
    expect(mintCalls()).toBe(0);
    second.fireMessage(openAckFrame([], null));
    await settle();
    expect(sentTokens()).toEqual([expired.token, SIGN_IN_TOKEN]);
    expect(heard).toEqual([]);
    expect(hostDoorStateFor(hostId)?.kind ?? null).not.toBe("token-expired");
    expect(hostDoorStateFor(hostId)?.kind ?? null).not.toBe(
      "token-unavailable",
    );
    session.close();
    client.close("test complete");
    clearHostDoorState(hostId);
  });

  it("sends only the placeholder when a current host names the refusal and the session is unverified", async () => {
    const hostId = "local-unverified-team-host";
    clearHostDoorState(hostId);
    const { source, signInReads, mintCalls } = await unverifiedTokens(
      hostId,
      null,
    );
    const { client, session } = openClient(hostId, source, {
      kind: "user",
      id: USER_A,
    });
    await vi.waitFor(() => expect(signInReads()).toBeGreaterThanOrEqual(1));
    const socket = await socketAt(1);
    const open = await readOpen(socket);
    expect(open.token).toBe(NO_HOST_TOKEN_PROBE);
    socket.fireMessage(namedRefusal("not_admitted"));
    await vi.advanceTimersByTimeAsync(DEFAULT_INITIAL_BACKOFF_MS * 4);
    expect(mintCalls()).toBe(0);
    expect(sentTokens()).toEqual([NO_HOST_TOKEN_PROBE]);
    expect(heard).toEqual([]);
    session.close();
    client.close("test complete");
    clearHostDoorState(hostId);
  });
});
