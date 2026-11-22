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
import type {
  AttachGrantProvider,
  AttachGrantProvision,
} from "@traycer/protocol/host-transport/remote/grant";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostDoorStateOfRefusal } from "../../host-door-state";
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
  door: SessionDoorObserver,
): RemoteSession<typeof emptyRpcRegistry, typeof emptyStreamRegistry> {
  return openSessionWithGrants(relay, releasedSignOn, door, () =>
    Promise.resolve(OK_GRANT),
  );
}

function openSessionWithGrants(
  relay: FakeRelayHost,
  releasedSignOn: RemoteReleasedSignOn | null,
  door: SessionDoorObserver,
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
        hosts: createReleasedHostMemory(),
        opensReleasedWay: rowAllows,
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
      hosts.refusedNamingReason("host-1");
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

  it("reports the refusal once when the personal host refuses the sign-in too", async () => {
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
      expect(refusals).toHaveLength(1);
      expect(hostDoorStateOfRefusal(refusals[0])).toBe("older-host");
      const opensAtClose = relay.openBearers.length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(session.isClosed()).toBe(true);
      expect(relay.openBearers).toHaveLength(opensAtClose);
    } finally {
      session.close();
      vi.useRealTimers();
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
      hosts.signInAdmitted(USER_ID, "host-1");
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
