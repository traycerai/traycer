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
  SESSION_CONTROL_STREAM_ID,
} from "@traycer/protocol/host-transport/mux";
import type { SessionDoorObserver } from "@traycer/protocol/host-transport/remote/auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostDoorStateOfRefusal } from "../../host-door-state";
import { resetNegotiatedManifests } from "../../negotiated-manifest-registry";
import {
  createReleasedHostMemory,
  opensReleasedWay,
  type ReleasedSignOn,
  type ReleasedSignOnRow,
} from "../../released-sign-on";
import { RemoteSession } from "../remote-session";
import { emptyStreamRegistry, FakeRelayHost } from "./fake-relay-host";

const USER_ID = AUTHENTICATED_USER_FIXTURE_ID;
const HOST_TOKEN = "host-only-token";
const SIGN_IN = "person-sign-in";
const ROTATED_SIGN_IN = "person-sign-in-rotated";
const WAIT = { timeout: 10_000, interval: 20 };
const emptyRpcRegistry = defineVersionedRpcRegistry({});

const PERSONAL_ROW: ReleasedSignOnRow = {
  owner: { kind: "user", id: USER_ID },
  sandbox: null,
};
const TEAM_ROW: ReleasedSignOnRow = {
  owner: { kind: "team", id: "team-1", name: "Team" },
  sandbox: null,
};
const SANDBOX_ROW: ReleasedSignOnRow = {
  owner: { kind: "user", id: USER_ID },
  sandbox: { id: "box" },
};

function releasedRefusal(): FatalErrorDetails {
  return {
    code: "UNAUTHORIZED",
    reason: "released-host-token-refusal",
    incompatibleMethods: null,
    upgradeGuidance: null,
  };
}

function isHostTokenAuthz(authz: unknown): boolean {
  if (typeof authz !== "object" || authz === null) return false;
  return (
    Reflect.get(authz, "v") === OPEN_AUTHZ_SESSION_GRANT_VERSION &&
    Reflect.get(authz, "grant") === HOST_TOKEN
  );
}

function credentialBearers(relay: FakeRelayHost): string[] {
  const bearers: string[] = [];
  for (const update of relay.credentialUpdates) {
    if (typeof update !== "object" || update === null) continue;
    const bearer = Reflect.get(update, "bearer");
    if (typeof bearer === "string") bearers.push(bearer);
  }
  return bearers;
}

function recordingDoor(): {
  readonly door: SessionDoorObserver;
  readonly refusals: FatalErrorDetails[];
} {
  const refusals: FatalErrorDetails[] = [];
  return {
    refusals,
    door: {
      refused: (details) => {
        refusals.push(details);
      },
      admitted: () => undefined,
    },
  };
}

/**
 * A released host refuses a host-only token and admits a sign-in with `authz`
 * null. A current host admits the host-only token. A sign-in is admitted in
 * either mode, so a client that presents one is visible on the recorded opens.
 */
function scriptHost(relay: FakeRelayHost, released: { value: boolean }): void {
  relay.openAckCapabilities = [SESSION_CAPABILITY_CREDENTIAL_UPDATE];
  relay.decideOpen = (_grant, openIndex) => {
    const bearer = relay.openBearers[openIndex] ?? "";
    const authz = relay.openAuthz[openIndex];
    if (bearer === SIGN_IN && authz === null) return { kind: "ack" };
    if (bearer === ROTATED_SIGN_IN && authz === null) return { kind: "ack" };
    if (!released.value && isHostTokenAuthz(authz)) return { kind: "ack" };
    return { kind: "fatal", details: releasedRefusal() };
  };
}

