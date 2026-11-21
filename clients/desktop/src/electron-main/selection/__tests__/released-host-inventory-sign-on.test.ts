import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHostTokenSource,
  createMemoryHostTokenPersistence,
} from "@traycer-clients/shared/auth/host-token-source";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { HostInventoryStreamClient } from "@traycer-clients/shared/host-transport/host-inventory-stream-client";
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
  USER_B,
} from "@traycer-clients/shared/test-fixtures/dial-gate-harness";
import { processReleasedHosts } from "@traycer-clients/shared/host-transport/released-sign-on";
import { createLocalHostInventoryStreamClient } from "../local-host-inventory-subscription";
import { NO_HOST_TOKEN_PROBE } from "@traycer/protocol/framework/door-reason";

const SIGN_IN_TOKEN = "main-sign-in-token";
const SIGN_IN_B = "main-sign-in-token-b";
const HOST_TOKEN = "main-host-token";
const HOST_TOKEN_B = "main-host-token-b";
const RELEASED_HOST = { ...mockLocalHostEntry, version: "1.5.4" };
const CURRENT_HOST_FOR_USER_SWITCH = "current-host-user-switch";
const CURRENT_HOST_WHILE_AUTHN_OFFLINE = "current-host-authn-offline";
let activeClosers: Array<() => void> = [];

type RowOwner = "personal" | "team" | "unknown";

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function ownershipBody(owner: RowOwner): unknown {
  return {
    hosts: [
      owner === "team"
        ? {
            hostId: RELEASED_HOST.hostId,
            owner: { kind: "team", id: "team-1", name: "Team" },
            kind: "machine",
            remoteAccess: false,
          }
        : {
            hostId: RELEASED_HOST.hostId,
            owner: { kind: "user", id: USER_A },
            kind: "personal",
            remoteAccess: false,
          },
    ],
  };
}

