import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemberCredentialHandoff } from "@traycer/protocol/host-transport/mux";
import type { ConnectionManifest } from "@traycer/protocol/framework/ws-protocol";
import { SERVES_EVERY_INSTALLED_MAJOR } from "@traycer/protocol/framework/capability-manifest";
import { buildStreamManifest } from "@traycer/protocol/framework/stream-compat";
import {
  STREAM_CAPABILITY_CREDENTIAL_UPDATE,
  STREAM_CAPABILITY_HOST_CREDENTIAL_PROVISION,
} from "@traycer/protocol/framework/stream-ws-protocol";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { MutableBearerLease } from "../../auth/bearer-source";
import { NO_TRANSPORT_EVIDENCE } from "../../host-selection/transport-evidence";
import { WsStreamClient } from "../ws-stream-client";
import {
  TEAM_MEMBERSHIP_REQUIRED,
  TEAM_MEMBERSHIP_REQUIRED_MESSAGE,
  TEAM_MEMBERSHIP_UNAVAILABLE,
  type LocalSessionGrantProvision,
} from "../local-open-auth";
import { TEST_CLIENT_IDENTITY } from "../../test-fixtures/client-identity";
import {
  createLocalGrantStreamSocketFactory,
  parseLocalGrantStreamText,
} from "./local-team-grant-test-support";
import {
  createLocalOpenAuth,
  type CreateLocalOpenAuthOptions,
} from "../create-local-open-auth";

const HOST_ID = "team-local-provision-host";
const AUTHN_BASE_URL = "https://authn.team-local-provision.invalid";
const ALL_STREAM_METHODS = buildStreamManifest(
  hostStreamRpcRegistry,
  SERVES_EVERY_INSTALLED_MAJOR,
);
const TEAM_HOST_MANIFEST: ConnectionManifest = {
  "worktree.changed": ALL_STREAM_METHODS["worktree.changed"],
};
const PERSONAL_HOST_MANIFEST: ConnectionManifest = {
  ...TEAM_HOST_MANIFEST,
  "host.notifications.subscribe":
    ALL_STREAM_METHODS["host.notifications.subscribe"],
};
const MEMBER_HANDOFF: MemberCredentialHandoff = {
  token: "member-token",
  refreshToken: "member-refresh-token",
  familyId: "member-family",
  provisionedAt: "2026-11-11T00:00:00.000Z",
};

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => {
    throw new Error("deferred promise was not initialized");
  };
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function controlOpenAck(
  socket: {
    readonly textSent: readonly string[];
  },
  manifest: ConnectionManifest,
): object {
  const open = socket.textSent
    .map(parseLocalGrantStreamText)
    .find((frame) => frame.kind === "open");
  if (open === undefined) throw new Error("Expected a control OPEN frame");
  return {
    kind: "openAck",
    manifest,
    capabilities: [STREAM_CAPABILITY_HOST_CREDENTIAL_PROVISION],
  };
}

function worktreeCatchup(generation: number): object {
  return {
    kind: "changed",
    scope: { kind: "root", root: "worktrees" },
    cursor: { epoch: "test-host-epoch", generation },
    hasBinaryPayload: false,
  };
}