function openSession(
  relay: FakeRelayHost,
  signIn: MutableBearerLease,
  releasedSignOn: ReleasedSignOn | null,
  door: SessionDoorObserver,
): RemoteSession<typeof emptyRpcRegistry, typeof emptyStreamRegistry> {
  let nextRequestId = 0;
  return new RemoteSession({
    hostId: "host-1",
    attachBaseUrl: "wss://relay.test/attach",
    hostStaticPublicKey: relay.hostStaticPublicKey,
    grantProvider: () =>
      Promise.resolve({
        kind: "ok" as const,
        grant: { grant: "grant-jws", expiresInSeconds: 300 },
      }),
    hostToken: () => HOST_TOKEN,
    releasedSignOn,
    auth: null,
    door,
    clock: null,
    rpcRegistry: emptyRpcRegistry,
    streamRegistry: emptyStreamRegistry,
    webSocketFactory: relay.factory,
    requestId: () => `req-${(nextRequestId += 1)}`,
    evidence: NO_TRANSPORT_EVIDENCE,
    clientIdentity: TEST_CLIENT_IDENTITY,
    livenessProbe: null,
  });
}

function signOnFor(
  row: ReleasedSignOnRow,
  signIn: MutableBearerLease,
): ReleasedSignOn | null {
  return opensReleasedWay(row, USER_ID)
    ? {
        signIn: () => signIn,
        recovery: null,
        allowed: () => Promise.resolve(true),
        hostTokenUnobtainable: () => false,
        hosts: createReleasedHostMemory(),
      }
    : null;
}

afterEach(() => {
  resetNegotiatedManifests();
  vi.useRealTimers();
});

