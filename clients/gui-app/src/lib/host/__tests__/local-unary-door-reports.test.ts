import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { RevalidateOutcome } from "@traycer-clients/shared/auth/bearer-revalidator";
import { MutableBearerLease } from "@traycer-clients/shared/auth/bearer-source";
import {
  createHostTokenSource,
  createMemoryHostTokenPersistence,
  type HostTokenMintOutcome,
  type HostTokenSource,
} from "@traycer-clients/shared/auth/host-token-source";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { processReleasedHosts } from "@traycer-clients/shared/host-transport/released-sign-on";
import {
  FakeNativeWebSocket,
  liveBearer,
  newProvider,
  openAckFrame,
  sentTokens,
  signIn,
  USER_A,
} from "@traycer-clients/shared/test-fixtures/dial-gate-harness";
import { NO_HOST_TOKEN_PROBE } from "@traycer/protocol/framework/door-reason";
import {
  defineRpcContract,
  defineVersionedRpcRegistry,
  UNARY_CAPABILITY_PERSISTENT_SESSION,
} from "@traycer/protocol/framework/index";
import type { HostOwnerPrincipal } from "@traycer/protocol/host/host-status";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { LocalHostSnapshot } from "@traycer-clients/shared/platform/runner-host";
import { HostDirectoryService } from "@/lib/host/host-directory-service";
import { lastLocalHostIdKey } from "@/lib/persist";
import { buildHostStreamClient } from "@/hooks/host/use-host-stream-client-for";
import { buildRuntimeHostMessenger } from "@/lib/host/host-messenger";
import {
  clearHostDoorState,
  hostDoorStateFor,
} from "@/stores/host/host-door-state-store";

const SIGN_IN_TOKEN = "sign-in-token";
const HOST_TOKEN = "held-host-token";
function fieldOf(value: object, key: string): unknown {
  const found: unknown = Reflect.get(value, key);
  return found;
}

function frameOf(raw: string): object {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null)
    throw new Error("the frame was not an object");
  return parsed;
}

const NO_HOST_TOKEN_MESSAGE = "No host-only token is held for this host";

const echoV10 = defineRpcContract({
  method: "host.echo",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({ message: z.string() }),
  responseSchema: z.object({ echoed: z.string() }),
});

const registry = defineVersionedRpcRegistry({
  "host.echo": {
    1: {
      latestMinor: 0,
      versions: {
        0: { contract: echoV10, upgradeFromPreviousVersion: null },
      },
      downgradePathsFromLatest: {},
    },
  },
});

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

