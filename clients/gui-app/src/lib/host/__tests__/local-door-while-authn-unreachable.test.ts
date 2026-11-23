import {
  NO_HOST_TOKEN_PROBE,
  type HostDoorReason,
} from "@traycer/protocol/framework/door-reason";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import type { StreamCloseReason } from "@traycer/protocol/host-transport/stream-session";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import type { StreamAuthRevalidator } from "@traycer-clients/shared/auth/bearer-revalidator";
import {
  createHostTokenSource,
  createMemoryHostTokenPersistence,
  type HostTokenMintOutcome,
  type HostTokenPersistence,
  type HostTokenSource,
} from "@traycer-clients/shared/auth/host-token-source";
import { processReleasedHosts } from "@traycer-clients/shared/host-transport/released-sign-on";
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

vi.mock("@/lib/host/host-door-observer", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/host/host-door-observer")>();
  return {
    ...actual,
    appStreamDoorObserver: {
      ...actual.appStreamDoorObserver,
      refused: (
        ...args: Parameters<typeof actual.appStreamDoorObserver.refused>
      ) => {
        heard.push(args[0]);
        actual.appStreamDoorObserver.refused(...args);
      },
    },
    appHostDoorObserver: (hostId: string) => {
      const door = actual.appHostDoorObserver(hostId);
      return {
        ...door,
        refused: (...args: Parameters<typeof door.refused>) => {
          heard.push(args[0]);
          door.refused(...args);
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

/** What a released host says when its own check refuses a credential. */
const RELEASED_HOST_REASONS = [
  "Authenticated user does not own this host",
  "Host is not provisioned - run `traycer login` on the host machine to authorize it",
  "Token has been revoked",
] as const;

function releasedRefusal(): string {
  return releasedRefusalSaying("released-host-token-refusal");
}

function releasedRefusalSaying(reason: string): string {
  return JSON.stringify({
    kind: "fatalError",
    details: {
      code: "UNAUTHORIZED",
      reason,
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

function namedRefusal(doorReason: HostDoorReason): string {
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

function retryableNamedRefusal(doorReason: HostDoorReason): string {
  return JSON.stringify({
    kind: "fatalError",
    details: {
      code: "UNAUTHORIZED",
      reason: "current-host-refusal",
      doorReason,
      retryable: true,
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  });
}

/** Authn never answers: every mint for the pair stays pending. */
async function blackHoledTokens(): Promise<{
  readonly source: HostTokenSource;
  readonly mintCalls: () => number;
}> {
  let mintCalls = 0;
  const source = createHostTokenSource({
    persistence: createMemoryHostTokenPersistence(),
    mint: () => {
      mintCalls += 1;
      return new Promise<HostTokenMintOutcome>(() => undefined);
    },
    signIn: (userId) => (userId === USER_A ? SIGN_IN_TOKEN : null),
    now: () => Date.now(),
  });
  await settle();
  return { source, mintCalls: () => mintCalls };
}

/** A mint authn answers only when the test says so; the answers are kept. */
interface HeldMints {
  readonly mint: () => Promise<HostTokenMintOutcome>;
  readonly answerAll: (outcome: HostTokenMintOutcome) => void;
  readonly asked: () => number;
}

function heldMints(): HeldMints {
  const pending: Array<(outcome: HostTokenMintOutcome) => void> = [];
  return {
    mint: () =>
      new Promise<HostTokenMintOutcome>((resolve) => {
        pending.push(resolve);
      }),
    answerAll: (outcome) => {
      for (const resolve of pending) resolve(outcome);
    },
    asked: () => pending.length,
  };
}

function sourceWithMint(
  mint: () => Promise<HostTokenMintOutcome>,
): HostTokenSource {
  return createHostTokenSource({
    persistence: createMemoryHostTokenPersistence(),
    mint,
    signIn: (userId) => (userId === USER_A ? SIGN_IN_TOKEN : null),
    now: () => Date.now(),
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
    await source.adopt(USER_A, hostId, held, source.era(USER_A), () => true);
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
    await source.adopt(USER_A, hostId, held, source.era(USER_A), () => true);
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
    await source.adopt(USER_A, hostId, expired, source.era(USER_A), () => true);
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

  it.each(
    RELEASED_HOST_REASONS.flatMap((reason) =>
      (["absent", "rejected", "local-plane-retained"] as const).map(
        (recovery) => ({ reason, recovery }),
      ),
    ),
  )(
    "raises no state and closes with the host's reason $reason when the sign-in is refused bare and the recovery is $recovery",
    async ({ reason, recovery }) => {
      const hostId = `local-sign-in-refused-${recovery}-${RELEASED_HOST_REASONS.indexOf(reason)}`;
      clearHostDoorState(hostId);
      streamAuth =
        recovery === "absent"
          ? null
          : { revalidateForReconnect: () => Promise.resolve(recovery) };
      const held = expiredJwt(Date.now());
      const unavailable: HostTokenMintOutcome = {
        kind: "unavailable",
        detail: "authn offline",
      };
      const { source, mintCalls } = await tokensFor(
        hostId,
        [unavailable, unavailable, unavailable],
        held,
      );
      const { session } = openClient(hostId, source, {
        kind: "user",
        id: USER_A,
      });
      await vi.waitFor(() => expect(mintCalls()).toBeGreaterThanOrEqual(1));
      const closed: { reason: StreamCloseReason | null } = { reason: null };
      session.onStatusChange((status, closeReason) => {
        if (status === "closed") closed.reason = closeReason;
      });
      const first = await socketAt(1);
      expect((await readOpen(first)).token).toBe(held.token);
      first.fireMessage(releasedRefusal());
      const second = await socketOnThisTurn(2);
      expect((await readOpen(second)).token).toBe(SIGN_IN_TOKEN);
      second.fireMessage(releasedRefusalSaying(reason));
      // A retained local plane redials, bounded, before it gives up.
      const isClosed = (): boolean => closed.reason !== null;
      for (let dials = 3; !isClosed() && dials <= 8; dials += 1) {
        await settle();
        if (isClosed()) break;
        const next = await socketAt(dials);
        expect((await readOpen(next)).token).toBe(SIGN_IN_TOKEN);
        next.fireMessage(releasedRefusalSaying(reason));
      }
      await settle();
      expect(closed.reason).toMatchObject({
        kind: "fatalError",
        details: { reason },
      });
      expect(heard).toEqual([]);
      expect(hostDoorStateFor(hostId)).toBeNull();
    },
  );

  it("raises the older-host state when a team computer's held token is refused bare and no sign-in can follow", async () => {
    const hostId = "local-team-row-bare-refusal";
    clearHostDoorState(hostId);
    const held = expiredJwt(Date.now());
    const unavailable: HostTokenMintOutcome = {
      kind: "unavailable",
      detail: "authn offline",
    };
    const { source, mintCalls } = await tokensFor(
      hostId,
      [unavailable, unavailable],
      held,
    );
    const { session } = openClient(hostId, source, {
      kind: "team",
      id: "team-a",
      name: "Alpha",
    });
    await vi.waitFor(() => expect(mintCalls()).toBeGreaterThanOrEqual(1));
    const socket = await socketAt(1);
    expect((await readOpen(socket)).token).toBe(held.token);
    socket.fireMessage(releasedRefusal());
    await vi.waitFor(() =>
      expect(hostDoorStateFor(hostId)?.kind).toBe("older-host"),
    );
    expect(sentTokens()).toEqual([held.token]);
    session.close();
  });

  it("keeps token-expired through an invited sign-in refresh failure until a token is obtained", async () => {
    const hostId = "local-owner-sign-in-token-expired";
    clearHostDoorState(hostId);
    let allowFresh = false;
    let mintCalls = 0;
    // The dial at `index` must be the next one, carrying `expectedToken`.
    async function openAt(
      index: number,
      expectedToken: string,
    ): Promise<FakeNativeWebSocket> {
      await vi.waitFor(
        () =>
          expect(FakeNativeWebSocket.instances.length).toBeGreaterThan(index),
        { timeout: 2_000, interval: 10 },
      );
      const socket = FakeNativeWebSocket.instances[index];
      expect((await readOpen(socket)).token).toBe(expectedToken);
      return socket;
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
    await source.adopt(USER_A, hostId, expired, source.era(USER_A), () => true);
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
    const invited = await openAt(2, SIGN_IN_TOKEN);
    invited.fireMessage(namedRefusal("token_expired"));
    await vi.waitFor(() => expect(refreshCalls).toBe(1));
    // The invited sign-in's refresh answered network-error: that is quiet, so
    // only the host-only token's own refusal was reported.
    await vi.waitFor(() => expect(heard).toHaveLength(1));
    expect(heard.map((details) => details.doorReason)).toEqual([
      "token_expired",
    ]);
    expect(hostDoorStateFor(hostId)?.kind).toBe("token-expired");
    allowFresh = true;
    await vi.advanceTimersToNextTimerAsync();
    const secondProbe = await openAt(3, NO_HOST_TOKEN_PROBE);
    await vi.waitFor(() =>
      expect(source.current(USER_A, hostId)?.token).toBe(HOST_ONLY_AFTER_MINT),
    );
    secondProbe.fireMessage(namedRefusal("owner_sign_in"));
    await vi.advanceTimersToNextTimerAsync();
    const admittedDial = await openAt(4, HOST_ONLY_AFTER_MINT);
    expect(sentTokens()).toEqual([
      expired.token,
      NO_HOST_TOKEN_PROBE,
      SIGN_IN_TOKEN,
      NO_HOST_TOKEN_PROBE,
      HOST_ONLY_AFTER_MINT,
    ]);
    admittedDial.fireMessage(openAckFrame([], null));
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

  it("uses a host-only token on the next dial after invited sign-in admission", async () => {
    const hostId = "local-owner-sign-in-then-host-token";
    clearHostDoorState(hostId);
    const freshToken = "host-token-after-invited-sign-in";
    let allowFresh = false;
    const source = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: () =>
        Promise.resolve(
          allowFresh
            ? {
                kind: "ok",
                token: { token: freshToken, expiresAtMs: Date.now() + 60_000 },
              }
            : { kind: "unavailable", detail: "authn offline" },
        ),
      signIn: (userId) => (userId === USER_A ? SIGN_IN_TOKEN : null),
      now: () => Date.now(),
    });
    const { client, session } = openClient(hostId, source, {
      kind: "user",
      id: USER_A,
    });
    await vi.waitFor(() => expect(source.current(USER_A, hostId)).toBeNull());
    const probe = await socketAt(1);
    expect((await readOpen(probe)).token).toBe(NO_HOST_TOKEN_PROBE);
    probe.fireMessage(namedRefusal("owner_sign_in"));
    const invited = await socketOnThisTurn(2);
    expect((await readOpen(invited)).token).toBe(SIGN_IN_TOKEN);
    invited.fireMessage(openAckFrame([], null));
    await settle();

    allowFresh = true;
    const mint = await source.obtain(USER_A, hostId, true, {
      signal: null,
      owner: processReleasedHosts.currentInstance(hostId),
      observedNow: () => processReleasedHosts.currentInstance(hostId).observed,
    });
    expect(mint.kind).toBe("ok");
    expect(processReleasedHosts.opensReleasedWay(USER_A, hostId)).toBe(false);
    invited.fireClose(1006, "dropped after sign-in admission");
    await vi.advanceTimersToNextTimerAsync();
    const next = await socketAt(3);
    expect((await readOpen(next)).token).toBe(freshToken);
    next.fireMessage(openAckFrame([], null));
    await settle();

    expect(sentTokens()).toEqual([
      NO_HOST_TOKEN_PROBE,
      SIGN_IN_TOKEN,
      freshToken,
    ]);
    expect(processReleasedHosts.opensReleasedWay(USER_A, hostId)).toBe(false);
    session.close();
    client.close("test complete");
    clearHostDoorState(hostId);
  });

  it("does not send sign-in when owner_sign_in follows a not-admitted mint", async () => {
    const hostId = "local-owner-invite-after-not-admitted";
    clearHostDoorState(hostId);
    let mintCalls = 0;
    const source = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: () => {
        mintCalls += 1;
        return Promise.resolve({ kind: "not-admitted" });
      },
      signIn: (userId) => (userId === USER_A ? SIGN_IN_TOKEN : null),
      now: () => Date.now(),
    });
    const { client, session } = openClient(hostId, source, {
      kind: "user",
      id: USER_A,
    });
    await vi.waitFor(() => expect(mintCalls).toBeGreaterThan(0));
    const probe = await socketAt(1);
    expect((await readOpen(probe)).token).toBe(NO_HOST_TOKEN_PROBE);
    probe.fireMessage(namedRefusal("owner_sign_in"));
    await vi.advanceTimersByTimeAsync(DEFAULT_INITIAL_BACKOFF_MS * 4);
    expect(sentTokens()).not.toContain(SIGN_IN_TOKEN);
    session.close();
    client.close("test complete");
    clearHostDoorState(hostId);
  });

  it("uses an expired invited sign-in without waiting for pre-dial refresh", async () => {
    const hostId = "local-expired-invited-sign-in";
    clearHostDoorState(hostId);
    const expiredSignIn = expiredJwt(Date.now());
    presentedSignIn = expiredSignIn.token;
    let refreshCalls = 0;
    streamAuth = {
      revalidateForReconnect: () => {
        refreshCalls += 1;
        return Promise.resolve("network-error");
      },
    };
    const source = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: () => Promise.resolve({ kind: "unavailable", detail: "offline" }),
      signIn: (userId) => (userId === USER_A ? expiredSignIn.token : null),
      now: () => Date.now(),
    });
    const { client, session } = openClient(hostId, source, {
      kind: "user",
      id: USER_A,
    });
    const probe = await socketAt(1);
    expect((await readOpen(probe)).token).toBe(NO_HOST_TOKEN_PROBE);
    probe.fireMessage(namedRefusal("owner_sign_in"));
    const invited = await socketOnThisTurn(2);
    expect((await readOpen(invited)).token).toBe(expiredSignIn.token);
    expect(refreshCalls).toBe(0);
    invited.fireMessage(openAckFrame([], null));
    await settle();
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
        if (mintCalls === 1) {
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
    await source.adopt(USER_A, hostId, expired, source.era(USER_A), () => true);
    const { client, session } = openClient(hostId, source, {
      kind: "user",
      id: USER_A,
    });
    await racingMintStarted;
    const first = await socketAt(1);
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
    const afterOutage = await socketAt(3);
    expect(mintCalls).toBeGreaterThanOrEqual(2);
    expect((await readOpen(afterOutage)).token).toBe(freshToken);
    afterOutage.fireMessage(openAckFrame([], null));
    await settle();
    expect(sentTokens()).toEqual([expired.token, freshToken, freshToken]);
    expect(hostDoorStateFor(hostId)).toBeNull();
    session.close();
    client.close("test complete");
    clearHostDoorState(hostId);
  });

  it("does not send sign-in when a team host refuses a host token by name", async () => {
    const hostId = "local-other-host-token-not-admitted";
    clearHostDoorState(hostId);
    const otherHostToken = expiredJwt(Date.now());
    const { source, mintCalls } = await tokensFor(
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
    await vi.waitFor(() => expect(mintCalls()).toBeGreaterThanOrEqual(1));
    const socket = await socketAt(1);
    await settle();
    expect((await readOpen(socket)).token).toBe(otherHostToken.token);
    socket.fireMessage(namedRefusal("not_admitted"));
    await vi.waitFor(() => expect(heard).toHaveLength(1));
    expect(sentTokens()).toEqual([otherHostToken.token]);
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

  describe("a connection admitted to the host keeps a late report off its door", () => {
    it("raises no state when a second stream's mint answers unavailable after it closed, while the first stream stays admitted", async () => {
      const hostId = "local-admitted-then-late-mint";
      clearHostDoorState(hostId);
      const mints = heldMints();
      const source = sourceWithMint(mints.mint);
      const owner = { kind: "user", id: USER_A } as const;
      const first = openClient(hostId, source, owner);
      await vi.waitFor(() => expect(mints.asked()).toBeGreaterThanOrEqual(1));
      const probe = await socketAt(1);
      expect((await readOpen(probe)).token).toBe(NO_HOST_TOKEN_PROBE);
      probe.fireMessage(namedRefusal("owner_sign_in"));
      const invited = await socketOnThisTurn(2);
      expect((await readOpen(invited)).token).toBe(SIGN_IN_TOKEN);
      invited.fireMessage(openAckFrame([], null));
      await settle();

      // A one-shot stream to the same host starts its own background mint and closes.
      await vi.advanceTimersByTimeAsync(5);
      const second = openClient(hostId, source, owner);
      await settle();
      second.session.close();
      second.client.close("one-shot done");

      mints.answerAll({ kind: "unavailable", detail: "authn offline" });
      await settle();
      expect(hostDoorStateFor(hostId)).toBeNull();
      first.session.close();
      first.client.close("test complete");
      clearHostDoorState(hostId);
    });

    it("drops the fatal that ends one admitted stream while another to the host stays admitted, and raises a later one once the other is released", async () => {
      const hostId = "local-two-streams-one-fatal";
      clearHostDoorState(hostId);
      const held = {
        token: "usable-host-token",
        expiresAtMs: Date.now() + 3_600_000,
      };
      const { source } = await tokensFor(hostId, [], held);
      const owner = { kind: "user", id: USER_A } as const;
      const admit = async (
        count: number,
      ): Promise<{
        readonly socket: FakeNativeWebSocket;
        readonly close: () => void;
      }> => {
        const stream = openClient(hostId, source, owner);
        const socket = await socketOnThisTurn(count);
        expect((await readOpen(socket)).token).toBe(held.token);
        socket.fireMessage(openAckFrame([], null));
        await settle();
        return {
          socket,
          close: () => {
            stream.session.close();
            stream.client.close("test complete");
          },
        };
      };
      const first = await admit(1);
      const second = await admit(2);

      // The second connection ends on the host's fatal: the first still works.
      second.socket.fireMessage(namedRefusal("host_claimed"));
      await settle();
      expect(hostDoorStateFor(hostId)).toBeNull();

      first.close();
      await settle();
      const third = await admit(3);
      third.socket.fireMessage(namedRefusal("host_claimed"));
      await vi.waitFor(() =>
        expect(hostDoorStateFor(hostId)?.kind).toBe("host-claimed"),
      );
      third.close();
      second.close();
      clearHostDoorState(hostId);
    });

    it("still raises the state when nothing was admitted for the host and the mint answers unavailable (guard)", async () => {
      const hostId = "local-nothing-admitted-late-mint";
      clearHostDoorState(hostId);
      const mints = heldMints();
      const source = sourceWithMint(mints.mint);
      const { client, session } = openClient(hostId, source, {
        kind: "user",
        id: USER_A,
      });
      await vi.waitFor(() => expect(mints.asked()).toBeGreaterThanOrEqual(1));
      const probe = await socketAt(1);
      expect((await readOpen(probe)).token).toBe(NO_HOST_TOKEN_PROBE);

      mints.answerAll({ kind: "unavailable", detail: "authn offline" });
      await settle();
      expect(hostDoorStateFor(hostId)?.kind).toBe("token-unavailable");
      session.close();
      client.close("test complete");
      clearHostDoorState(hostId);
    });
  });

  describe("a mint's report belongs to the subscriptions that asked for it", () => {
    /** A subscription that starts the pair's background mint, then probes with the placeholder. */
    async function startMintFrom(hostId: string, mints: HeldMints) {
      const stream = openClient(hostId, sourceWithMint(mints.mint), {
        kind: "user",
        id: USER_A,
      });
      await vi.waitFor(() => expect(mints.asked()).toBeGreaterThanOrEqual(1));
      const probe = await socketAt(1);
      expect((await readOpen(probe)).token).toBe(NO_HOST_TOKEN_PROBE);
      return stream;
    }

    it("raises no state when the subscription that asked for the mint closed and the shared client stayed open", async () => {
      const hostId = "local-asker-closed-client-open";
      clearHostDoorState(hostId);
      const mints = heldMints();
      const { client, session } = await startMintFrom(hostId, mints);

      session.close();
      expect(client.isClosed()).toBe(false);
      mints.answerAll({ kind: "not-admitted" });
      await settle();
      expect(hostDoorStateFor(hostId)).toBeNull();
      client.close("test complete");
      clearHostDoorState(hostId);
    });

    it("raises the state when the subscription that asked for the mint is still open (guard)", async () => {
      const hostId = "local-asker-open";
      clearHostDoorState(hostId);
      const mints = heldMints();
      const { client, session } = await startMintFrom(hostId, mints);

      mints.answerAll({ kind: "not-admitted" });
      await settle();
      expect(hostDoorStateFor(hostId)?.kind).toBe("not-admitted");
      session.close();
      client.close("test complete");
      clearHostDoorState(hostId);
    });

    it("raises the state when another subscription on the client joined the mint and is still open, though the first closed (guard)", async () => {
      const hostId = "local-asker-closed-joiner-open";
      clearHostDoorState(hostId);
      const mints = heldMints();
      const { client, session } = await startMintFrom(hostId, mints);
      const joiner = client.subscribe("epic.subscribe", { epicId: "epic-b" });
      await socketCounted(2);

      session.close();
      mints.answerAll({ kind: "not-admitted" });
      await settle();
      expect(hostDoorStateFor(hostId)?.kind).toBe("not-admitted");
      joiner.close();
      client.close("test complete");
      clearHostDoorState(hostId);
    });

    it("raises nothing for the replacement process when the mint it started for the earlier process fails, with the subscription alive throughout", async () => {
      const hostId = "local-mint-across-process-change";
      clearHostDoorState(hostId);
      processReleasedHosts.observeInstance(hostId, "process-a");
      const mints = heldMints();
      const { client, session } = await startMintFrom(hostId, mints);

      // The host restarts under the same id, and its replacement has not admitted anything yet.
      processReleasedHosts.observeInstance(hostId, "process-b");
      mints.answerAll({ kind: "not-admitted" });
      await settle();
      expect(hostDoorStateFor(hostId)).toBeNull();
      session.close();
      client.close("test complete");
      clearHostDoorState(hostId);
    });

    /** The host calls a usable token expired; the recovery's fresh mint is answered `not-a-member`. */
    async function answerRecoveryMint(
      hostId: string,
      closeBeforeAnswer: boolean,
    ): Promise<string | null> {
      clearHostDoorState(hostId);
      const mints = heldMints();
      const source = sourceWithMint(mints.mint);
      await source.adopt(
        USER_A,
        hostId,
        { token: "usable-host-token", expiresAtMs: Date.now() + 3_600_000 },
        source.era(USER_A),
        () => true,
      );
      const { client, session } = openClient(hostId, source, {
        kind: "user",
        id: USER_A,
      });
      const socket = await socketOnThisTurn(1);
      expect((await readOpen(socket)).token).toBe("usable-host-token");
      socket.fireMessage(namedRefusal("token_expired"));
      await vi.waitFor(() => expect(mints.asked()).toBe(1));
      if (closeBeforeAnswer) session.close();
      mints.answerAll({ kind: "not-a-member" });
      await settle();
      const kind = hostDoorStateFor(hostId)?.kind ?? null;
      session.close();
      client.close("test complete");
      clearHostDoorState(hostId);
      return kind;
    }

    it("raises nothing for the recovery mint of a subscription that closed while it ran", async () => {
      expect(await answerRecoveryMint("local-recovery-closed", true)).not.toBe(
        "not-a-member",
      );
    });

    it("raises the state for the recovery mint of a subscription that is still open (guard)", async () => {
      expect(await answerRecoveryMint("local-recovery-open", false)).toBe(
        "not-a-member",
      );
    });
  });

  it("probes a current team computer at once with no host-only token held, and dials the minted token once the slow mint succeeds", async () => {
    const hostId = "local-team-slow-mint";
    clearHostDoorState(hostId);
    const mints = heldMints();
    const source = sourceWithMint(mints.mint);
    const minted = "team-host-token-after-slow-mint";
    const { client, session } = openClient(hostId, source, {
      kind: "team",
      id: "team-a",
      name: "Alpha",
    });
    await vi.waitFor(() => expect(mints.asked()).toBeGreaterThanOrEqual(1));
    // The mint has not answered, and the first dial is already the probe.
    const probe = await socketOnThisTurn(1);
    expect((await readOpen(probe)).token).toBe(NO_HOST_TOKEN_PROBE);
    probe.fireMessage(namedRefusal("not_admitted"));
    await settle();

    mints.answerAll({
      kind: "ok",
      token: { token: minted, expiresAtMs: Date.now() + 60_000 },
    });
    await settle();
    await vi.advanceTimersByTimeAsync(DEFAULT_INITIAL_BACKOFF_MS * 4);
    const next = await socketAt(2);
    expect((await readOpen(next)).token).toBe(minted);
    expect(sentTokens()).not.toContain(SIGN_IN_TOKEN);
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
    expect(sentTokens()).toEqual([]);
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
  it.each([
    {
      id: "released",
      name: "a released host",
      answer: () => releasedRefusal(),
      followedBySignIn: true,
    },
    {
      id: "personal",
      name: "a current personal host",
      answer: () => namedRefusal("owner_sign_in"),
      followedBySignIn: true,
    },
    {
      id: "team",
      name: "a current team host",
      answer: () => namedRefusal("not_admitted"),
      followedBySignIn: false,
    },
  ])(
    "opens the first socket of $name with no timer advanced while authn never answers",
    async ({ id, answer, followedBySignIn }) => {
      const hostId = `local-black-holed-${id}`;
      clearHostDoorState(hostId);
      const { source, mintCalls } = await blackHoledTokens();
      const { client, session } = openClient(hostId, source, {
        kind: "user",
        id: USER_A,
      });
      await settle();
      expect(mintCalls()).toBe(1);
      expect(FakeNativeWebSocket.instances).toHaveLength(1);
      const probe = FakeNativeWebSocket.instances[0];
      expect((await readOpen(probe)).token).toBe(NO_HOST_TOKEN_PROBE);
      probe.fireMessage(answer());
      if (followedBySignIn) {
        const second = await socketOnThisTurn(2);
        expect((await readOpen(second)).token).toBe(SIGN_IN_TOKEN);
        expect(sentTokens()).toEqual([NO_HOST_TOKEN_PROBE, SIGN_IN_TOKEN]);
      } else {
        await vi.advanceTimersByTimeAsync(DEFAULT_INITIAL_BACKOFF_MS * 4);
        expect(sentTokens()).toEqual([NO_HOST_TOKEN_PROBE]);
      }
      expect(heard).toEqual([]);
      session.close();
      client.close("test complete");
      clearHostDoorState(hostId);
    },
  );

  it("hands a current personal host the sign-in once and the minted host-only token on the next open, when authn answers ok after the first dial", async () => {
    const hostId = "local-online-fresh-personal";
    clearHostDoorState(hostId);
    let answerMint: (outcome: HostTokenMintOutcome) => void = () => undefined;
    const pendingMint = new Promise<HostTokenMintOutcome>((resolve) => {
      answerMint = resolve;
    });
    const source = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: () => pendingMint,
      signIn: (userId) => (userId === USER_A ? SIGN_IN_TOKEN : null),
      now: () => Date.now(),
    });
    await settle();
    const { client, session } = openClient(hostId, source, {
      kind: "user",
      id: USER_A,
    });
    await settle();
    expect(FakeNativeWebSocket.instances).toHaveLength(1);
    const probe = FakeNativeWebSocket.instances[0];
    expect((await readOpen(probe)).token).toBe(NO_HOST_TOKEN_PROBE);
    probe.fireMessage(namedRefusal("owner_sign_in"));
    const invited = await socketOnThisTurn(2);
    expect((await readOpen(invited)).token).toBe(SIGN_IN_TOKEN);
    invited.fireMessage(openAckFrame([], null));
    await settle();

    answerMint({
      kind: "ok",
      token: { token: HOST_ONLY_AFTER_MINT, expiresAtMs: Date.now() + 60_000 },
    });
    await vi.waitFor(() =>
      expect(source.current(USER_A, hostId)?.token).toBe(HOST_ONLY_AFTER_MINT),
    );
    invited.fireClose(1006, "dropped after sign-in admission");
    await vi.advanceTimersToNextTimerAsync();
    const next = await socketAt(3);
    expect((await readOpen(next)).token).toBe(HOST_ONLY_AFTER_MINT);
    next.fireMessage(openAckFrame([], null));
    await settle();

    expect(sentTokens()).toEqual([
      NO_HOST_TOKEN_PROBE,
      SIGN_IN_TOKEN,
      HOST_ONLY_AFTER_MINT,
    ]);
    expect(heard).toEqual([]);
    session.close();
    client.close("test complete");
    clearHostDoorState(hostId);
  });

  it("puts an expired released sign-in on the wire with no refresh before the dial", async () => {
    const hostId = "local-released-expired-sign-in";
    clearHostDoorState(hostId);
    const expiredSignIn = expiredJwt(Date.now());
    presentedSignIn = expiredSignIn.token;
    let refreshCalls = 0;
    streamAuth = {
      revalidateForReconnect: () => {
        refreshCalls += 1;
        return Promise.resolve("network-error");
      },
    };
    const { source } = await blackHoledTokens();
    const { client, session } = openClient(hostId, source, {
      kind: "user",
      id: USER_A,
    });
    await settle();
    const probe = FakeNativeWebSocket.instances[0];
    expect((await readOpen(probe)).token).toBe(NO_HOST_TOKEN_PROBE);
    probe.fireMessage(releasedRefusal());
    const signedIn = await socketOnThisTurn(2);
    expect((await readOpen(signedIn)).token).toBe(expiredSignIn.token);
    expect(refreshCalls).toBe(0);
    session.close();
    client.close("test complete");
    clearHostDoorState(hostId);
  });

  it("takes the fresh-mint recovery, never the probe, when a locally usable host-only token is refused as expired", async () => {
    const hostId = "local-usable-token-refused-expired";
    clearHostDoorState(hostId);
    const expired = expiredJwt(Date.now());
    const usable = {
      token: "locally-usable-host-token",
      expiresAtMs: Date.now() + 60_000,
    };
    const reminted = "host-token-minted-after-the-refusal";
    let authnAnswers = false;
    let mintCalls = 0;
    const source = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: () => {
        mintCalls += 1;
        return Promise.resolve(
          authnAnswers
            ? {
                kind: "ok",
                token: { token: reminted, expiresAtMs: Date.now() + 60_000 },
              }
            : { kind: "unavailable", detail: "authn offline" },
        );
      },
      signIn: (userId) => (userId === USER_A ? SIGN_IN_TOKEN : null),
      now: () => Date.now(),
    });
    await source.adopt(USER_A, hostId, expired, source.era(USER_A), () => true);
    const { client, session } = openClient(hostId, source, {
      kind: "user",
      id: USER_A,
    });
    await vi.waitFor(() => expect(mintCalls).toBeGreaterThanOrEqual(1));
    const first = await socketAt(1);
    expect((await readOpen(first)).token).toBe(expired.token);
    first.fireMessage(openAckFrame([], null));
    await settle();
    // Another transport stored a token that this clock still reads as usable,
    // and authn answers from here on.
    await source.adopt(USER_A, hostId, usable, source.era(USER_A), () => true);
    authnAnswers = true;
    first.fireClose(1006, "dropped");
    const second = await socketAt(2);
    expect((await readOpen(second)).token).toBe(usable.token);
    second.fireMessage(namedRefusal("token_expired"));
    const third = await socketAt(3);
    expect((await readOpen(third)).token).toBe(reminted);
    expect(sentTokens()).toEqual([expired.token, usable.token, reminted]);
    session.close();
    client.close("test complete");
    clearHostDoorState(hostId);
  });

  it("sends the placeholder at once for a locally usable held token the host refused as expired, and carries the token a fresh mint buys", async () => {
    const hostId = "local-refused-usable-placeholder";
    clearHostDoorState(hostId);
    const usable = {
      token: "locally-usable-host-token",
      expiresAtMs: Date.now() + 3_600_000,
    };
    const fresh = "host-token-bought-after-the-refusal";
    const mints = heldMints();
    const source = sourceWithMint(mints.mint);
    await source.adopt(USER_A, hostId, usable, source.era(USER_A), () => true);
    const { client, session } = openClient(hostId, source, {
      kind: "user",
      id: USER_A,
    });
    const first = await socketOnThisTurn(1);
    expect((await readOpen(first)).token).toBe(usable.token);
    first.fireMessage(namedRefusal("token_expired"));
    // The refusal's own recovery asks authn, which cannot be reached.
    await vi.waitFor(() => expect(mints.asked()).toBe(1));
    mints.answerAll({ kind: "unavailable", detail: "authn offline" });

    // Authn answers nothing from here on: the dial must not wait for it.
    const second = await socketAt(2);
    expect((await readOpen(second)).token).toBe(NO_HOST_TOKEN_PROBE);

    mints.answerAll({
      kind: "ok",
      token: { token: fresh, expiresAtMs: Date.now() + 3_600_000 },
    });
    await settle();
    second.fireClose(1006, "dropped");
    const third = await socketAt(3);
    expect((await readOpen(third)).token).toBe(fresh);
    expect(sentTokens()).toEqual([usable.token, NO_HOST_TOKEN_PROBE, fresh]);
    session.close();
    client.close("test complete");
    clearHostDoorState(hostId);
  });

  it("sends no sign-in on a host's invitation when another client of the process was refused by authn for this computer", async () => {
    const hostId = "local-sibling-refused-by-authn";
    clearHostDoorState(hostId);
    const mints = heldMints();
    const source = sourceWithMint(mints.mint);
    const owner = { kind: "user", id: USER_A } as const;
    const sibling = openClient(hostId, source, owner);
    await vi.waitFor(() => expect(mints.asked()).toBeGreaterThanOrEqual(1));
    mints.answerAll({ kind: "not-admitted" });
    await settle();

    // A new client of the same process: authn's answer to the sibling is its own.
    const second = openClient(hostId, source, owner);
    const probe = await socketCounted(2);
    expect((await readOpen(probe)).token).toBe(NO_HOST_TOKEN_PROBE);
    probe.fireMessage(namedRefusal("owner_sign_in"));
    await vi.advanceTimersByTimeAsync(DEFAULT_INITIAL_BACKOFF_MS * 4);
    expect(sentTokens()).not.toContain(SIGN_IN_TOKEN);
    sibling.session.close();
    sibling.client.close("test complete");
    second.session.close();
    second.client.close("test complete");
    clearHostDoorState(hostId);
  });

  it("answers an invitation with the sign-in when the mint after authn's refusal could not save its token", async () => {
    const hostId = "local-save-fails-after-refusal";
    clearHostDoorState(hostId);
    const mints = heldMints();
    const memory = createMemoryHostTokenPersistence();
    let saveFails = false;
    const persistence: HostTokenPersistence = {
      load: () => memory.load(),
      update: (change) => {
        if (saveFails) return Promise.reject(new Error("disk full"));
        return memory.update(change);
      },
    };
    const source = createHostTokenSource({
      persistence,
      mint: mints.mint,
      signIn: (userId) => (userId === USER_A ? SIGN_IN_TOKEN : null),
      now: () => Date.now(),
    });
    const { client, session } = openClient(hostId, source, {
      kind: "user",
      id: USER_A,
    });
    await vi.waitFor(() => expect(mints.asked()).toBe(1));
    mints.answerAll({ kind: "not-a-member" });
    await settle();
    // The next dial asks again, and authn's token cannot be kept.
    saveFails = true;
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(DEFAULT_INITIAL_BACKOFF_MS);
      expect(mints.asked()).toBe(2);
    });
    mints.answerAll({
      kind: "ok",
      token: { token: "unsaved-host-token", expiresAtMs: Date.now() + 60_000 },
    });
    await settle();

    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(DEFAULT_INITIAL_BACKOFF_MS * 4);
      expect(FakeNativeWebSocket.instances.length).toBeGreaterThanOrEqual(1);
    });
    const probe = await socketCounted(1);
    expect((await readOpen(probe)).token).toBe(NO_HOST_TOKEN_PROBE);
    probe.fireMessage(namedRefusal("owner_sign_in"));
    const invited = await socketOnThisTurn(2);
    expect((await readOpen(invited)).token).toBe(SIGN_IN_TOKEN);
    session.close();
    client.close("test complete");
    clearHostDoorState(hostId);
  });

  it("asks authn to refresh the sign-in again after a refresh that could not reach it, and recovers when it answers", async () => {
    const hostId = "local-refresh-after-outage";
    clearHostDoorState(hostId);
    const held = {
      token: "held-host-token",
      expiresAtMs: Date.now() + 3_600_000,
    };
    const fresh = "host-token-after-the-refresh";
    let mintCalls = 0;
    const source = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: () => {
        mintCalls += 1;
        return Promise.resolve<HostTokenMintOutcome>(
          mintCalls <= 2
            ? { kind: "sign-in-rejected" }
            : {
                kind: "ok",
                token: { token: fresh, expiresAtMs: Date.now() + 3_600_000 },
              },
        );
      },
      signIn: (userId) => (userId === USER_A ? SIGN_IN_TOKEN : null),
      now: () => Date.now(),
    });
    await source.adopt(USER_A, hostId, held, source.era(USER_A), () => true);
    // What authn received: the first refresh cannot reach it, the second does.
    const refreshRequests: Array<"unreachable" | "answered"> = [];
    streamAuth = {
      revalidateForReconnect: () => {
        const answered = refreshRequests.length > 0;
        refreshRequests.push(answered ? "answered" : "unreachable");
        return Promise.resolve(answered ? "rotated" : "network-error");
      },
    };
    const { client, session } = openClient(hostId, source, {
      kind: "user",
      id: USER_A,
    });
    const first = await socketOnThisTurn(1);
    expect((await readOpen(first)).token).toBe(held.token);
    first.fireMessage(namedRefusal("not_admitted"));
    const second = await socketAt(2);
    expect((await readOpen(second)).token).toBe(held.token);
    second.fireMessage(namedRefusal("not_admitted"));
    const third = await socketAt(3);
    expect((await readOpen(third)).token).toBe(fresh);
    expect(refreshRequests).toEqual(["unreachable", "answered"]);
    session.close();
    client.close("test complete");
    clearHostDoorState(hostId);
  });

  it("sends one sign-in refresh to authn when two sessions of one client are refused at once, and both act on its answer", async () => {
    const hostId = "local-two-sessions-one-refresh";
    clearHostDoorState(hostId);
    const held = {
      token: "held-host-token",
      expiresAtMs: Date.now() + 3_600_000,
    };
    const fresh = "host-token-after-the-one-refresh";
    let mintCalls = 0;
    const source = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: () => {
        mintCalls += 1;
        return Promise.resolve<HostTokenMintOutcome>(
          mintCalls === 1
            ? { kind: "sign-in-rejected" }
            : {
                kind: "ok",
                token: { token: fresh, expiresAtMs: Date.now() + 3_600_000 },
              },
        );
      },
      signIn: (userId) => (userId === USER_A ? SIGN_IN_TOKEN : null),
      now: () => Date.now(),
    });
    await source.adopt(USER_A, hostId, held, source.era(USER_A), () => true);
    // Authn answers the refresh only when the test says so.
    const refreshRequests: string[] = [];
    let answerRefresh: (outcome: "rotated") => void = () => undefined;
    streamAuth = {
      revalidateForReconnect: () => {
        refreshRequests.push("refresh");
        return new Promise((resolve) => {
          answerRefresh = resolve;
        });
      },
    };
    const { client, session } = openClient(hostId, source, {
      kind: "user",
      id: USER_A,
    });
    const other = client.subscribe("epic.subscribe", { epicId: "epic-b" });
    const second = await socketCounted(2);
    const first = FakeNativeWebSocket.instances[0];
    expect((await readOpen(first)).token).toBe(held.token);
    expect((await readOpen(second)).token).toBe(held.token);
    first.fireMessage(namedRefusal("not_admitted"));
    second.fireMessage(namedRefusal("not_admitted"));
    await vi.waitFor(() => expect(refreshRequests).toHaveLength(1));
    await settle();
    expect(refreshRequests).toHaveLength(1);

    answerRefresh("rotated");
    await vi.advanceTimersByTimeAsync(DEFAULT_INITIAL_BACKOFF_MS * 4);
    await socketCounted(4);
    const redialed = FakeNativeWebSocket.instances.slice(2);
    const carried = await Promise.all(
      redialed.map(async (socket) => (await readOpen(socket)).token),
    );
    expect(carried).toEqual([fresh, fresh]);
    expect(refreshRequests).toHaveLength(1);
    other.close();
    session.close();
    client.close("test complete");
    clearHostDoorState(hostId);
  });

  it("presents a held token the earlier process refused as expired to the replacement process", async () => {
    const hostId = "local-refused-token-replacement-process";
    clearHostDoorState(hostId);
    processReleasedHosts.observeInstance(hostId, "process-a");
    const usable = {
      token: "locally-usable-host-token",
      expiresAtMs: Date.now() + 3_600_000,
    };
    const mints = heldMints();
    const source = sourceWithMint(mints.mint);
    await source.adopt(USER_A, hostId, usable, source.era(USER_A), () => true);
    const { client, session } = openClient(hostId, source, {
      kind: "user",
      id: USER_A,
    });
    const first = await socketOnThisTurn(1);
    expect((await readOpen(first)).token).toBe(usable.token);
    first.fireMessage(namedRefusal("token_expired"));
    await vi.waitFor(() => expect(mints.asked()).toBe(1));
    mints.answerAll({ kind: "unavailable", detail: "authn offline" });
    await settle();

    // The host restarts under the same id before the redial; the refusal was its predecessor's.
    processReleasedHosts.observeInstance(hostId, "process-b");
    const second = await socketAt(2);
    expect((await readOpen(second)).token).toBe(usable.token);
    session.close();
    client.close("test complete");
    clearHostDoorState(hostId);
  });

  it("dials again after a retryable named probe refusal and carries the minted token, which clears the probe latch", async () => {
    const hostId = "local-retryable-named-probe";
    clearHostDoorState(hostId);
    const minted = "minted-after-retryable-probe";
    const { source, mintCalls } = await tokensFor(
      hostId,
      [
        { kind: "unavailable", detail: "authn offline" },
        {
          kind: "ok",
          token: { token: minted, expiresAtMs: Date.now() + 60_000 },
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
    probe.fireMessage(retryableNamedRefusal("not_admitted"));
    expect(processReleasedHosts.probeDeclined(USER_A, hostId)).toBe(true);

    await vi.advanceTimersToNextTimerAsync();
    const admitted = await socketCounted(2);
    expect((await readOpen(admitted)).token).toBe(minted);
    admitted.fireMessage(openAckFrame([], null));
    await settle();
    expect(processReleasedHosts.probeDeclined(USER_A, hostId)).toBe(false);
    expect(sentTokens()).toEqual([NO_HOST_TOKEN_PROBE, minted]);
    expect(hostDoorStateFor(hostId)).toBeNull();
    session.close();
    client.close("test complete");
    clearHostDoorState(hostId);
  });
});