describe("released personal host, remote door", () => {
  it("opens with the sign-in after the host-only token is refused, and pushes the rotated sign-in", async () => {
    const relay = new FakeRelayHost();
    const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
    const { door, refusals } = recordingDoor();
    scriptHost(relay, { value: true });
    const session = openSession(
      relay,
      signIn,
      signOnFor(PERSONAL_ROW, signIn),
      door,
    );
    try {
      session.start();
      await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
      expect(relay.openBearers).toEqual(["", SIGN_IN]);
      expect(relay.openAuthz[0]).toEqual({
        v: OPEN_AUTHZ_SESSION_GRANT_VERSION,
        grant: HOST_TOKEN,
      });
      expect(relay.openAuthz[1]).toBeNull();
      signIn.rotate(ROTATED_SIGN_IN);
      session.notifyBearerRotated();
      await vi.waitFor(
        () => expect(credentialBearers(relay)).toEqual([ROTATED_SIGN_IN]),
        WAIT,
      );
      expect(refusals).toEqual([]);
    } finally {
      session.close();
    }
  }, 20_000);

  it("keeps the sign-in off a team computer and a sandbox, and the door hears the refusal", async () => {
    for (const row of [TEAM_ROW, SANDBOX_ROW]) {
      const relay = new FakeRelayHost();
      const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
      const { door, refusals } = recordingDoor();
      scriptHost(relay, { value: true });
      const session = openSession(relay, signIn, signOnFor(row, signIn), door);
      try {
        session.start();
        await vi.waitFor(() => expect(session.isClosed()).toBe(true), WAIT);
        expect(relay.openBearers).toEqual([""]);
        expect(relay.openAuthz).toEqual([
          { v: OPEN_AUTHZ_SESSION_GRANT_VERSION, grant: HOST_TOKEN },
        ]);
        expect(refusals).toHaveLength(1);
        expect(hostDoorStateOfRefusal(refusals[0])).toBe("older-host");
        expect(credentialBearers(relay)).toEqual([]);
      } finally {
        session.close();
      }
    }
  }, 20_000);

  it("never presents the sign-in to a current host, including the dial after a drop", async () => {
    const relay = new FakeRelayHost();
    const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
    const { door, refusals } = recordingDoor();
    scriptHost(relay, { value: false });
    const session = openSession(
      relay,
      signIn,
      signOnFor(PERSONAL_ROW, signIn),
      door,
    );
    try {
      session.start();
      await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
      signIn.rotate(ROTATED_SIGN_IN);
      session.notifyBearerRotated();
      await vi.waitFor(
        () => expect(credentialBearers(relay)).toEqual([HOST_TOKEN]),
        WAIT,
      );
      const opensBeforeDrop = relay.openBearers.length;
      relay.dropCurrentConnection();
      await vi.waitFor(() => {
        expect(session.isReady()).toBe(true);
        expect(relay.openBearers.length).toBeGreaterThan(opensBeforeDrop);
      }, WAIT);
      signIn.rotate(SIGN_IN);
      session.notifyBearerRotated();
      await vi.waitFor(
        () =>
          expect(credentialBearers(relay)).toEqual([HOST_TOKEN, HOST_TOKEN]),
        WAIT,
      );
      expect(relay.openBearers.every((bearer) => bearer === "")).toBe(true);
      expect(relay.openAuthz.every((authz) => isHostTokenAuthz(authz))).toBe(
        true,
      );
      expect(refusals).toEqual([]);
    } finally {
      session.close();
    }
  }, 20_000);

  it("dials the host-only token again after a released connection drops onto a current host", async () => {
    const relay = new FakeRelayHost();
    const released = { value: true };
    const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
    const { door, refusals } = recordingDoor();
    scriptHost(relay, released);
    const session = openSession(
      relay,
      signIn,
      signOnFor(PERSONAL_ROW, signIn),
      door,
    );
    try {
      session.start();
      await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
      expect(relay.openBearers).toEqual(["", SIGN_IN]);
      const opensBeforeDrop = relay.openBearers.length;
      released.value = false;
      relay.dropCurrentConnection();
      await vi.waitFor(() => {
        expect(session.isReady()).toBe(true);
        expect(relay.openBearers.length).toBeGreaterThan(opensBeforeDrop);
      }, WAIT);
      const laterBearers = relay.openBearers.slice(opensBeforeDrop);
      const laterAuthz = relay.openAuthz.slice(opensBeforeDrop);
      expect(laterBearers).toEqual([""]);
      expect(laterAuthz.every((authz) => isHostTokenAuthz(authz))).toBe(true);
      signIn.rotate(ROTATED_SIGN_IN);
      session.notifyBearerRotated();
      await vi.waitFor(
        () => expect(credentialBearers(relay)).toEqual([HOST_TOKEN]),
        WAIT,
      );
      expect(refusals).toEqual([]);
    } finally {
      session.close();
    }
  }, 20_000);

  it("reports the refusal once when the personal host refuses the sign-in too", async () => {
    const relay = new FakeRelayHost();
    const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
    const { door, refusals } = recordingDoor();
    relay.decideOpen = () => ({ kind: "fatal", details: releasedRefusal() });
    const session = openSession(
      relay,
      signIn,
      signOnFor(PERSONAL_ROW, signIn),
      door,
    );
    try {
      session.start();
      await vi.waitFor(() => expect(session.isClosed()).toBe(true), WAIT);
      expect(relay.openBearers).toEqual(["", SIGN_IN]);
      expect(relay.openAuthz[1]).toBeNull();
      expect(refusals).toHaveLength(1);
      expect(hostDoorStateOfRefusal(refusals[0])).toBe("older-host");
      const opensAtClose = relay.openBearers.length;
      vi.useFakeTimers();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(session.isClosed()).toBe(true);
      expect(relay.openBearers).toHaveLength(opensAtClose);
    } finally {
      session.close();
      vi.useRealTimers();
    }
  }, 20_000);

  it("keeps every later open on the host-only token when an admitted session is closed without a door reason", async () => {
    const relay = new FakeRelayHost();
    const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
    const { door, refusals } = recordingDoor();
    scriptHost(relay, { value: false });
    const session = openSession(
      relay,
      signIn,
      signOnFor(PERSONAL_ROW, signIn),
      door,
    );
    try {
      session.start();
      await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
      await relay.sendStreamFatal(SESSION_CONTROL_STREAM_ID, releasedRefusal());
      await vi.waitFor(() => {
        expect(relay.openBearers).toEqual([""]);
        expect(relay.openAuthz).toEqual([
          { v: OPEN_AUTHZ_SESSION_GRANT_VERSION, grant: HOST_TOKEN },
        ]);
        expect(refusals).toHaveLength(1);
        expect(hostDoorStateOfRefusal(refusals[0])).toBe("older-host");
        expect(session.isClosed()).toBe(true);
      }, WAIT);
      const opensAtClose = relay.openBearers.length;
      vi.useFakeTimers();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(session.isClosed()).toBe(true);
      expect(relay.openBearers).toHaveLength(opensAtClose);
    } finally {
      session.close();
      vi.useRealTimers();
    }
  }, 20_000);
});
