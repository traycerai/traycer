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
import type {
  AttachGrantProvider,
  AttachGrantProvision,
} from "@traycer/protocol/host-transport/remote/grant";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hostDoorStateOfRefusal,
  type HostDoorObserver,
} from "../../host-door-state";
import { resetNegotiatedManifests } from "../../negotiated-manifest-registry";
import {
  createReleasedHostMemory,
  opensReleasedWay,
  type ReleasedSignOnRow,
} from "../../released-sign-on";
import type { RevalidateOutcome } from "@traycer-clients/shared/auth/bearer-revalidator";
import { RemoteSession, type RemoteReleasedSignOn } from "../remote-session";
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

/** What a released host says when its own check refuses a credential. */
const RELEASED_HOST_REASONS = [
  "Authenticated user does not own this host",
  "Host is not provisioned - run `traycer login` on the host machine to authorize it",
  "Token has been revoked",
] as const;

function releasedRefusal(): FatalErrorDetails {
  return releasedRefusalSaying("released-host-token-refusal");
}

function releasedRefusalSaying(reason: string): FatalErrorDetails {
  return {
    code: "UNAUTHORIZED",
    reason,
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
  readonly door: HostDoorObserver;
  readonly refusals: FatalErrorDetails[];
} {
  const refusals: FatalErrorDetails[] = [];
  return {
    refusals,
    door: {
      refused: (details) => {
        refusals.push(details);
      },
      admitted: () => () => undefined,
    },
  };
}

function namedRefusalOf(
  doorReason: NonNullable<FatalErrorDetails["doorReason"]>,
): FatalErrorDetails {
  return {
    code: "UNAUTHORIZED",
    reason: "current-host-refusal",
    doorReason,
    retryable: false,
    incompatibleMethods: null,
    upgradeGuidance: null,
  };
}

function namedNotAdmitted(): FatalErrorDetails {
  return {
    code: "UNAUTHORIZED",
    reason: "current-host-refusal",
    doorReason: "not_admitted",
    retryable: false,
    incompatibleMethods: null,
    upgradeGuidance: null,
  };
}

/**
 * A released host refuses a host-only token and admits a sign-in with `authz`
 * null. A current host admits the host-only token and refuses a sign-in by
 * name.
 */
function scriptHost(relay: FakeRelayHost, released: { value: boolean }): void {
  relay.openAckCapabilities = [SESSION_CAPABILITY_CREDENTIAL_UPDATE];
  relay.decideOpen = (_grant, openIndex) => {
    const bearer = relay.openBearers[openIndex] ?? "";
    const authz = relay.openAuthz[openIndex];
    if (authz === null && !released.value) {
      return { kind: "fatal", details: namedNotAdmitted() };
    }
    if ((bearer === SIGN_IN || bearer === ROTATED_SIGN_IN) && authz === null) {
      return { kind: "ack" };
    }
    if (!released.value && isHostTokenAuthz(authz)) return { kind: "ack" };
    return { kind: "fatal", details: releasedRefusal() };
  };
}

const OK_GRANT: AttachGrantProvision = {
  kind: "ok",
  grant: { grant: "grant-jws", expiresInSeconds: 300 },
};

function openSession(
  relay: FakeRelayHost,
  signIn: MutableBearerLease,
  releasedSignOn: RemoteReleasedSignOn | null,
  door: HostDoorObserver,
): RemoteSession<typeof emptyRpcRegistry, typeof emptyStreamRegistry> {
  return openSessionWithGrants(relay, releasedSignOn, door, () =>
    Promise.resolve(OK_GRANT),
  );
}

function openSessionWithGrants(
  relay: FakeRelayHost,
  releasedSignOn: RemoteReleasedSignOn | null,
  door: HostDoorObserver,
  grantProvider: AttachGrantProvider,
): RemoteSession<typeof emptyRpcRegistry, typeof emptyStreamRegistry> {
  let nextRequestId = 0;
  return new RemoteSession({
    hostId: "host-1",
    attachBaseUrl: "wss://relay.test/attach",
    hostStaticPublicKey: relay.hostStaticPublicKey,
    grantProvider,
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
): RemoteReleasedSignOn | null {
  return signOnWithLiveRow(row, signIn, () => true);
}

/** `rowAllows` is the live read of the row the session's host has in the directory. */
function signOnWithLiveRow(
  row: ReleasedSignOnRow,
  signIn: MutableBearerLease,
  rowAllows: () => boolean,
): RemoteReleasedSignOn | null {
  return opensReleasedWay(row, USER_ID)
    ? {
        signIn: () => signIn,
        recovery: null,
        hostTokenUnobtainable: () => false,
        ownerSignInEligible: () => false,
        heldTokenRefused: () => false,
        forgetHeldRefusal: () => undefined,
        mayPresentSignIn: rowAllows,
        hosts: createReleasedHostMemory(),
        opensReleasedWay: rowAllows,
        confirmRow: null,
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

  it("pushes the host-only token, never the sign-in, on the next credential update once another transport has heard the host name a reason", async () => {
    const relay = new FakeRelayHost();
    const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
    const hosts = createReleasedHostMemory();
    const { door, refusals } = recordingDoor();
    scriptHost(relay, { value: true });
    const personal = signOnFor(PERSONAL_ROW, signIn);
    if (personal === null) throw new Error("personal row must open released");
    const session = openSession(relay, signIn, { ...personal, hosts }, door);
    try {
      session.start();
      await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
      expect(relay.openBearers).toEqual(["", SIGN_IN]);

      hosts.refusedNamingReason(hosts.currentInstance("host-1"), false);
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
      expect(laterBearers).toEqual([SIGN_IN, ""]);
      expect(laterAuthz[0]).toBeNull();
      expect(isHostTokenAuthz(laterAuthz[1])).toBe(true);
      signIn.rotate(ROTATED_SIGN_IN);
      session.notifyBearerRotated();
      await vi.waitFor(
        () => expect(credentialBearers(relay)).toEqual([HOST_TOKEN]),
        WAIT,
      );
      const afterUpdate = relay.openBearers.length;
      relay.dropCurrentConnection();
      await vi.waitFor(
        () => expect(relay.openBearers.length).toBeGreaterThan(afterUpdate),
        WAIT,
      );
      expect(relay.openBearers[afterUpdate]).toBe("");
      expect(relay.openBearers.slice(afterUpdate)).not.toContain(SIGN_IN);
      expect(relay.openAuthz[afterUpdate]).toEqual({
        v: OPEN_AUTHZ_SESSION_GRANT_VERSION,
        grant: HOST_TOKEN,
      });
      expect(refusals).toEqual([]);
    } finally {
      session.close();
    }
  }, 20_000);

  it("dials the sign-in first when a released connection drops", async () => {
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
      const before = relay.openBearers.length;
      relay.dropCurrentConnection();
      await vi.waitFor(
        () => expect(relay.openBearers.length).toBeGreaterThan(before),
        WAIT,
      );
      expect(relay.openBearers[before]).toBe(SIGN_IN);
      expect(relay.openAuthz[before]).toBeNull();
      expect(refusals).toEqual([]);
    } finally {
      session.close();
    }
  }, 20_000);

  it("dials the host-only token when the host names a reason while the sign-in's refresh runs", async () => {
    const relay = new FakeRelayHost();
    const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
    const hosts = createReleasedHostMemory();
    const refreshes: Array<(outcome: RevalidateOutcome) => void> = [];
    const { door, refusals } = recordingDoor();
    relay.openAckCapabilities = [SESSION_CAPABILITY_CREDENTIAL_UPDATE];
    relay.decideOpen = (_grant, openIndex) =>
      openIndex > 1 && isHostTokenAuthz(relay.openAuthz[openIndex])
        ? { kind: "ack" }
        : { kind: "fatal", details: releasedRefusal() };
    const personal = signOnFor(PERSONAL_ROW, signIn);
    if (personal === null) throw new Error("personal row must open released");
    const session = openSession(
      relay,
      signIn,
      {
        ...personal,
        recovery: {
          revalidateForReconnect: () =>
            new Promise<RevalidateOutcome>((resolve) => {
              refreshes.push(resolve);
            }),
        },
        hosts,
      },
      door,
    );
    try {
      session.start();
      await vi.waitFor(() => expect(refreshes).toHaveLength(1), WAIT);
      expect(relay.openBearers).toEqual(["", SIGN_IN]);
      // Another transport hears this host name a reason while the refresh runs.
      hosts.refusedNamingReason(hosts.currentInstance("host-1"), false);
      refreshes[0]("rotated");
      await vi.waitFor(
        () => expect(relay.openBearers.length).toBeGreaterThanOrEqual(3),
        WAIT,
      );
      expect(relay.openBearers).toEqual(["", SIGN_IN, ""]);
      expect(isHostTokenAuthz(relay.openAuthz[2])).toBe(true);
      await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
      expect(refusals).toEqual([]);
    } finally {
      session.close();
    }
  }, 20_000);

  it.each(["rotated", "network-error", "rejected"] as const)(
    "keeps the sign-in and the door untouched when a refresh that ran past the budget answers %s after the redial was admitted",
    async (late) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const relay = new FakeRelayHost();
      const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
      const refreshes: Array<(outcome: RevalidateOutcome) => void> = [];
      const { door, refusals } = recordingDoor();
      relay.openAckCapabilities = [SESSION_CAPABILITY_CREDENTIAL_UPDATE];
      relay.decideOpen = (_grant, openIndex) =>
        openIndex === 0
          ? { kind: "fatal", details: releasedRefusal() }
          : { kind: "ack" };
      const personal = signOnFor(PERSONAL_ROW, signIn);
      if (personal === null) throw new Error("personal row must open released");
      const session = openSession(
        relay,
        signIn,
        {
          ...personal,
          recovery: {
            revalidateForReconnect: () =>
              new Promise<RevalidateOutcome>((resolve) => {
                refreshes.push(resolve);
              }),
          },
        },
        door,
      );
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
        expect(relay.openBearers).toEqual(["", SIGN_IN]);
        await relay.sendStreamFatal(
          SESSION_CONTROL_STREAM_ID,
          releasedRefusal(),
        );
        await vi.waitFor(() => expect(refreshes).toHaveLength(1), WAIT);

        await vi.advanceTimersByTimeAsync(10_000);
        await vi.waitFor(() => {
          expect(relay.openBearers).toEqual(["", SIGN_IN, SIGN_IN]);
          expect(session.isReady()).toBe(true);
        }, WAIT);

        refreshes[0](late);
        await vi.advanceTimersByTimeAsync(0);
        signIn.rotate(ROTATED_SIGN_IN);
        session.notifyBearerRotated();
        await vi.waitFor(
          () => expect(credentialBearers(relay)).toEqual([ROTATED_SIGN_IN]),
          WAIT,
        );
        expect(refusals).toEqual([]);
      } finally {
        session.close();
        vi.useRealTimers();
      }
    },
    20_000,
  );

  it("opens the redial with the refreshed sign-in when the refresh that ran past the budget answers rotated after the redial's attach began and before its open was read, with no admission remembered", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const relay = new FakeRelayHost();
    const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
    const refreshes: Array<(outcome: RevalidateOutcome) => void> = [];
    const heldGrants: Array<(grant: AttachGrantProvision) => void> = [];
    let grantsAsked = 0;
    const { door, refusals } = recordingDoor();
    relay.openAckCapabilities = [SESSION_CAPABILITY_CREDENTIAL_UPDATE];
    relay.decideOpen = (_grant, openIndex) =>
      openIndex < 2
        ? { kind: "fatal", details: releasedRefusal() }
        : { kind: "ack" };
    const personal = signOnFor(PERSONAL_ROW, signIn);
    if (personal === null) throw new Error("personal row must open released");
    // The third attach, the redial after the budget, waits for the test to
    // release its grant: the session has begun the dial and read no open.
    const session = openSessionWithGrants(
      relay,
      {
        ...personal,
        recovery: {
          revalidateForReconnect: () =>
            new Promise<RevalidateOutcome>((resolve) => {
              refreshes.push(resolve);
            }),
        },
      },
      door,
      () => {
        grantsAsked += 1;
        return grantsAsked < 3
          ? Promise.resolve(OK_GRANT)
          : new Promise<AttachGrantProvision>((resolve) => {
              heldGrants.push(resolve);
            });
      },
    );
    try {
      session.start();
      await vi.waitFor(() => expect(refreshes).toHaveLength(1), WAIT);
      expect(relay.openBearers).toEqual(["", SIGN_IN]);

      await vi.advanceTimersByTimeAsync(10_000);
      await vi.waitFor(() => expect(heldGrants).toHaveLength(1), WAIT);
      expect(relay.openBearers).toEqual(["", SIGN_IN]);

      signIn.rotate(ROTATED_SIGN_IN);
      refreshes[0]("rotated");
      await vi.advanceTimersByTimeAsync(0);
      expect(relay.openBearers).toEqual(["", SIGN_IN]);
      heldGrants[0](OK_GRANT);

      await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
      expect(relay.openBearers).toEqual(["", SIGN_IN, ROTATED_SIGN_IN]);
      expect(relay.openAuthz[2]).toBeNull();
      expect(refusals).toEqual([]);
    } finally {
      session.close();
      vi.useRealTimers();
    }
  }, 20_000);

  it.each(["rejected", "local-plane-retained"] as const)(
    "tells the door nothing when a sign-in refresh that ran past the budget answers %s after the newer attach began and before its open was read",
    async (late) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const relay = new FakeRelayHost();
      const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
      const refreshes: Array<(outcome: RevalidateOutcome) => void> = [];
      const heldGrants: Array<(grant: AttachGrantProvision) => void> = [];
      let grantsAsked = 0;
      const { door, refusals } = recordingDoor();
      relay.openAckCapabilities = [SESSION_CAPABILITY_CREDENTIAL_UPDATE];
      relay.decideOpen = (_grant, openIndex) =>
        openIndex < 2
          ? { kind: "fatal", details: releasedRefusal() }
          : { kind: "ack" };
      const personal = signOnFor(PERSONAL_ROW, signIn);
      if (personal === null) throw new Error("personal row must open released");
      const session = openSessionWithGrants(
        relay,
        {
          ...personal,
          recovery: {
            revalidateForReconnect: () =>
              new Promise<RevalidateOutcome>((resolve) => {
                refreshes.push(resolve);
              }),
          },
        },
        door,
        () => {
          grantsAsked += 1;
          return grantsAsked < 3
            ? Promise.resolve(OK_GRANT)
            : new Promise<AttachGrantProvision>((resolve) => {
                heldGrants.push(resolve);
              });
        },
      );
      try {
        session.start();
        await vi.waitFor(() => expect(refreshes).toHaveLength(1), WAIT);
        await vi.advanceTimersByTimeAsync(10_000);
        await vi.waitFor(() => expect(heldGrants).toHaveLength(1), WAIT);
        expect(relay.openBearers).toEqual(["", SIGN_IN]);

        // The newer attach is under way and its open has not been read.
        refreshes[0](late);
        await vi.advanceTimersByTimeAsync(0);
        expect(refusals).toEqual([]);

        heldGrants[0](OK_GRANT);
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
        expect(refusals).toEqual([]);
      } finally {
        session.close();
        vi.useRealTimers();
      }
    },
    20_000,
  );

  it("ends the session and tells the door nothing when the personal host refuses the sign-in too", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
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
      // A refusal of the sign-in is never the "older host" cover.
      expect(refusals).toEqual([]);
      const opensAtClose = relay.openBearers.length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(session.isClosed()).toBe(true);
      expect(relay.openBearers).toHaveLength(opensAtClose);
    } finally {
      session.close();
      vi.useRealTimers();
    }
  }, 20_000);

  it.each(
    RELEASED_HOST_REASONS.flatMap((reason) =>
      (["absent", "rejected", "local-plane-retained"] as const).map(
        (recovery) => ({ reason, recovery }),
      ),
    ),
  )(
    "tells the door nothing when the personal host refuses the sign-in bare with $reason and the recovery is $recovery",
    async ({ reason, recovery }) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const relay = new FakeRelayHost();
      const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
      const { door, refusals } = recordingDoor();
      relay.decideOpen = (bearer) => ({
        kind: "fatal",
        details:
          bearer === "" ? releasedRefusal() : releasedRefusalSaying(reason),
      });
      const base = signOnFor(PERSONAL_ROW, signIn);
      if (base === null) throw new Error("personal row must open released");
      const session = openSession(
        relay,
        signIn,
        {
          ...base,
          recovery:
            recovery === "absent"
              ? null
              : {
                  revalidateForReconnect: () => Promise.resolve(recovery),
                  revalidateRefused: () => Promise.resolve(recovery),
                },
        },
        door,
      );
      try {
        session.start();
        await vi.waitFor(() => expect(session.isClosed()).toBe(true), WAIT);
        expect(relay.openBearers.slice(0, 2)).toEqual(["", SIGN_IN]);
        expect(refusals).toEqual([]);
      } finally {
        session.close();
        vi.useRealTimers();
      }
    },
    20_000,
  );

  it("spends one sign-in refresh in a dial sequence when the host refuses every sign-in bare and each refresh answers rotated with a new bearer", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const relay = new FakeRelayHost();
    const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
    const { door, refusals } = recordingDoor();
    relay.decideOpen = () => ({ kind: "fatal", details: releasedRefusal() });
    const base = signOnFor(PERSONAL_ROW, signIn);
    if (base === null) throw new Error("personal row must open released");
    let refreshes = 0;
    const rotate = (): Promise<RevalidateOutcome> => {
      refreshes += 1;
      signIn.rotate(`sign-in-${refreshes}`);
      return Promise.resolve("rotated");
    };
    const session = openSession(
      relay,
      signIn,
      {
        ...base,
        recovery: {
          revalidateForReconnect: rotate,
          revalidateRefused: rotate,
        },
      },
      door,
    );
    try {
      session.start();
      await vi.waitFor(() => expect(session.isClosed()).toBe(true), WAIT);
      expect(relay.openBearers).toEqual([
        "",
        SIGN_IN,
        "sign-in-1",
        "sign-in-1",
      ]);
      expect(refreshes).toBe(1);
      expect(refusals).toEqual([]);
    } finally {
      session.close();
      vi.useRealTimers();
    }
  }, 20_000);

  it("keeps redialing through an authn outage without ending, and refreshes the sign-in once authn answers", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const relay = new FakeRelayHost();
    const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
    const { door, refusals } = recordingDoor();
    // The host refuses the expired sign-in bare and admits only the rotated one.
    relay.decideOpen = (_grant, openIndex) =>
      relay.openBearers[openIndex] === ROTATED_SIGN_IN &&
      relay.openAuthz[openIndex] === null
        ? { kind: "ack" }
        : { kind: "fatal", details: releasedRefusal() };
    const base = signOnFor(PERSONAL_ROW, signIn);
    if (base === null) throw new Error("personal row must open released");
    let authnReachable = false;
    const refresh = (): Promise<RevalidateOutcome> => {
      if (!authnReachable) return Promise.resolve("network-error");
      signIn.rotate(ROTATED_SIGN_IN);
      return Promise.resolve("rotated");
    };
    const session = openSession(
      relay,
      signIn,
      {
        ...base,
        recovery: {
          revalidateForReconnect: refresh,
          revalidateRefused: refresh,
        },
      },
      door,
    );
    const OUTAGE_REDIALS = 5;
    try {
      session.start();
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(31_000);
        expect(session.isClosed()).toBe(false);
        expect(relay.openBearers.length).toBeGreaterThanOrEqual(
          2 + OUTAGE_REDIALS,
        );
      }, WAIT);
      expect(session.terminalFatal()).toBeNull();

      authnReachable = true;
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(31_000);
        expect(session.isReady()).toBe(true);
      }, WAIT);
      expect(relay.openBearers[relay.openBearers.length - 1]).toBe(
        ROTATED_SIGN_IN,
      );
      expect(session.terminalFatal()).toBeNull();
      expect(refusals).toEqual([]);
    } finally {
      session.close();
      vi.useRealTimers();
    }
  }, 20_000);

  it("asks the replacement process its own open, and sets no mark, when a refusal answers an open dialed to the earlier process", async () => {
    const relay = new FakeRelayHost();
    const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
    const hosts = createReleasedHostMemory();
    hosts.observeInstance("host-1", "process-a");
    const { door } = recordingDoor();
    relay.openAckCapabilities = [SESSION_CAPABILITY_CREDENTIAL_UPDATE];
    // The host restarts while the first refusal is on its way; its replacement admits.
    relay.decideOpen = (_grant, openIndex) => {
      if (openIndex > 0) return { kind: "ack" };
      hosts.observeInstance("host-1", "process-b");
      return { kind: "fatal", details: namedNotAdmitted() };
    };
    const personal = signOnFor(PERSONAL_ROW, signIn);
    if (personal === null) throw new Error("personal row must open released");
    const session = openSession(relay, signIn, { ...personal, hosts }, door);
    try {
      session.start();
      await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
      expect(relay.openBearers).toEqual(["", ""]);
      expect(hosts.namedReason("host-1")).toBe(false);
    } finally {
      session.close();
    }
  }, 20_000);

  it("goes terminal after the no-progress bound when the released host refuses the sign-in on every open and its refresh returns the same one", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const relay = new FakeRelayHost();
    const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
    const { door, refusals } = recordingDoor();
    relay.decideOpen = () => ({ kind: "fatal", details: releasedRefusal() });
    const base = signOnFor(PERSONAL_ROW, signIn);
    if (base === null) throw new Error("personal row must open released");
    const session = openSession(
      relay,
      signIn,
      {
        ...base,
        recovery: {
          revalidateForReconnect: () => Promise.resolve("rotated"),
          revalidateRefused: () => Promise.resolve("rotated"),
        },
      },
      door,
    );
    try {
      session.start();
      await vi.waitFor(() => expect(session.isClosed()).toBe(true), WAIT);
      expect(relay.openBearers).toEqual(["", SIGN_IN, SIGN_IN, SIGN_IN]);
      expect(refusals).toEqual([]);
      const opensAtClose = relay.openBearers.length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(relay.openBearers).toHaveLength(opensAtClose);
    } finally {
      session.close();
      vi.useRealTimers();
    }
  }, 20_000);

  it("keeps every later open on the host-only token when an admitted session is closed without a door reason", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
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
      await vi.advanceTimersByTimeAsync(30_000);
      expect(session.isClosed()).toBe(true);
      expect(relay.openBearers).toHaveLength(opensAtClose);
    } finally {
      session.close();
      vi.useRealTimers();
    }
  }, 20_000);
  it("sends no sign-in on a redial or a credential push once the row leaves the person, and the door hears the refusal", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const relay = new FakeRelayHost();
    const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
    const { door, refusals } = recordingDoor();
    let rowStillTheirs = true;
    scriptHost(relay, { value: true });
    const session = openSession(
      relay,
      signIn,
      signOnWithLiveRow(PERSONAL_ROW, signIn, () => rowStillTheirs),
      door,
    );
    try {
      session.start();
      await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
      expect(relay.openBearers).toEqual(["", SIGN_IN]);

      // The directory now says another owner has the computer.
      rowStillTheirs = false;
      signIn.rotate(ROTATED_SIGN_IN);
      session.notifyBearerRotated();
      await vi.waitFor(
        () => expect(credentialBearers(relay)).toEqual([HOST_TOKEN]),
        WAIT,
      );

      const opensBeforeDrop = relay.openBearers.length;
      relay.dropCurrentConnection();
      await vi.waitFor(() => expect(session.isClosed()).toBe(true), WAIT);
      expect(relay.openBearers.slice(opensBeforeDrop)).toEqual([""]);
      expect(relay.openBearers).not.toContain(ROTATED_SIGN_IN);
      expect(refusals).toHaveLength(1);
      expect(hostDoorStateOfRefusal(refusals[0])).toBe("older-host");
      const opensAtClose = relay.openBearers.length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(relay.openBearers).toHaveLength(opensAtClose);
    } finally {
      session.close();
      vi.useRealTimers();
    }
  }, 20_000);

  it.each([
    "keys_unavailable",
    "clock_skew",
    "enrolment_broken",
    "membership_removed",
    "host_claimed",
  ] as const)(
    "reports a remembered host's %s refusal of the sign-in to the door at once",
    async (reason) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const relay = new FakeRelayHost();
      const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
      const { door, refusals } = recordingDoor();
      const hosts = createReleasedHostMemory();
      hosts.signInAdmitted(USER_ID, hosts.currentInstance("host-1"));
      relay.decideOpen = () => ({
        kind: "fatal",
        details: namedRefusalOf(reason),
      });
      const personal = signOnFor(PERSONAL_ROW, signIn);
      if (personal === null) throw new Error("personal row must open released");
      const session = openSession(relay, signIn, { ...personal, hosts }, door);
      try {
        session.start();
        await vi.waitFor(() => expect(refusals).toHaveLength(1), WAIT);
        expect(refusals[0].doorReason).toBe(reason);
        // The sign-in dial was the remembered one; no host-only token dial
        // is spent before the door hears the host.
        expect(relay.openBearers).toEqual([SIGN_IN]);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(relay.openBearers).toEqual([SIGN_IN]);
      } finally {
        session.close();
        vi.useRealTimers();
      }
    },
    20_000,
  );

  describe("a sign-in refresh left running across an admission", () => {
    /** An admitted released connection whose control stream a bare refusal then reaches, leaving its refresh pending. */
    async function admittedWithRefreshPending() {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const relay = new FakeRelayHost();
      const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
      const { door, refusals } = recordingDoor();
      // Authn's received refresh requests, each answered when the test says so.
      const refreshRequests: Array<(outcome: RevalidateOutcome) => void> = [];
      const refresh = (): Promise<RevalidateOutcome> =>
        new Promise<RevalidateOutcome>((resolve) => {
          refreshRequests.push(resolve);
        });
      relay.openAckCapabilities = [SESSION_CAPABILITY_CREDENTIAL_UPDATE];
      relay.decideOpen = (_grant, openIndex) =>
        openIndex === 0
          ? { kind: "fatal", details: releasedRefusal() }
          : { kind: "ack" };
      const personal = signOnFor(PERSONAL_ROW, signIn);
      if (personal === null) throw new Error("personal row must open released");
      const session = openSession(
        relay,
        signIn,
        {
          ...personal,
          recovery: {
            revalidateForReconnect: refresh,
            revalidateRefused: refresh,
          },
        },
        door,
      );
      session.start();
      await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
      expect(relay.openBearers).toEqual(["", SIGN_IN]);
      await relay.sendStreamFatal(SESSION_CONTROL_STREAM_ID, releasedRefusal());
      await vi.waitFor(() => expect(refreshRequests).toHaveLength(1), WAIT);

      // The protocol's recovery gives up on the pending refresh; the replacement attach is admitted.
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.waitFor(() => {
        expect(relay.openBearers).toEqual(["", SIGN_IN, SIGN_IN]);
        expect(session.isReady()).toBe(true);
      }, WAIT);
      return {
        relay,
        signIn,
        session,
        refusals,
        refreshRequests,
        /** Authn answers a refresh request: the sign-in rotates, and the request returns `rotated`. */
        answerRotated: (index: number, rotatedTo: string) => {
          signIn.rotate(rotatedTo);
          refreshRequests[index]("rotated");
        },
      };
    }

    it("asks authn for the newer connection's own refresh when the older refresh answers after the admission and before the newer connection's refusal", async () => {
      const rig = await admittedWithRefreshPending();
      try {
        rig.answerRotated(0, "sign-in-from-the-older-refresh");
        await vi.advanceTimersByTimeAsync(0);

        await rig.relay.sendStreamFatal(
          SESSION_CONTROL_STREAM_ID,
          releasedRefusal(),
        );
        await vi.waitFor(
          () => expect(rig.refreshRequests).toHaveLength(2),
          WAIT,
        );
        rig.answerRotated(1, "sign-in-from-the-newer-refresh");
        await vi.waitFor(() => {
          expect(rig.relay.openBearers[rig.relay.openBearers.length - 1]).toBe(
            "sign-in-from-the-newer-refresh",
          );
        }, WAIT);
        expect(rig.refusals).toEqual([]);
      } finally {
        rig.session.close();
        vi.useRealTimers();
      }
    }, 20_000);

    it("asks authn for the newer connection's own refresh when its refusal arrives while the older refresh still runs", async () => {
      const rig = await admittedWithRefreshPending();
      try {
        await rig.relay.sendStreamFatal(
          SESSION_CONTROL_STREAM_ID,
          releasedRefusal(),
        );
        await vi.waitFor(
          () => expect(rig.refreshRequests).toHaveLength(2),
          WAIT,
        );
        rig.answerRotated(1, "sign-in-from-the-newer-refresh");
        await vi.waitFor(() => {
          expect(rig.relay.openBearers[rig.relay.openBearers.length - 1]).toBe(
            "sign-in-from-the-newer-refresh",
          );
        }, WAIT);
        expect(rig.refusals).toEqual([]);
      } finally {
        rig.session.close();
        vi.useRealTimers();
      }
    }, 20_000);
  });

  describe("a host process replaced while a relay session is dialing", () => {
    /** A door that counts the connections it holds admitted, as the app's does, and drops a refusal while any is. */
    function admissionCountingDoor(): {
      readonly door: HostDoorObserver;
      readonly liveAdmissions: () => number;
    } {
      let live = 0;
      return {
        liveAdmissions: () => live,
        door: {
          refused: () => undefined,
          admitted: () => {
            live += 1;
            let released = false;
            return () => {
              if (released) return;
              released = true;
              live -= 1;
            };
          },
        },
      };
    }

    it("credits the door nothing for an admission delivered after the host was replaced, and the replacement's own refusal still gets its own sign-in refresh", async () => {
      const relay = new FakeRelayHost();
      const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
      const hosts = createReleasedHostMemory();
      hosts.observeInstance("host-1", "process-a");
      const { door, liveAdmissions } = admissionCountingDoor();
      const refreshRequests: Array<(outcome: RevalidateOutcome) => void> = [];
      const refresh = (): Promise<RevalidateOutcome> =>
        new Promise<RevalidateOutcome>((resolve) => {
          refreshRequests.push(resolve);
        });
      relay.openAckCapabilities = [SESSION_CAPABILITY_CREDENTIAL_UPDATE];
      // The host is replaced before the first admission is delivered; the
      // replacement then refuses every open bare, as a released host does.
      relay.decideOpen = (_grant, openIndex) => {
        if (openIndex > 0) return { kind: "fatal", details: releasedRefusal() };
        hosts.observeInstance("host-1", "process-b");
        return { kind: "ack" };
      };
      const personal = signOnFor(PERSONAL_ROW, signIn);
      if (personal === null) throw new Error("personal row must open released");
      const session = openSession(
        relay,
        signIn,
        {
          ...personal,
          hosts,
          recovery: {
            revalidateForReconnect: refresh,
            revalidateRefused: refresh,
          },
        },
        door,
      );
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
        expect(liveAdmissions()).toBe(0);

        relay.dropCurrentConnection();
        await vi.waitFor(() => expect(refreshRequests).toHaveLength(1), WAIT);
        expect(relay.openBearers).toEqual(["", "", SIGN_IN]);
      } finally {
        session.close();
      }
    }, 20_000);

    it("presents the host-only token, not the sign-in a plan made for the earlier process, when the host is replaced before the redial", async () => {
      const relay = new FakeRelayHost();
      const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
      const hosts = createReleasedHostMemory();
      hosts.observeInstance("host-1", "process-a");
      const { door, refusals } = recordingDoor();
      relay.openAckCapabilities = [SESSION_CAPABILITY_CREDENTIAL_UPDATE];
      // The first open is refused bare, which plans the sign-in for the redial.
      relay.decideOpen = (_grant, openIndex) =>
        openIndex === 0
          ? { kind: "fatal", details: releasedRefusal() }
          : { kind: "ack" };
      // The host is replaced between that plan and the redial's open: the redial's attach grant is asked in between.
      let attaches = 0;
      const personal = signOnFor(PERSONAL_ROW, signIn);
      if (personal === null) throw new Error("personal row must open released");
      const session = openSessionWithGrants(
        relay,
        { ...personal, hosts },
        door,
        () => {
          attaches += 1;
          if (attaches === 2) hosts.observeInstance("host-1", "process-b");
          return Promise.resolve(OK_GRANT);
        },
      );
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
        expect(relay.openBearers).toEqual(["", ""]);
        expect(isHostTokenAuthz(relay.openAuthz[1])).toBe(true);
        expect(refusals).toEqual([]);
      } finally {
        session.close();
      }
    }, 20_000);
  });

  it("reports nothing to the door when the sign-in's refresh answers rejected after the session closed", async () => {
    const relay = new FakeRelayHost();
    const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
    const refreshes: Array<(outcome: RevalidateOutcome) => void> = [];
    const { door, refusals } = recordingDoor();
    relay.decideOpen = () => ({ kind: "fatal", details: releasedRefusal() });
    const personal = signOnFor(PERSONAL_ROW, signIn);
    if (personal === null) throw new Error("personal row must open released");
    const session = openSession(
      relay,
      signIn,
      {
        ...personal,
        recovery: {
          revalidateForReconnect: () =>
            new Promise<RevalidateOutcome>((resolve) => {
              refreshes.push(resolve);
            }),
        },
      },
      door,
    );
    try {
      session.start();
      await vi.waitFor(() => expect(refreshes).toHaveLength(1), WAIT);
      expect(relay.openBearers).toEqual(["", SIGN_IN]);
      session.close();
      refreshes[0]("rejected");
      await vi.waitFor(() => expect(session.isClosed()).toBe(true), WAIT);
      expect(refusals).toEqual([]);
    } finally {
      session.close();
    }
  }, 20_000);
});