function grantRequired(): object {
  return {
    kind: "fatalError",
    details: {
      code: "SESSION_GRANT_REQUIRED",
      reason: "session grant required",
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  };
}

function membershipRequired(): object {
  return {
    kind: "fatalError",
    details: {
      code: TEAM_MEMBERSHIP_REQUIRED,
      reason: TEAM_MEMBERSHIP_REQUIRED_MESSAGE,
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  };
}

function membershipUnavailable(): object {
  return {
    kind: "fatalError",
    details: {
      code: TEAM_MEMBERSHIP_UNAVAILABLE,
      reason: "Team membership could not be checked",
      incompatibleMethods: null,
      upgradeGuidance: null,
      retryable: true,
    },
  };
}

function beginFactoryProbe(
  mintMemberCredential: CreateLocalOpenAuthOptions["mintMemberCredential"],
) {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        grant: "attach-grant-control",
        role: "client",
        expires_in: 60,
        session_grant: "local-session-grant-control",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  );
  const { factory, sockets, nextSocket } =
    createLocalGrantStreamSocketFactory();
  const onMemberCredentialAdopted = vi.fn();
  const auth = createLocalOpenAuth({
    authnBaseUrl: AUTHN_BASE_URL,
    cloudAuthorized: () => true,
    webSocketFactory: factory,
    clientIdentity: TEST_CLIENT_IDENTITY,
    clock: null,
    mintMemberCredential,
    onMemberCredentialAdopted,
  });
  const endpoint = {
    hostId: HOST_ID,
    websocketUrl: "ws://127.0.0.1:4917/rpc",
  };
  const bearer = new MutableBearerLease("user-bearer", "team-member-test-user");
  const abortController = new AbortController();
  auth.noteSessionGrantRequired(HOST_ID);
  const socketPromise = nextSocket();
  const readiness = auth.ensureMemberReady(
    endpoint,
    bearer,
    abortController.signal,
  );
  return {
    abortController,
    bearer,
    mintMemberCredential,
    onMemberCredentialAdopted,
    readiness,
    socketPromise,
    sockets,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createLocalOpenAuth local grant and member readiness", () => {
  it("keeps a control-stream team-membership refusal terminal", async () => {
    const mintMemberCredential = vi.fn(() => Promise.resolve(MEMBER_HANDOFF));
    const probe = beginFactoryProbe(mintMemberCredential);
    const socket = await probe.socketPromise;
    const openWait = socket.waitForFrame(
      (frame) => frame.kind === "open",
      undefined,
    );
    socket.fireOpen();
    const open = await openWait;
    expect(open.token).toBe("local-session-grant-control");

    socket.fireText(membershipRequired());

    await expect(probe.readiness).resolves.toMatchObject({
      kind: "refused",
      fatal: {
        code: TEAM_MEMBERSHIP_REQUIRED,
        reason: TEAM_MEMBERSHIP_REQUIRED_MESSAGE,
      },
    });
    expect(mintMemberCredential).not.toHaveBeenCalled();
    expect(probe.onMemberCredentialAdopted).not.toHaveBeenCalled();
    expect(probe.sockets).toHaveLength(1);
    expect(
      socket.textSent
        .map(parseLocalGrantStreamText)
        .some(
          (frame) =>
            frame.kind === "hostCredentialProvision" ||
            frame.kind === "subscribe",
        ),
    ).toBe(false);
  });

  it("keeps a retryable team-membership control error unavailable", async () => {
    const mintMemberCredential = vi.fn(() => Promise.resolve(MEMBER_HANDOFF));
    const probe = beginFactoryProbe(mintMemberCredential);
    const socket = await probe.socketPromise;
    const openWait = socket.waitForFrame(
      (frame) => frame.kind === "open",
      undefined,
    );
    socket.fireOpen();
    const open = await openWait;
    expect(open.token).toBe("local-session-grant-control");

    socket.fireText(membershipUnavailable());

    await expect(probe.readiness).resolves.toMatchObject({
      kind: "unavailable",
      retryCause: { code: TEAM_MEMBERSHIP_UNAVAILABLE, retryable: true },
    });
    expect(mintMemberCredential).not.toHaveBeenCalled();
    expect(probe.onMemberCredentialAdopted).not.toHaveBeenCalled();
    expect(probe.sockets).toHaveLength(1);
    expect(
      socket.textSent
        .map(parseLocalGrantStreamText)
        .some(
          (frame) =>
            frame.kind === "hostCredentialProvision" ||
            frame.kind === "subscribe",
        ),
    ).toBe(false);
  });

  it("keeps a null member credential mint unavailable without opening a data stream", async () => {
    const mintMemberCredential = vi.fn(() => Promise.resolve(null));
    const probe = beginFactoryProbe(mintMemberCredential);
    const socket = await probe.socketPromise;
    const openWait = socket.waitForFrame(
      (frame) => frame.kind === "open",
      undefined,
    );
    socket.fireOpen();
    const open = await openWait;
    expect(open.token).toBe("local-session-grant-control");
    socket.fireText(controlOpenAck(socket, TEAM_HOST_MANIFEST));

    await expect(probe.readiness).resolves.toMatchObject({
      kind: "unavailable",
      retryCause: { code: TEAM_MEMBERSHIP_UNAVAILABLE, retryable: true },
    });
    expect(mintMemberCredential).toHaveBeenCalledExactlyOnceWith(
      HOST_ID,
      probe.bearer,
      expect.any(AbortSignal),
    );
    expect(probe.onMemberCredentialAdopted).not.toHaveBeenCalled();
    expect(probe.sockets).toHaveLength(1);
    expect(
      socket.textSent
        .map(parseLocalGrantStreamText)
        .some(
          (frame) =>
            frame.kind === "hostCredentialProvision" ||
            frame.kind === "subscribe",
        ),
    ).toBe(false);
  });

  it("does not treat a changed frame before member handoff as readiness", async () => {
    const memberMintStarted = deferred<void>();
    const memberMintResult = deferred<MemberCredentialHandoff | null>();
    const mintMemberCredential = vi.fn(() => {
      memberMintStarted.resolve();
      return memberMintResult.promise;
    });
    const probe = beginFactoryProbe(mintMemberCredential);
    const socket = await probe.socketPromise;
    const openWait = socket.waitForFrame(
      (frame) => frame.kind === "open",
      undefined,
    );
    socket.fireOpen();
    const open = await openWait;
    expect(open.token).toBe("local-session-grant-control");
    socket.fireText(controlOpenAck(socket, TEAM_HOST_MANIFEST));
    await memberMintStarted.promise;

    socket.fireText(worktreeCatchup(1));
    expect(probe.onMemberCredentialAdopted).not.toHaveBeenCalled();

    probe.abortController.abort();
    memberMintResult.resolve(null);
    await expect(probe.readiness).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(probe.onMemberCredentialAdopted).not.toHaveBeenCalled();
    expect(mintMemberCredential).toHaveBeenCalledExactlyOnceWith(
      HOST_ID,
      probe.bearer,
      expect.any(AbortSignal),
    );
  });

  it("treats an attach-grant 404 as terminal membership refusal and a 503 as retryable", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: "team_membership_required" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: "upstream_unavailable" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }),
      );
    const auth = createLocalOpenAuth({
      authnBaseUrl: AUTHN_BASE_URL,
      cloudAuthorized: () => true,
      webSocketFactory: createLocalGrantStreamSocketFactory().factory,
      clientIdentity: TEST_CLIENT_IDENTITY,
      clock: null,
      mintMemberCredential: async () => null,
      onMemberCredentialAdopted: () => undefined,
    });
    const bearer = new MutableBearerLease(
      "user-bearer",
      "team-member-test-user",
    );
    const signal = new AbortController().signal;

    const nonmember: LocalSessionGrantProvision = await auth.mint(
      HOST_ID,
      bearer,
      signal,
    );
    expect(nonmember).toMatchObject({
      kind: "refused",
      fatal: {
        code: TEAM_MEMBERSHIP_REQUIRED,
        reason: TEAM_MEMBERSHIP_REQUIRED_MESSAGE,
      },
    });

    const cachedNonmember = await auth.mint(HOST_ID, bearer, signal);
    expect(cachedNonmember).toEqual(nonmember);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const outage: LocalSessionGrantProvision = await auth.mint(
      HOST_ID,
      new MutableBearerLease(
        "another-user-bearer",
        "another-team-member-test-user",
      ),
      signal,
    );
    expect(outage).toMatchObject({
      kind: "unavailable",
      retryCause: { code: TEAM_MEMBERSHIP_UNAVAILABLE, retryable: true },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses worktree catch-up as the member fence with fresh grants for team and personal manifests", async () => {
    let grantSequence = 0;
    const fetchCalls: Array<{ readonly body: string; readonly url: string }> =
      [];
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const current = ++grantSequence;
        fetchCalls.push({ body: String(init?.body), url: String(input) });
        return new Response(
          JSON.stringify({
            grant: `attach-grant-${current}`,
            role: "client",
            expires_in: 60,
            session_grant: `local-session-grant-${current}`,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });
    const { factory, nextSocket } = createLocalGrantStreamSocketFactory();
    const memberMintStarted = deferred<void>();
    const memberMintResult = deferred<MemberCredentialHandoff | null>();
    const mintMemberCredential = vi.fn(() => {
      memberMintStarted.resolve();
      return memberMintResult.promise;
    });
    const onMemberCredentialAdopted = vi.fn();
    const auth = createLocalOpenAuth({
      authnBaseUrl: AUTHN_BASE_URL,
      cloudAuthorized: () => true,
      webSocketFactory: factory,
      clientIdentity: TEST_CLIENT_IDENTITY,
      clock: null,
      mintMemberCredential,
      onMemberCredentialAdopted,
    });
    const endpoint = {
      hostId: HOST_ID,
      websocketUrl: "ws://127.0.0.1:4917/rpc",
    };
    const bearer = new MutableBearerLease(
      "user-bearer",
      "team-member-test-user",
    );
    auth.noteSessionGrantRequired(HOST_ID);

    const firstSocketPromise = nextSocket();
    const firstReadiness = auth.ensureMemberReady(
      endpoint,
      bearer,
      new AbortController().signal,
    );
    const firstSocket = await firstSocketPromise;
    const firstOpenWait = firstSocket.waitForFrame(
      (frame) => frame.kind === "open",
      undefined,
    );
    firstSocket.fireOpen();
    const firstOpen = await firstOpenWait;
    expect(firstOpen.token).toBe("local-session-grant-1");
    expect(TEAM_HOST_MANIFEST).not.toHaveProperty(
      "host.notifications.subscribe",
    );
    expect(TEAM_HOST_MANIFEST["worktree.changed"]).toBeDefined();
    firstSocket.fireText(controlOpenAck(firstSocket, TEAM_HOST_MANIFEST));
    await memberMintStarted.promise;
    expect(
      firstSocket.textSent
        .map(parseLocalGrantStreamText)
        .some((frame) => frame.kind === "subscribe"),
    ).toBe(false);

    const firstProvisionWait = firstSocket.waitForFrame(
      (frame) => frame.kind === "hostCredentialProvision",
      undefined,
    );
    const firstSubscribeWait = firstSocket.waitForFrame(
      (frame) => frame.kind === "subscribe",
      undefined,
    );
    memberMintResult.resolve(MEMBER_HANDOFF);
    const firstProvision = await firstProvisionWait;
    const firstSubscribe = await firstSubscribeWait;
    expect(firstProvision).toEqual({
      kind: "hostCredentialProvision",
      ...MEMBER_HANDOFF,
    });
    expect(firstSubscribe).toMatchObject({
      kind: "subscribe",
      method: "worktree.changed",
      params: {},
    });
    expect(firstSubscribe.params).toEqual({});
    expect(
      firstSocket.textSent.findIndex(
        (raw) =>
          parseLocalGrantStreamText(raw).kind === "hostCredentialProvision",
      ),
    ).toBeLessThan(
      firstSocket.textSent.findIndex(
        (raw) => parseLocalGrantStreamText(raw).kind === "subscribe",
      ),
    );
    expect(onMemberCredentialAdopted).not.toHaveBeenCalled();
    firstSocket.fireText(worktreeCatchup(2));
    await expect(firstReadiness).resolves.toEqual({ kind: "ready" });
    expect(onMemberCredentialAdopted).toHaveBeenCalledExactlyOnceWith(
      HOST_ID,
      MEMBER_HANDOFF,
    );

    const secondSocketPromise = nextSocket();
    const secondReadiness = auth.ensureMemberReady(
      endpoint,
      bearer,
      new AbortController().signal,
    );
    const secondSocket = await secondSocketPromise;
    const secondOpenWait = secondSocket.waitForFrame(
      (frame) => frame.kind === "open",
      undefined,
    );
    secondSocket.fireOpen();
    const secondOpen = await secondOpenWait;
    expect(secondOpen.token).toBe("local-session-grant-2");
    expect(PERSONAL_HOST_MANIFEST).toHaveProperty(
      "host.notifications.subscribe",
    );
    expect(PERSONAL_HOST_MANIFEST).toHaveProperty("worktree.changed");
    secondSocket.fireText(controlOpenAck(secondSocket, PERSONAL_HOST_MANIFEST));
    const secondProvisionWait = secondSocket.waitForFrame(
      (frame) => frame.kind === "hostCredentialProvision",
      undefined,
    );
    const secondSubscribeWait = secondSocket.waitForFrame(
      (frame) => frame.kind === "subscribe",
      undefined,
    );
    const secondProvision = await secondProvisionWait;
    const secondSubscribe = await secondSubscribeWait;
    expect(secondProvision).toEqual({
      kind: "hostCredentialProvision",
      ...MEMBER_HANDOFF,
    });
    expect(secondSubscribe).toMatchObject({
      kind: "subscribe",
      method: "worktree.changed",
      params: {},
    });
    expect(secondSubscribe.params).toEqual({});
    expect(onMemberCredentialAdopted).toHaveBeenCalledTimes(1);
    secondSocket.fireText(worktreeCatchup(3));
    await expect(secondReadiness).resolves.toEqual({ kind: "ready" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchCalls.map(({ body }) => JSON.parse(body))).toEqual([
      { role: "client", purpose: "local" },
      { role: "client", purpose: "local" },
    ]);
    expect(fetchCalls.map(({ url }) => url)).toEqual([
      `${AUTHN_BASE_URL}/api/v3/hosts/${HOST_ID}/attach-grant`,
      `${AUTHN_BASE_URL}/api/v3/hosts/${HOST_ID}/attach-grant`,
    ]);
    expect(mintMemberCredential).toHaveBeenCalledTimes(2);
    expect(onMemberCredentialAdopted).toHaveBeenCalledTimes(2);
  });

  it("opens a local worktree data stream with a fresh grant after member catch-up", async () => {
    let grantSequence = 0;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => {
        const current = ++grantSequence;
        return new Response(
          JSON.stringify({
            grant: `attach-grant-${current}`,
            role: "client",
            expires_in: 60,
            session_grant: `local-session-grant-${current}`,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });
    const { factory, sockets, nextSocket } =
      createLocalGrantStreamSocketFactory();
    const memberMintStarted = deferred<void>();
    const memberMintResult = deferred<MemberCredentialHandoff | null>();
    const mintMemberCredential = vi.fn(() => {
      memberMintStarted.resolve();
      return memberMintResult.promise;
    });
    const onMemberCredentialAdopted = vi.fn();
    const auth = createLocalOpenAuth({
      authnBaseUrl: AUTHN_BASE_URL,
      cloudAuthorized: () => true,
      webSocketFactory: factory,
      clientIdentity: TEST_CLIENT_IDENTITY,
      clock: null,
      mintMemberCredential,
      onMemberCredentialAdopted,
    });
    const endpoint = {
      hostId: HOST_ID,
      websocketUrl: "ws://127.0.0.1:4917/rpc",
    };
    const bearer = new MutableBearerLease(
      "user-bearer",
      "team-member-test-user",
    );
    const client = new WsStreamClient({
      clientIdentity: TEST_CLIENT_IDENTITY,
      registry: hostStreamRpcRegistry,
      hostId: HOST_ID,
      userId: bearer.identity.userId,
      endpoint: () => endpoint,
      bearer: () => bearer,
      localOpenAuth: auth,
      auth: null,
      clock: null,
      hostCredentialMint: null,
      onHostCredentialState: null,
      evidence: NO_TRANSPORT_EVIDENCE,
      webSocketFactory: factory,
      dialTimeoutMs: 1000,
      openAckTimeoutMs: 1000,
      pingIntervalMs: 25_000,
      pongTimeoutMs: 50_000,
      initialBackoffMs: 10,
      maxBackoffMs: 100,
    });
    const firstSocketPromise = nextSocket();
    const session = client.subscribe("worktree.changed", {});

    const userSocket = await firstSocketPromise;
    const userOpenWait = userSocket.waitForFrame(
      (frame) => frame.kind === "open",
      undefined,
    );
    userSocket.fireOpen();
    const userOpen = await userOpenWait;
    expect(userOpen.token).toBe("user-bearer");

    const controlGrantSocketPromise = nextSocket();
    userSocket.fireText(grantRequired());
    const controlGrantSocket = await controlGrantSocketPromise;
    const controlOpenWait = controlGrantSocket.waitForFrame(
      (frame) => frame.kind === "open",
      undefined,
    );
    controlGrantSocket.fireOpen();
    const controlOpen = await controlOpenWait;
    expect(controlOpen.token).toBe("local-session-grant-1");
    controlGrantSocket.fireText(
      controlOpenAck(controlGrantSocket, TEAM_HOST_MANIFEST),
    );
    await memberMintStarted.promise;

    const memberFrameWait = controlGrantSocket.waitForFrame(
      (frame) => frame.kind === "hostCredentialProvision",
      undefined,
    );
    const controlSubscribeWait = controlGrantSocket.waitForFrame(
      (frame) => frame.kind === "subscribe",
      undefined,
    );
    memberMintResult.resolve(MEMBER_HANDOFF);
    const memberFrame = await memberFrameWait;
    const controlSubscribe = await controlSubscribeWait;
    expect(memberFrame).toEqual({
      kind: "hostCredentialProvision",
      ...MEMBER_HANDOFF,
    });
    expect(controlSubscribe).toMatchObject({
      kind: "subscribe",
      method: "worktree.changed",
      params: {},
    });
    expect(controlSubscribe.params).toEqual({});
    expect(sockets).toHaveLength(2);
    expect(onMemberCredentialAdopted).not.toHaveBeenCalled();

    const dataSocketPromise = nextSocket();
    controlGrantSocket.fireText(worktreeCatchup(2));
    expect(onMemberCredentialAdopted).toHaveBeenCalledExactlyOnceWith(
      HOST_ID,
      MEMBER_HANDOFF,
    );
    const dataSocket = await dataSocketPromise;
    const dataOpenWait = dataSocket.waitForFrame(
      (frame) => frame.kind === "open",
      undefined,
    );
    dataSocket.fireOpen();
    const dataOpen = await dataOpenWait;
    expect(dataOpen.token).toBe("local-session-grant-2");
    const dataSubscribeWait = dataSocket.waitForFrame(
      (frame) => frame.kind === "subscribe",
      undefined,
    );
    dataSocket.fireText({
      kind: "openAck",
      manifest: TEAM_HOST_MANIFEST,
      capabilities: [STREAM_CAPABILITY_CREDENTIAL_UPDATE],
    });
    const dataSubscribe = await dataSubscribeWait;
    expect(dataSubscribe).toMatchObject({
      kind: "subscribe",
      method: "worktree.changed",
      params: {},
    });
    expect(dataSubscribe.params).toEqual({});
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mintMemberCredential).toHaveBeenCalledExactlyOnceWith(
      HOST_ID,
      bearer,
      expect.any(AbortSignal),
    );

    session.close();
    client.close("test-teardown");
  });
});