function installFetch(owner: RowOwner): void {
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(requestUrl(input));
      if (url.pathname === "/api/v3/hosts") {
        if (owner === "unknown")
          return new Response("authn unavailable", { status: 503 });
        return new Response(JSON.stringify(ownershipBody(owner)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("unexpected", { status: 500 });
    },
  );
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

function expiredTokenRefusal(): string {
  return JSON.stringify({
    kind: "fatalError",
    details: {
      code: "UNAUTHORIZED",
      reason: "host token expired",
      doorReason: "token_expired",
      retryable: false,
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  });
}

function invalidSessionGrantRefusal(): string {
  return JSON.stringify({
    kind: "fatalError",
    details: {
      code: "UNAUTHORIZED",
      reason: "Session grant verification failed: ERR_JWS_INVALID",
      doorReason: "not_admitted",
      retryable: false,
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  });
}

function ownerSignInRefusal(): string {
  return JSON.stringify({
    kind: "fatalError",
    details: {
      code: "UNAUTHORIZED",
      reason: "current-host-refusal",
      doorReason: "owner_sign_in",
      retryable: false,
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  });
}

async function openInventory(
  owner: RowOwner,
  expiresAtMs: number | undefined,
  hostId: string | undefined,
): Promise<{
  readonly statuses: string[];
  readonly mintCalls: () => number;
  readonly close: () => void;
}> {
  installFetch(owner);
  const selectedHostId = hostId ?? RELEASED_HOST.hostId;
  const provider = newProvider();
  signIn(provider, USER_A, SIGN_IN_TOKEN);
  let mintCalls = 0;
  const hostTokens = createHostTokenSource({
    persistence: createMemoryHostTokenPersistence(),
    mint: () => {
      mintCalls += 1;
      return Promise.resolve({ kind: "unavailable", detail: "authn offline" });
    },
    signIn: (userId) => (userId === USER_A ? SIGN_IN_TOKEN : null),
    now: () => Date.now(),
  });
  const websocketUrl = RELEASED_HOST.websocketUrl;
  if (websocketUrl === null) {
    throw new Error("the mock local host has no websocket URL");
  }
  await hostTokens.adopt(
    USER_A,
    selectedHostId,
    { token: HOST_TOKEN, expiresAtMs: expiresAtMs ?? Date.now() + 60_000 },
    hostTokens.era(USER_A),
  );
  const endpoint = {
    hostId: selectedHostId,
    websocketUrl,
    version: RELEASED_HOST.version,
  };
  const inventoryClient = createLocalHostInventoryStreamClient({
    authnBaseUrl: "https://authn.test",
    hostTokens,
    localHost: () => endpoint,
    bearer: liveBearer(provider),
    appVersion: "1.0.0-test",
  });
  const stream = inventoryClient(endpoint, USER_A);
  if (stream === null)
    throw new Error("local inventory stream client did not build");
  const statuses: string[] = [];
  const inventory = new HostInventoryStreamClient({
    wsStreamClient: stream,
    callbacks: {
      onSnapshot: () => undefined,
      onConnectionStatus: (status) => {
        statuses.push(status);
      },
    },
  });
  const close = (): void => {
    inventory.close();
    stream.close("test complete");
  };
  activeClosers.push(close);
  return {
    statuses,
    mintCalls: () => mintCalls,
    close,
  };
}

async function refusedOpen(): Promise<FakeNativeWebSocket> {
  await vi.waitFor(() => expect(FakeNativeWebSocket.instances).toHaveLength(1));
  const socket = FakeNativeWebSocket.instances[0];
  if (socket === undefined) throw new Error("inventory socket missing");
  socket.fireOpen();
  await vi.waitFor(() =>
    expect(sentFramesOfKind(socket, "open")).toHaveLength(1),
  );
  expect(sentFramesOfKind(socket, "open")[0]?.token).toBe(HOST_TOKEN);
  socket.fireMessage(releasedRefusal());
  await settle();
  return socket;
}

describe("desktop inventory push against a released local host", () => {
  beforeEach(() => {
    activeClosers = [];
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeNativeWebSocket);
    FakeNativeWebSocket.instances.length = 0;
  });

  afterEach(async () => {
    for (const close of activeClosers) close();
    processReleasedHosts.forgetAll();
    for (const socket of FakeNativeWebSocket.instances) {
      socket.fireClose(1006, "test teardown");
    }
    await settle();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("opens the person's own computer with the sign-in after the host-only token is refused", async () => {
    const opened = await openInventory("personal", undefined, undefined);
    await refusedOpen();
    await vi.waitFor(() =>
      expect(
        FakeNativeWebSocket.instances.length >= 2 ||
          opened.statuses.includes("closed"),
      ).toBe(true),
    );
    expect(FakeNativeWebSocket.instances).toHaveLength(2);
    const signInSocket = FakeNativeWebSocket.instances[1];
    if (signInSocket === undefined) throw new Error("sign-in socket missing");
    signInSocket.fireOpen();
    await vi.waitFor(() =>
      expect(sentFramesOfKind(signInSocket, "open")).toHaveLength(1),
    );
    expect(sentTokens()).toEqual([HOST_TOKEN, SIGN_IN_TOKEN]);
    opened.close();
  });

  it("never sends the sign-in when authn says the computer is a team's", async () => {
    const opened = await openInventory("team", undefined, undefined);
    await refusedOpen();
    await vi.waitFor(() =>
      expect(
        FakeNativeWebSocket.instances.length >= 2 ||
          opened.statuses.includes("closed"),
      ).toBe(true),
    );
    expect(sentTokens()).not.toContain(SIGN_IN_TOKEN);
    expect(sentTokens()).toEqual([HOST_TOKEN]);
    opened.close();
  });

  it("re-presents a refused held token after an unknown registry row declines the probe", async () => {
    const opened = await openInventory(
      "unknown",
      Date.now() - 11 * 60_000,
      CURRENT_HOST_WHILE_AUTHN_OFFLINE,
    );
    await vi.waitFor(() => expect(opened.mintCalls()).toBeGreaterThan(0));
    await vi.advanceTimersToNextTimerAsync();
    await vi.waitFor(() =>
      expect(FakeNativeWebSocket.instances).toHaveLength(1),
    );
    const first = FakeNativeWebSocket.instances[0];
    if (first === undefined) throw new Error("inventory socket missing");
    first.fireOpen();
    await vi.waitFor(() =>
      expect(sentFramesOfKind(first, "open")).toHaveLength(1),
    );
    expect(sentFramesOfKind(first, "open")[0]?.token).toBe(HOST_TOKEN);
    first.fireMessage(expiredTokenRefusal());
    await vi.advanceTimersToNextTimerAsync();

    const probe = await vi.waitFor(() => {
      expect(FakeNativeWebSocket.instances).toHaveLength(2);
      return FakeNativeWebSocket.instances[1];
    });
    if (probe === undefined) throw new Error("probe socket missing");
    probe.fireOpen();
    await vi.waitFor(() =>
      expect(sentFramesOfKind(probe, "open")).toHaveLength(1),
    );
    expect(sentFramesOfKind(probe, "open")[0]?.token).toBe(NO_HOST_TOKEN_PROBE);
    probe.fireMessage(invalidSessionGrantRefusal());
    await vi.advanceTimersToNextTimerAsync();

    const admitted = await vi.waitFor(() => {
      expect(FakeNativeWebSocket.instances).toHaveLength(3);
      return FakeNativeWebSocket.instances[2];
    });
    if (admitted === undefined) throw new Error("held-token socket missing");
    admitted.fireOpen();
    await vi.waitFor(() =>
      expect(sentFramesOfKind(admitted, "open")).toHaveLength(1),
    );
    expect(sentFramesOfKind(admitted, "open")[0]?.token).toBe(HOST_TOKEN);
    admitted.fireMessage(openAckFrame([], null));
    await vi.waitFor(() => expect(opened.statuses).toContain("open"));
    expect(sentTokens()).toEqual([HOST_TOKEN, NO_HOST_TOKEN_PROBE, HOST_TOKEN]);
    expect(sentTokens()).not.toContain(SIGN_IN_TOKEN);
    opened.close();
  });

  it("keeps the next person's sign-in off a host the previous person admitted", async () => {
    const first = await openInventoryFor({
      userId: USER_A,
      signInToken: SIGN_IN_TOKEN,
      hostToken: HOST_TOKEN,
      rowOwnerId: USER_A,
    });
    await refusedOpen();
    await vi.waitFor(() =>
      expect(FakeNativeWebSocket.instances.length).toBeGreaterThanOrEqual(2),
    );
    const admitted = FakeNativeWebSocket.instances[1];
    if (admitted === undefined) throw new Error("sign-in socket missing");
    admitted.fireOpen();
    await vi.waitFor(() =>
      expect(sentFramesOfKind(admitted, "open")).toHaveLength(1),
    );
    const open = sentFramesOfKind(admitted, "open")[0];
    if (open === undefined) throw new Error("sign-in open missing");
    expect(open.token).toBe(SIGN_IN_TOKEN);
    admitted.fireMessage(
      JSON.stringify({
        kind: "openAck",
        manifest: open.manifest,
        capabilities: ["credentialUpdate"],
      }),
    );
    await vi.waitFor(() => expect(first.statuses).toContain("open"));
    first.close();
    await settle();
    FakeNativeWebSocket.instances.length = 0;

    const second = await openInventoryFor({
      userId: USER_B,
      signInToken: SIGN_IN_B,
      hostToken: HOST_TOKEN_B,
      rowOwnerId: USER_A,
    });
    await vi.waitFor(() =>
      expect(FakeNativeWebSocket.instances).toHaveLength(1),
    );
    const dial = FakeNativeWebSocket.instances[0];
    if (dial === undefined) throw new Error("next person's socket missing");
    dial.fireOpen();
    await vi.waitFor(() =>
      expect(sentFramesOfKind(dial, "open")).toHaveLength(1),
    );
    expect(sentFramesOfKind(dial, "open")[0]?.token).toBe(HOST_TOKEN_B);
    dial.fireMessage(releasedRefusal());
    await vi.waitFor(() => {
      const redial = FakeNativeWebSocket.instances[1];
      if (
        redial !== undefined &&
        sentFramesOfKind(redial, "open").length === 0
      ) {
        redial.fireOpen();
      }
      expect(
        second.statuses.includes("closed") ||
          FakeNativeWebSocket.instances.length >= 2,
      ).toBe(true);
    });
    expect(FakeNativeWebSocket.instances).toHaveLength(1);
    expect(second.statuses).toContain("closed");
    expect(sentTokens()).not.toContain(SIGN_IN_B);
    second.close();
  });

  it("lets person B probe after person A's probe was declined", async () => {
    const first = await openInventoryFor({
      hostId: CURRENT_HOST_FOR_USER_SWITCH,
      userId: USER_A,
      signInToken: SIGN_IN_TOKEN,
      hostToken: null,
      rowOwnerId: null,
    });
    await vi.waitFor(() => expect(first.mintCalls()).toBeGreaterThan(0));
    await vi.advanceTimersToNextTimerAsync();
    await vi.waitFor(() =>
      expect(FakeNativeWebSocket.instances).toHaveLength(1),
    );
    const firstProbe = FakeNativeWebSocket.instances[0];
    if (firstProbe === undefined) throw new Error("first probe dial missing");
    firstProbe.fireOpen();
    await vi.waitFor(() =>
      expect(sentFramesOfKind(firstProbe, "open")).toHaveLength(1),
    );
    expect(sentFramesOfKind(firstProbe, "open")[0]?.token).toBe(
      NO_HOST_TOKEN_PROBE,
    );
    firstProbe.fireMessage(invalidSessionGrantRefusal());
    await vi.waitFor(() =>
      expect(
        processReleasedHosts.probeDeclined(
          USER_A,
          CURRENT_HOST_FOR_USER_SWITCH,
        ),
      ).toBe(true),
    );
    first.close();
    await settle();
    FakeNativeWebSocket.instances.length = 0;

    const next = await openInventoryFor({
      hostId: CURRENT_HOST_FOR_USER_SWITCH,
      userId: USER_B,
      signInToken: SIGN_IN_B,
      hostToken: null,
      rowOwnerId: USER_B,
    });
    await vi.waitFor(() => expect(next.mintCalls()).toBeGreaterThan(0));
    await vi.advanceTimersToNextTimerAsync();
    await vi.waitFor(() =>
      expect(FakeNativeWebSocket.instances).toHaveLength(1),
    );
    const nextProbe = FakeNativeWebSocket.instances[0];
    if (nextProbe === undefined) throw new Error("person B probe dial missing");
    nextProbe.fireOpen();
    await vi.waitFor(() =>
      expect(sentFramesOfKind(nextProbe, "open")).toHaveLength(1),
    );
    expect(sentFramesOfKind(nextProbe, "open")[0]?.token).toBe(
      NO_HOST_TOKEN_PROBE,
    );
    nextProbe.fireMessage(ownerSignInRefusal());
    await vi.waitFor(() =>
      expect(FakeNativeWebSocket.instances).toHaveLength(2),
    );
    const invited = FakeNativeWebSocket.instances[1];
    if (invited === undefined) throw new Error("person B sign-in dial missing");
    invited.fireOpen();
    await vi.waitFor(() =>
      expect(sentFramesOfKind(invited, "open")).toHaveLength(1),
    );
    expect(sentFramesOfKind(invited, "open")[0]?.token).toBe(SIGN_IN_B);
    invited.fireMessage(openAckFrame([], null));
    await vi.waitFor(() => expect(next.statuses).toContain("open"));
    expect(sentTokens()).toEqual([NO_HOST_TOKEN_PROBE, SIGN_IN_B]);
    next.close();
  });
});

async function openInventoryFor(input: {
  readonly hostId?: string;
  readonly userId: string;
  readonly signInToken: string;
  readonly hostToken: string | null;
  readonly rowOwnerId: string | null;
}): Promise<{
  readonly statuses: string[];
  readonly mintCalls: () => number;
  readonly close: () => void;
}> {
  const hostId = input.hostId ?? RELEASED_HOST.hostId;
  vi.stubGlobal(
    "fetch",
    async (request: RequestInfo | URL): Promise<Response> => {
      const url = new URL(requestUrl(request));
      if (url.pathname === "/api/v3/hosts") {
        if (input.rowOwnerId === null)
          return new Response("authn unavailable", { status: 503 });
        return new Response(
          JSON.stringify({
            hosts: [
              {
                hostId,
                owner: { kind: "user", id: input.rowOwnerId },
                kind: "personal",
                remoteAccess: false,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("unexpected", { status: 500 });
    },
  );
  const provider = newProvider();
  signIn(provider, input.userId, input.signInToken);
  let mintCalls = 0;
  const hostTokens = createHostTokenSource({
    persistence: createMemoryHostTokenPersistence(),
    mint: () => {
      mintCalls += 1;
      return Promise.resolve({ kind: "unavailable", detail: "authn offline" });
    },
    signIn: (userId) => (userId === input.userId ? input.signInToken : null),
    now: () => Date.now(),
  });
  const websocketUrl = RELEASED_HOST.websocketUrl;
  if (websocketUrl === null) {
    throw new Error("the mock local host has no websocket URL");
  }
  if (input.hostToken !== null) {
    await hostTokens.adopt(
      input.userId,
      hostId,
      { token: input.hostToken, expiresAtMs: Date.now() + 60_000 },
      hostTokens.era(input.userId),
    );
  }
  const endpoint = {
    hostId,
    websocketUrl,
    version: RELEASED_HOST.version,
  };
  const inventoryClient = createLocalHostInventoryStreamClient({
    authnBaseUrl: "https://authn.test",
    hostTokens,
    localHost: () => endpoint,
    bearer: liveBearer(provider),
    appVersion: "1.0.0-test",
  });
  const stream = inventoryClient(endpoint, input.userId);
  if (stream === null)
    throw new Error("local inventory stream client did not build");
  const statuses: string[] = [];
  const inventory = new HostInventoryStreamClient({
    wsStreamClient: stream,
    callbacks: {
      onSnapshot: () => undefined,
      onConnectionStatus: (status) => {
        statuses.push(status);
      },
    },
  });
  const close = (): void => {
    inventory.close();
    stream.close("test complete");
  };
  activeClosers.push(close);
  return {
    statuses,
    mintCalls: () => mintCalls,
    close,
  };
}