function notAdmittedRefusal(): string {
  return JSON.stringify({
    kind: "fatalError",
    details: {
      code: "UNAUTHORIZED",
      reason: "current-host-refusal",
      doorReason: "not_admitted",
      retryable: false,
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  });
}

function membershipRemovedRefusal(): string {
  return JSON.stringify({
    kind: "fatalError",
    details: {
      code: "UNAUTHORIZED",
      reason: "current-host-refusal",
      doorReason: "membership_removed",
      retryable: false,
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  });
}

function entryFor(
  hostId: string,
  owner: HostOwnerPrincipal,
): HostDirectoryEntry {
  return { ...mockLocalHostEntry, hostId, owner };
}

type CallOutcome =
  | { readonly kind: "fulfilled"; readonly value: { readonly echoed: string } }
  | { readonly kind: "rejected"; readonly error: unknown };

interface Driven {
  readonly hostId: string;
  readonly call: Promise<CallOutcome>;
  readonly settled: () => boolean;
  readonly dispose: () => void;
}

/** The app's real runtime messenger, one `host.echo` call to `entry`'s local host. */
function startCall(
  entry: HostDirectoryEntry,
  hostTokens: HostTokenSource,
  recovery: {
    readonly revalidateForReconnect: () => Promise<RevalidateOutcome>;
  } | null,
): Driven {
  let issued = 0;
  const binding = buildRuntimeHostMessenger({
    confirmRowBeforeSignIn: () => Promise.resolve(true),
    registry,
    resolveTarget: (hostId) => (hostId === entry.hostId ? entry : null),
    auth: recovery,
    authnBaseUrl: "https://authn.test",
    hostTokens,
    requestId: () => {
      issued += 1;
      return `req-${issued}`;
    },
    onRemoteAvailabilityRecovered: () => undefined,
    onRemoteSessionTerminal: () => undefined,
  });
  let settledNow = false;
  const call = binding.messenger
    .request(
      "host.echo",
      { message: "hi" },
      {
        idempotencyKey: null,
        replayMustBeKeyed: false,
        requiredHostMethodVersion: null,
        authority: {
          endpoint: {
            hostId: entry.hostId,
            websocketUrl: entry.websocketUrl ?? "",
          },
          bearer: new MutableBearerLease(SIGN_IN_TOKEN, USER_A),
          abortSignal: new AbortController().signal,
        },
      },
    )
    .then(
      (value): CallOutcome => ({ kind: "fulfilled", value }),
      (error: unknown): CallOutcome => ({ kind: "rejected", error }),
    );
  void call.then(() => {
    settledNow = true;
  });
  return {
    hostId: entry.hostId,
    call,
    settled: () => settledNow,
    dispose: () => {
      binding.dispose();
    },
  };
}

async function heldTokenSource(hostId: string): Promise<HostTokenSource> {
  const source = createHostTokenSource({
    persistence: createMemoryHostTokenPersistence(),
    mint: () => Promise.resolve({ kind: "no-sign-in" }),
    signIn: null,
    now: () => Date.now(),
  });
  await source.adopt(
    USER_A,
    hostId,
    { token: HOST_TOKEN, expiresAtMs: Date.now() + 3_600_000 },
    source.era(USER_A),
    () => true,
  );
  return source;
}

/** A mint authn answers only when the test says so; every later mint gets that same answer. */
function heldMints(): {
  readonly source: HostTokenSource;
  readonly answer: (outcome: HostTokenMintOutcome) => void;
  readonly asked: () => number;
} {
  const pending: Array<(outcome: HostTokenMintOutcome) => void> = [];
  let answered: HostTokenMintOutcome | null = null;
  const source = createHostTokenSource({
    persistence: createMemoryHostTokenPersistence(),
    mint: () => {
      if (answered !== null) return Promise.resolve(answered);
      return new Promise<HostTokenMintOutcome>((resolve) => {
        pending.push(resolve);
      });
    },
    signIn: (userId) => (userId === USER_A ? SIGN_IN_TOKEN : null),
    now: () => Date.now(),
  });
  return {
    source,
    asked: () => pending.length,
    answer: (outcome) => {
      answered = outcome;
      for (const resolve of pending) resolve(outcome);
    },
  };
}

/** Opens the dial at `index` and answers its OPEN with `frame`; returns the OPEN's token. */
async function answerDial(
  index: number,
  frame: string | null,
): Promise<unknown> {
  await vi.waitFor(() =>
    expect(FakeNativeWebSocket.instances.length).toBeGreaterThan(index),
  );
  const socket = FakeNativeWebSocket.instances[index];
  socket.fireOpen();
  await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(0));
  const open: unknown = JSON.parse(socket.sent[0]);
  if (frame !== null) socket.fireMessage(frame);
  if (typeof open !== "object" || open === null || !("token" in open))
    throw new Error("the dial sent no OPEN");
  return open.token;
}

function echoReply(socket: FakeNativeWebSocket): void {
  const open: unknown = JSON.parse(socket.sent[0]);
  if (typeof open !== "object" || open === null)
    throw new Error("the dial sent no OPEN");
  socket.fireMessage(
    JSON.stringify({
      kind: "openAck",
      manifest: fieldOf(open, "manifest"),
      optionalManifest: fieldOf(open, "optionalManifest"),
    }),
  );
}

describe("a unary call's reports to the app's door", () => {
  const disposers: Array<() => void> = [];
  const hostIds = new Set<string>();

  beforeEach(() => {
    vi.stubGlobal("WebSocket", FakeNativeWebSocket);
    FakeNativeWebSocket.instances.length = 0;
    processReleasedHosts.forgetAll();
  });

  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
    for (const socket of FakeNativeWebSocket.instances)
      socket.fireClose(1006, "test teardown");
    for (const hostId of hostIds) clearHostDoorState(hostId);
    hostIds.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function begin(
    entry: HostDirectoryEntry,
    tokens: HostTokenSource,
    recovery: {
      readonly revalidateForReconnect: () => Promise<RevalidateOutcome>;
    } | null,
  ): Driven {
    hostIds.add(entry.hostId);
    clearHostDoorState(entry.hostId);
    const driven = startCall(entry, tokens, recovery);
    disposers.push(driven.dispose);
    return driven;
  }

  const personal = (hostId: string): HostDirectoryEntry =>
    entryFor(hostId, { kind: "user", id: USER_A });
  const team = (hostId: string): HostDirectoryEntry =>
    entryFor(hostId, { kind: "team", id: "team-a", name: "Alpha" });

  describe("with a released personal host that refuses the sign-in too", () => {
    it("raises no 'Host update needed' state when the resend after a refresh that changed nothing is refused bare again", async () => {
      const hostId = "unary-door-bare-resend";
      const driven = begin(personal(hostId), await heldTokenSource(hostId), {
        revalidateForReconnect: () => Promise.resolve("rotated"),
      });
      expect(await answerDial(0, releasedRefusal())).toBe(HOST_TOKEN);
      expect(await answerDial(1, releasedRefusal())).toBe(SIGN_IN_TOKEN);
      expect(await answerDial(2, releasedRefusal())).toBe(SIGN_IN_TOKEN);
      expect(await driven.call).toMatchObject({ kind: "rejected" });
      expect(hostDoorStateFor(hostId)).toBeNull();
    });

    it.each(
      RELEASED_HOST_REASONS.flatMap((reason) =>
        (["rejected", "local-plane-retained", null] as const).map(
          (recovery) => ({ reason, recovery }),
        ),
      ),
    )(
      "raises no state and fails the call with the host's reason $reason when the sign-in is refused bare and the recovery is $recovery",
      async ({ reason, recovery }) => {
        const hostId = `unary-door-sign-in-refused-${recovery ?? "absent"}-${RELEASED_HOST_REASONS.indexOf(reason)}`;
        const driven = begin(
          personal(hostId),
          await heldTokenSource(hostId),
          recovery === null
            ? null
            : { revalidateForReconnect: () => Promise.resolve(recovery) },
        );
        expect(await answerDial(0, releasedRefusal())).toBe(HOST_TOKEN);
        expect(await answerDial(1, releasedRefusalSaying(reason))).toBe(
          SIGN_IN_TOKEN,
        );
        const outcome = await driven.call;
        expect(outcome).toMatchObject({ kind: "rejected" });
        expect(String(fieldOf(outcome, "error"))).toContain(reason);
        expect(hostDoorStateFor(hostId)).toBeNull();
      },
    );

    it("raises the older-host state when a team computer's host-only token is refused bare and no sign-in can follow", async () => {
      const hostId = "unary-door-team-row-bare";
      const driven = begin(team(hostId), await heldTokenSource(hostId), {
        revalidateForReconnect: () => Promise.resolve("rotated"),
      });
      expect(await answerDial(0, releasedRefusal())).toBe(HOST_TOKEN);
      expect(await driven.call).toMatchObject({ kind: "rejected" });
      expect(hostDoorStateFor(hostId)?.kind).toBe("older-host");
      expect(FakeNativeWebSocket.instances).toHaveLength(1);
    });

    it("raises no state when the refresh answers rejected while the app's stream to the host is admitted", async () => {
      const hostId = "unary-door-stream-admitted";
      const tokens = await heldTokenSource(hostId);
      const answers: Array<(outcome: RevalidateOutcome) => void> = [];
      const driven = begin(personal(hostId), tokens, {
        revalidateForReconnect: () =>
          new Promise<RevalidateOutcome>((resolve) => {
            answers.push(resolve);
          }),
      });
      await answerDial(0, releasedRefusal());
      await answerDial(1, releasedRefusal());
      await vi.waitFor(() => expect(answers).toHaveLength(1));

      // The app's stream to the same host is admitted while the refresh runs.
      const provider = newProvider();
      signIn(provider, USER_A, SIGN_IN_TOKEN);
      const target = personal(hostId);
      const stream = buildHostStreamClient({
        target,
        endpoint: () =>
          target.websocketUrl === null
            ? null
            : { hostId, websocketUrl: target.websocketUrl },
        bearer: liveBearer(provider),
        cloudAuthorized: () => true,
        authnBaseUrl: "https://authn.test",
        auth: null,
        hostTokens: tokens,
        userId: USER_A,
        proactiveWakeEligible: false,
        autoStart: false,
      });
      if (stream === null) throw new Error("local stream client did not build");
      const session = stream.subscribe("epic.subscribe", { epicId: "epic-a" });
      // Registered before the dial is answered, so the admission cannot be missed.
      const admitted = new Promise<void>((resolve) => {
        session.onStatusChange((status) => {
          if (status === "open") resolve();
        });
      });
      disposers.push(() => {
        session.close();
        stream.close("test teardown");
      });
      await answerDial(2, openAckFrame([], null));
      await admitted;

      answers[0]("rejected");
      expect(await driven.call).toMatchObject({ kind: "rejected" });
      expect(hostDoorStateFor(hostId)).toBeNull();
    });
  });

  describe("on a current local team computer with no host-only token held", () => {
    it("probes at once, waits for the slow mint after the host names its refusal, and completes on the minted token with no frame carrying the sign-in", async () => {
      vi.useFakeTimers();
      const hostId = "unary-door-team-slow-mint";
      const mints = heldMints();
      const driven = begin(team(hostId), mints.source, null);
      // The mint has not answered, and the call has already dialed its probe.
      expect(await answerDial(0, notAdmittedRefusal())).toBe(
        NO_HOST_TOKEN_PROBE,
      );
      await vi.advanceTimersByTimeAsync(0);
      // The probe refusal has been processed; the held mint still owns recovery.
      expect(mints.asked()).toBeGreaterThanOrEqual(1);
      expect(driven.settled()).toBe(false);

      const minted = "team-host-token-after-slow-mint";
      mints.answer({
        kind: "ok",
        token: { token: minted, expiresAtMs: Date.now() + 60_000 },
      });
      expect(await answerDial(1, null)).toBe(minted);
      echoReply(FakeNativeWebSocket.instances[1]);
      await vi.waitFor(() =>
        expect(FakeNativeWebSocket.instances[1].sent.length).toBeGreaterThan(1),
      );
      const request: unknown = JSON.parse(
        FakeNativeWebSocket.instances[1].sent[1],
      );
      if (typeof request !== "object" || request === null)
        throw new Error("the dial sent no request");
      FakeNativeWebSocket.instances[1].fireMessage(
        JSON.stringify({
          kind: "response",
          requestId: fieldOf(request, "requestId"),
          method: fieldOf(request, "method"),
          schemaVersion: fieldOf(request, "schemaVersion"),
          result: { echoed: "hi" },
          error: null,
        }),
      );
      expect(await driven.call).toEqual({
        kind: "fulfilled",
        value: { echoed: "hi" },
      });
      expect(sentTokens()).not.toContain(SIGN_IN_TOKEN);
    });

    it("ends a non-member's call with the same refusal sentence as before (guard)", async () => {
      const hostId = "unary-door-team-non-member";
      const mints = heldMints();
      const driven = begin(team(hostId), mints.source, null);
      await vi.waitFor(() => expect(mints.asked()).toBeGreaterThanOrEqual(1));
      mints.answer({ kind: "not-a-member" });
      await vi.waitFor(() =>
        expect(
          driven.settled() || FakeNativeWebSocket.instances.length > 0,
        ).toBe(true),
      );
      if (FakeNativeWebSocket.instances.length > 0)
        await answerDial(0, notAdmittedRefusal());
      const outcome = await driven.call;
      if (outcome.kind !== "rejected") throw new Error("call was admitted");
      expect(outcome.error).toHaveProperty("message", NO_HOST_TOKEN_MESSAGE);
      expect(sentTokens()).not.toContain(SIGN_IN_TOKEN);
    });
  });

  describe("an answer from a host process that was since replaced", () => {
    it("starts no revalidation and raises no state when it refuses the held token as not admitted", async () => {
      const hostId = "unary-stale-not-admitted";
      processReleasedHosts.observeInstance(hostId, "100");
      const mints = heldMints();
      await mints.source.adopt(
        USER_A,
        hostId,
        { token: HOST_TOKEN, expiresAtMs: Date.now() + 3_600_000 },
        mints.source.era(USER_A),
        () => true,
      );
      let revalidations = 0;
      const driven = begin(personal(hostId), mints.source, {
        revalidateForReconnect: () => {
          revalidations += 1;
          return Promise.resolve("rotated");
        },
      });
      expect(await answerDial(0, null)).toBe(HOST_TOKEN);
      processReleasedHosts.observeInstance(hostId, "200");
      FakeNativeWebSocket.instances[0].fireMessage(notAdmittedRefusal());
      await vi.waitFor(() =>
        expect(
          driven.settled() || FakeNativeWebSocket.instances.length > 1,
        ).toBe(true),
      );
      expect(revalidations).toBe(0);
      expect(mints.asked()).toBe(0);
      expect(hostDoorStateFor(hostId)).toBeNull();
      expect(FakeNativeWebSocket.instances.length).toBeGreaterThan(1);
      expect(driven.settled()).toBe(false);
    });

    it("never hides the replacement's refusal behind a connection its predecessor was admitted on and never closed", async () => {
      const hostId = "unary-stale-admission";
      processReleasedHosts.observeInstance(hostId, "100");
      const first = begin(
        personal(hostId),
        await heldTokenSource(hostId),
        null,
      );
      expect(await answerDial(0, null)).toBe(HOST_TOKEN);
      const predecessor = FakeNativeWebSocket.instances[0];
      const open = frameOf(predecessor.sent[0]);
      predecessor.fireMessage(
        JSON.stringify({
          kind: "openAck",
          manifest: fieldOf(open, "manifest"),
          optionalManifest: fieldOf(open, "optionalManifest"),
          capabilities: [UNARY_CAPABILITY_PERSISTENT_SESSION],
        }),
      );
      await vi.waitFor(() =>
        expect(predecessor.sent.length).toBeGreaterThanOrEqual(2),
      );
      const request = frameOf(predecessor.sent[1]);
      predecessor.fireMessage(
        JSON.stringify({
          kind: "response",
          requestId: fieldOf(request, "requestId"),
          method: fieldOf(request, "method"),
          schemaVersion: fieldOf(request, "schemaVersion"),
          result: { echoed: "hi" },
          error: null,
        }),
      );
      expect(await first.call).toMatchObject({ kind: "fulfilled" });

      // The predecessor's socket stays open: its close never arrives.
      processReleasedHosts.observeInstance(hostId, "200");
      begin(personal(hostId), await heldTokenSource(hostId), null);
      expect(await answerDial(1, membershipRemovedRefusal())).toBe(HOST_TOKEN);
      await vi.waitFor(() =>
        expect(hostDoorStateFor(hostId)?.kind).toBe("membership-removed"),
      );
    });
  });

  describe("a named-reason mark ends with the host's local process instance, never with a bare refusal", () => {
    const hostId = "unary-named-reason-instance";
    const snapshot = (pid: number): LocalHostSnapshot => ({
      hostId,
      websocketUrl: mockLocalHostEntry.websocketUrl ?? "",
      version: "1.2.3",
      pid,
      systemHostName: "this-machine",
      displayName: "this-machine",
      availability: "available",
    });
    const directories: HostDirectoryService[] = [];

    afterEach(() => {
      for (const directory of directories.splice(0)) directory.dispose();
      window.localStorage.removeItem(lastLocalHostIdKey());
    });

    /** The app's real directory service over a runner host that publishes `pid`. */
    async function directoryAt(pid: number): Promise<MockRunnerHost> {
      const host = new MockRunnerHost({
        signInUrl: "https://auth.traycer.invalid/sign-in",
        authnBaseUrl: "http://localhost:5005",
        localHost: snapshot(pid),
        hosts: [],
        workspaceFolderPickerPaths: undefined,
        hasLocalHost: true,
        traycerCli: undefined,
      });
      const directory = new HostDirectoryService({
        onRegistryPollTick: null,
        authContextId: null,
        credentialGeneration: null,
        runnerHost: host,
        localHostIdSeeder: null,
        remoteFetcher: null,
      });
      directories.push(directory);
      await directory.start();
      return host;
    }

    it("sends the sign-in after a bare refusal once the same host id is published under a new pid", async () => {
      const host = await directoryAt(100);
      processReleasedHosts.refusedNamingReason(
        processReleasedHosts.currentInstance(hostId),
        false,
      );
      host.setLocalHost(snapshot(200));
      const driven = begin(
        personal(hostId),
        await heldTokenSource(hostId),
        null,
      );
      expect(await answerDial(0, releasedRefusal())).toBe(HOST_TOKEN);
      expect(await answerDial(1, null)).toBe(SIGN_IN_TOKEN);
      expect(driven.settled()).toBe(false);
    });

    it("sends the sign-in once the host id returns under a new pid after another host was the local one", async () => {
      const host = await directoryAt(100);
      processReleasedHosts.refusedNamingReason(
        processReleasedHosts.currentInstance(hostId),
        false,
      );
      host.setLocalHost({
        ...snapshot(7),
        hostId: "unary-named-reason-other-local-host",
      });
      host.setLocalHost(snapshot(200));
      const driven = begin(
        personal(hostId),
        await heldTokenSource(hostId),
        null,
      );
      expect(await answerDial(0, releasedRefusal())).toBe(HOST_TOKEN);
      expect(await answerDial(1, null)).toBe(SIGN_IN_TOKEN);
      expect(driven.settled()).toBe(false);
    });

    it("sends no sign-in when the host id returns under the same pid after another host was the local one (control)", async () => {
      const host = await directoryAt(100);
      processReleasedHosts.refusedNamingReason(
        processReleasedHosts.currentInstance(hostId),
        false,
      );
      host.setLocalHost({
        ...snapshot(7),
        hostId: "unary-named-reason-other-local-host",
      });
      host.setLocalHost(snapshot(100));
      const driven = begin(
        personal(hostId),
        await heldTokenSource(hostId),
        null,
      );
      expect(await answerDial(0, releasedRefusal())).toBe(HOST_TOKEN);
      expect(await driven.call).toMatchObject({ kind: "rejected" });
      expect(sentTokens()).not.toContain(SIGN_IN_TOKEN);
    });

    it("sends no sign-in after the same bare refusal while the published pid is unchanged (control)", async () => {
      const host = await directoryAt(100);
      processReleasedHosts.refusedNamingReason(
        processReleasedHosts.currentInstance(hostId),
        false,
      );
      host.setLocalHost(snapshot(100));
      const driven = begin(
        personal(hostId),
        await heldTokenSource(hostId),
        null,
      );
      expect(await answerDial(0, releasedRefusal())).toBe(HOST_TOKEN);
      expect(await driven.call).toMatchObject({ kind: "rejected" });
      expect(sentTokens()).not.toContain(SIGN_IN_TOKEN);
    });
  });
});
