import { MutableBearerLease } from "@traycer-clients/shared/auth/bearer-source";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";
import { AUTHENTICATED_USER_FIXTURE_ID } from "@traycer-clients/shared/test-fixtures/authenticated-user";
import {
  defineVersionedRpcRegistry,
  type FatalErrorDetails,
} from "@traycer/protocol/framework/index";
import {
  OPEN_AUTHZ_SESSION_GRANT_VERSION,
  SESSION_CAPABILITY_CREDENTIAL_UPDATE,
} from "@traycer/protocol/host-transport/mux";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetNegotiatedManifests } from "../../negotiated-manifest-registry";
import { createReleasedHostMemory } from "../../released-sign-on";
import { RemoteSession } from "../remote-session";
import { emptyStreamRegistry, FakeRelayHost } from "./fake-relay-host";

const USER_ID = AUTHENTICATED_USER_FIXTURE_ID;
const HOST_TOKEN = "host-only-token";
const SIGN_IN = "person-sign-in";
const ROTATED_ONCE = "person-sign-in-rotated-once";
const ROTATED_TWICE = "person-sign-in-rotated-twice";
const WAIT = { timeout: 10_000, interval: 20 };
const emptyRpcRegistry = defineVersionedRpcRegistry({});

const RELEASED_REFUSAL: FatalErrorDetails = {
  code: "UNAUTHORIZED",
  reason: "released-host-token-refusal",
  incompatibleMethods: null,
  upgradeGuidance: null,
};

function credentialBearers(relay: FakeRelayHost): string[] {
  const bearers: string[] = [];
  for (const update of relay.credentialUpdates) {
    if (typeof update !== "object" || update === null) continue;
    const bearer = Reflect.get(update, "bearer");
    if (typeof bearer === "string") bearers.push(bearer);
  }
  return bearers;
}

interface HeldRead {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: () => void;
}

function deferred(): HeldRead {
  let resolve = (): void => undefined;
  let reject = (): void => undefined;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = () => rejectPromise(new Error("the row read failed"));
  });
  return { promise, resolve, reject };
}

/**
 * A session admitted on the person's sign-in to a released host, whose row
 * cache says the host is still the person's until a read says otherwise. The
 * read the attach asked for answers at once; every read asked after the
 * session was ready is held for the test.
 */
async function admittedOnSignIn(rowReleased: { value: boolean }): Promise<{
  readonly relay: FakeRelayHost;
  readonly signIn: MutableBearerLease;
  readonly session: RemoteSession<
    typeof emptyRpcRegistry,
    typeof emptyStreamRegistry
  >;
  readonly heldReads: HeldRead[];
}> {
  const relay = new FakeRelayHost();
  const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
  relay.openAckCapabilities = [SESSION_CAPABILITY_CREDENTIAL_UPDATE];
  relay.decideOpen = (_grant, openIndex) =>
    relay.openAuthz[openIndex] === null
      ? { kind: "ack" }
      : { kind: "fatal", details: RELEASED_REFUSAL };
  const heldReads: HeldRead[] = [];
  let holding = false;
  let nextRequestId = 0;
  const rowAllows = (): boolean => rowReleased.value;
  const session = new RemoteSession({
    hostId: "host-1",
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
      mayPresentSignIn: rowAllows,
      hosts: createReleasedHostMemory(),
      opensReleasedWay: rowAllows,
      confirmRow: () => {
        if (!holding) return Promise.resolve();
        const read = deferred();
        heldReads.push(read);
        return read.promise;
      },
    },
    auth: null,
    door: { refused: () => undefined, admitted: () => () => undefined },
    clock: null,
    rpcRegistry: emptyRpcRegistry,
    streamRegistry: emptyStreamRegistry,
    webSocketFactory: relay.factory,
    requestId: () => `req-${(nextRequestId += 1)}`,
    evidence: NO_TRANSPORT_EVIDENCE,
    clientIdentity: TEST_CLIENT_IDENTITY,
    livenessProbe: null,
  });
  session.start();
  await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
  expect(relay.openBearers).toEqual(["", SIGN_IN]);
  holding = true;
  return { relay, signIn, session, heldReads };
}

/** Waits for the update's row read to be asked, or for an update to have been written without one. */
async function untilReadAskedOrWritten(
  relay: FakeRelayHost,
  heldReads: ReadonlyArray<unknown>,
): Promise<void> {
  await vi.waitFor(
    () =>
      expect(heldReads.length + credentialBearers(relay).length).toBeGreaterThan(
        0,
      ),
    WAIT,
  );
}

afterEach(() => {
  resetNegotiatedManifests();
});

describe("a credential update that would carry the sign-in on an admitted session", () => {
  it("is written only after one row read, and carries the host-only token when that read shows the host moved to a team, with no reconnect", async () => {
    const row = { value: true };
    const { relay, signIn, session, heldReads } = await admittedOnSignIn(row);
    try {
      signIn.rotate(ROTATED_ONCE);
      session.notifyBearerRotated();
      await untilReadAskedOrWritten(relay, heldReads);
      expect(heldReads).toHaveLength(1);
      expect(credentialBearers(relay)).toEqual([]);

      // The read commits the host's row as a team's, then answers.
      row.value = false;
      heldReads[0].resolve();
      await vi.waitFor(
        () => expect(credentialBearers(relay)).toEqual([HOST_TOKEN]),
        WAIT,
      );
      expect(relay.openBearers).toEqual(["", SIGN_IN]);
      expect(session.isReady()).toBe(true);
    } finally {
      session.close();
    }
  }, 20_000);

  it("is sent with the sign-in on the last confirmed row when the read fails, with no reconnect", async () => {
    const { relay, signIn, session, heldReads } = await admittedOnSignIn({
      value: true,
    });
    try {
      signIn.rotate(ROTATED_ONCE);
      session.notifyBearerRotated();
      await untilReadAskedOrWritten(relay, heldReads);
      expect(heldReads).toHaveLength(1);
      expect(credentialBearers(relay)).toEqual([]);

      heldReads[0].reject();
      await vi.waitFor(
        () => expect(credentialBearers(relay)).toEqual([ROTATED_ONCE]),
        WAIT,
      );
      expect(relay.openBearers).toEqual(["", SIGN_IN]);
      expect(session.isReady()).toBe(true);
    } finally {
      session.close();
    }
  }, 20_000);

  it("is one read and one update, carrying the latest sign-in, for two renewals during one confirmation, with no reconnect", async () => {
    const { relay, signIn, session, heldReads } = await admittedOnSignIn({
      value: true,
    });
    try {
      signIn.rotate(ROTATED_ONCE);
      session.notifyBearerRotated();
      await untilReadAskedOrWritten(relay, heldReads);
      expect(heldReads).toHaveLength(1);
      signIn.rotate(ROTATED_TWICE);
      session.notifyBearerRotated();
      expect(credentialBearers(relay)).toEqual([]);

      heldReads[0].resolve();
      await vi.waitFor(
        () => expect(credentialBearers(relay)).toEqual([ROTATED_TWICE]),
        WAIT,
      );
      expect(heldReads).toHaveLength(1);
      expect(relay.openBearers).toEqual(["", SIGN_IN]);
      expect(session.isReady()).toBe(true);
    } finally {
      session.close();
    }
  }, 20_000);
});
