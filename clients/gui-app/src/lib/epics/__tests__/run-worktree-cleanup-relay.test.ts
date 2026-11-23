import { afterEach, describe, expect, it, vi } from "vitest";
import { MutableBearerLease } from "@traycer-clients/shared/auth/bearer-source";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { AUTHENTICATED_USER_FIXTURE_ID } from "@traycer-clients/shared/test-fixtures/authenticated-user";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";
import {
  RemoteSession,
  RemoteStreamClient,
} from "@traycer-clients/shared/host-transport/remote/index";
import { resetNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { createReleasedHostMemory } from "@traycer-clients/shared/host-transport/released-sign-on";
import { FakeRelayHost } from "@traycer-clients/shared/host-transport/remote/__tests__/fake-relay-host";
import {
  defineVersionedRpcRegistry,
  type FatalErrorDetails,
} from "@traycer/protocol/framework/index";
import { SERVES_EVERY_INSTALLED_MAJOR } from "@traycer/protocol/framework/capability-manifest";
import { buildStreamManifest } from "@traycer/protocol/framework/stream-compat";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  QosClass,
  SESSION_CAPABILITY_CREDENTIAL_UPDATE,
} from "@traycer/protocol/host-transport/mux";
import type { DurableStreamTransport } from "@/lib/host/durable-stream-transport";
import {
  runWorktreeCleanup,
  type WorktreeCleanupOutcome,
} from "@/lib/epics/run-worktree-cleanup";

// The real cleanup runner and the real batch command over the relay: a real
// remote session against a fake relay host. Real timers, because the relay's
// handshake runs on WebCrypto.

const USER_ID = AUTHENTICATED_USER_FIXTURE_ID;
const HOST_TOKEN = "host-only-token";
const SIGN_IN = "person-sign-in";
const PATH = "/wt/a";
const WAIT = { timeout: 10_000, interval: 20 };
const NEVER_REACHED_HOST_REASON =
  "Couldn't reach the host to start the deletion.";
const emptyRpcRegistry = defineVersionedRpcRegistry({});

function releasedRefusal(): FatalErrorDetails {
  return {
    code: "UNAUTHORIZED",
    reason: "released-host-token-refusal",
    incompatibleMethods: null,
    upgradeGuidance: null,
  };
}

/** A released host: it refuses the host-only token and takes the person's sign-in. */
function releasedHost(relay: FakeRelayHost): void {
  relay.streamManifest = buildStreamManifest(
    hostStreamRpcRegistry,
    SERVES_EVERY_INSTALLED_MAJOR,
  );
  relay.openAckCapabilities = [SESSION_CAPABILITY_CREDENTIAL_UPDATE];
  relay.decideOpen = (_grant, openIndex) =>
    relay.openAuthz[openIndex] === null
      ? { kind: "ack" }
      : { kind: "fatal", details: releasedRefusal() };
}

/** A host that keeps answering the attach with a retryable refusal: the session parks before it is ready. */
function hostThatParksTheSession(relay: FakeRelayHost): void {
  relay.streamManifest = buildStreamManifest(
    hostStreamRpcRegistry,
    SERVES_EVERY_INSTALLED_MAJOR,
  );
  relay.decideOpen = () => ({
    kind: "fatal",
    details: {
      code: "UNAUTHORIZED",
      reason: "current-host-refusal",
      doorReason: "keys_unavailable",
      retryable: true,
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  });
}

function startRelayCleanup(relay: FakeRelayHost): {
  readonly outcome: { current: WorktreeCleanupOutcome | null };
  readonly close: () => void;
} {
  const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
  let requestNumber = 0;
  const session = new RemoteSession({
    hostId: "relay-cleanup-host",
    attachBaseUrl: "wss://relay.test/attach",
    hostStaticPublicKey: relay.hostStaticPublicKey,
    grantProvider: () =>
      Promise.resolve({
        kind: "ok",
        grant: { grant: "grant-jws", expiresInSeconds: 300 },
      }),
    hostToken: () => HOST_TOKEN,
    releasedSignOn: {
      signIn: () => signIn,
      recovery: null,
      hostTokenUnobtainable: () => false,
      ownerSignInEligible: () => false,
      heldTokenRefused: () => false,
      forgetHeldRefusal: () => undefined,
      mayPresentSignIn: () => true,
      hosts: createReleasedHostMemory(),
      opensReleasedWay: () => true,
      confirmRow: null,
    },
    auth: null,
    door: { refused: () => undefined, admitted: () => () => undefined },
    clock: null,
    rpcRegistry: emptyRpcRegistry,
    streamRegistry: hostStreamRpcRegistry,
    webSocketFactory: relay.factory,
    requestId: () => `req-${(requestNumber += 1)}`,
    evidence: NO_TRANSPORT_EVIDENCE,
    clientIdentity: TEST_CLIENT_IDENTITY,
    livenessProbe: null,
  });
  const client = new RemoteStreamClient(session);
  const openStreamTransport = (): DurableStreamTransport => ({
    wsStreamClient: client,
    close: () => session.close(),
  });
  const outcome: { current: WorktreeCleanupOutcome | null } = {
    current: null,
  };
  void runWorktreeCleanup(openStreamTransport, {
    hostId: "relay-cleanup-host",
    paths: [PATH],
    source: "task_cleanup",
    stopOwnersPaths: new Set(),
  }).then((settled) => {
    outcome.current = settled;
  });
  session.start();
  return { outcome, close: () => session.close() };
}

afterEach(() => {
  resetNegotiatedManifests();
});

describe("worktree cleanup through the relay", () => {
  it("removes the worktrees of a released personal host once the sign-in attach that follows the refused host-only token is admitted", async () => {
    const relay = new FakeRelayHost();
    releasedHost(relay);
    const { outcome, close } = startRelayCleanup(relay);
    try {
      await vi.waitFor(
        () => expect(relay.subscribeStreamIds).toHaveLength(1),
        WAIT,
      );
      // The refused host-only token was attached first, then the sign-in.
      expect(relay.openAuthz[relay.openAuthz.length - 1]).toBeNull();
      const streamId = relay.subscribeStreamIds[0];
      await relay.sendStreamFrame(
        streamId,
        {
          kind: "target.complete",
          worktreePath: PATH,
          deleted: true,
          hasBinaryPayload: false,
        },
        null,
        QosClass.INTERACTIVE,
      );
      await relay.sendStreamFrame(
        streamId,
        {
          kind: "command.complete",
          requestedCount: 1,
          deletedCount: 1,
          failedCount: 0,
          hasBinaryPayload: false,
        },
        null,
        QosClass.INTERACTIVE,
      );
      await vi.waitFor(
        () =>
          expect(outcome.current).toEqual({
            removed: [PATH],
            failed: [],
            uncertain: [],
          }),
        WAIT,
      );
    } finally {
      close();
    }
  }, 20_000);

  it("reports the paths as not reached when the session parks before it is ready and the stream enters backoff", async () => {
    const relay = new FakeRelayHost();
    hostThatParksTheSession(relay);
    const { outcome, close } = startRelayCleanup(relay);
    try {
      await vi.waitFor(
        () =>
          expect(outcome.current).toEqual({
            removed: [],
            failed: [{ worktreePath: PATH, reason: NEVER_REACHED_HOST_REASON }],
            uncertain: [],
          }),
        WAIT,
      );
      expect(relay.subscribeStreamIds).toEqual([]);
    } finally {
      close();
    }
  }, 20_000);
});
