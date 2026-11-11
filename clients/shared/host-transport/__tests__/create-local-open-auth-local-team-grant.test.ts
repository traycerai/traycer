import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemberCredentialHandoff } from "@traycer/protocol/host-transport/mux";
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
import { createLocalOpenAuth } from "../create-local-open-auth";

const HOST_ID = "team-local-provision-host";
const AUTHN_BASE_URL = "https://authn.team-local-provision.invalid";
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

function controlOpenAck(socket: {
  readonly textSent: readonly string[];
}): object {
  const open = socket.textSent
    .map(parseLocalGrantStreamText)
    .find((frame) => frame.kind === "open");
  if (open === undefined) throw new Error("Expected a control OPEN frame");
  return {
    kind: "openAck",
    manifest: open.manifest,
    capabilities: [STREAM_CAPABILITY_HOST_CREDENTIAL_PROVISION],
  };
}

function intakeSnapshot(): object {
  return {
    kind: "snapshot",
    hasBinaryPayload: false,
    entries: [],
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createLocalOpenAuth local grant and member readiness", () => {
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

  it("uses a fresh local-purpose grant for each member probe and sends member credentials before subscribe", async () => {
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
    firstSocket.fireText(controlOpenAck(firstSocket));
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
    await firstSubscribeWait;
    expect(firstProvision).toEqual({
      kind: "hostCredentialProvision",
      ...MEMBER_HANDOFF,
    });
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
    firstSocket.fireText(intakeSnapshot());
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
    secondSocket.fireText(controlOpenAck(secondSocket));
    const secondProvisionWait = secondSocket.waitForFrame(
      (frame) => frame.kind === "hostCredentialProvision",
      undefined,
    );
    const secondSubscribeWait = secondSocket.waitForFrame(
      (frame) => frame.kind === "subscribe",
      undefined,
    );
    const secondProvision = await secondProvisionWait;
    await secondSubscribeWait;
    expect(secondProvision).toEqual({
      kind: "hostCredentialProvision",
      ...MEMBER_HANDOFF,
    });
    expect(onMemberCredentialAdopted).toHaveBeenCalledTimes(1);
    secondSocket.fireText(intakeSnapshot());
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

  it("holds a local data stream until the member credential intake snapshot arrives", async () => {
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
    const session = client.subscribe("host.notifications.feed.subscribe", {
      initialAttentionLimit: 50,
      initialRecentLimit: 50,
    });

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
    controlGrantSocket.fireText(controlOpenAck(controlGrantSocket));
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
    await controlSubscribeWait;
    expect(memberFrame).toEqual({
      kind: "hostCredentialProvision",
      ...MEMBER_HANDOFF,
    });
    expect(sockets).toHaveLength(2);
    expect(onMemberCredentialAdopted).not.toHaveBeenCalled();

    const dataSocketPromise = nextSocket();
    controlGrantSocket.fireText(intakeSnapshot());
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
      manifest: dataOpen.manifest,
      capabilities: [STREAM_CAPABILITY_CREDENTIAL_UPDATE],
    });
    await dataSubscribeWait;
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
