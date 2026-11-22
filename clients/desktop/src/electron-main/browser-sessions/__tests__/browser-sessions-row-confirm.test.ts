import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import type { FatalErrorDetails } from "@traycer/protocol/framework/index";
import { SESSION_CAPABILITY_CREDENTIAL_UPDATE } from "@traycer/protocol/host-transport/mux";
import { MutableBearerLease } from "@traycer-clients/shared/auth/bearer-source";
import {
  createHostTokenSource,
  createMemoryHostTokenPersistence,
} from "@traycer-clients/shared/auth/host-token-source";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  hostListItemToDirectoryEntry,
  type RemoteHostDirectoryEntry,
} from "@traycer-clients/shared/host-client/remote-fetcher";
import { retireAllRemoteSessions } from "@traycer-clients/shared/host-transport/remote/active-remote-sessions";
import { FakeRelayHost } from "@traycer-clients/shared/host-transport/remote/__tests__/fake-relay-host";
import { processReleasedHosts } from "@traycer-clients/shared/host-transport/released-sign-on";
import { ROW_CONFIRM_CEILING_MS } from "@traycer-clients/shared/host-transport/row-confirmation";

/**
 * Desktop main's remote jar stream reads the registry again before an attach
 * whose open would carry the sign-in (`confirmRow`). The session reads no
 * answer from it: a read that committed has moved the row `liveRow` returns,
 * and a read that failed or ran past the ceiling leaves the row last read, so
 * the sign-in still goes. Real `openBrowserSessionsTransport` and relay
 * session against a fake released relay host.
 */

vi.mock("../../app/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  describeLogError: (error: unknown) => String(error),
}));

const relayHolder = vi.hoisted(() => ({
  factory: null as null | { create: () => unknown },
}));
vi.mock(
  "@traycer-clients/shared/host-transport/whatwg-stream-ws-factory",
  () => ({
    createWhatwgStreamWebSocketFactory: () => ({
      create: () => {
        if (relayHolder.factory === null) throw new Error("no relay host");
        return relayHolder.factory.create();
      },
    }),
  }),
);

vi.mock(
  "@traycer-clients/shared/host-transport/remote/grant-client",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-transport/remote/grant-client")
      >();
    return {
      ...actual,
      mintRelayPassWithHostTokenViaHttp: () =>
        Promise.resolve({
          kind: "ok" as const,
          grant: { grant: "grant-jws", expiresInSeconds: 300 },
          hostToken: {
            token: "relay-minted-host-token",
            expiresAtMs: Date.now() + 3_600_000,
          },
        }),
    };
  },
);

import { openBrowserSessionsTransport } from "../browser-sessions-transport";

const USER_ID = "user-1";
const SIGN_IN = "person-sign-in";
const WAIT = { timeout: 10_000, interval: 20 };

function releasedRefusal(): FatalErrorDetails {
  return {
    code: "UNAUTHORIZED",
    reason: "released-host-token-refusal",
    incompatibleMethods: null,
    upgradeGuidance: null,
  };
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function rowFor(
  hostId: string,
  publicKey: string,
  owner: HostListItem["owner"],
): RemoteHostDirectoryEntry {
  return hostListItemToDirectoryEntry(
    {
      hostId,
      displayName: "Remote",
      platform: "linux",
      kind: "personal",
      publicKey,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatePolicy: "auto",
      status: {
        connectivity: "connectable",
        viewerReachability: "ok",
        clientCloud: "ok",
        updateState: "current",
        appVersion: "1.5.0",
        lastSeenAt: null,
      },
      owner,
    },
    "wss://relay.test/attach",
  );
}

let hostCounter = 0;

/** Opens the jar transport to a released relay host; `confirmRow` is the read the test controls. */
function openJarTransport(
  confirmRow: (
    setRow: (owner: HostListItem["owner"]) => void,
  ) => Promise<boolean>,
) {
  hostCounter += 1;
  const hostId = `jar-row-confirm-${hostCounter}`;
  const relay = new FakeRelayHost();
  relay.openAckCapabilities = [SESSION_CAPABILITY_CREDENTIAL_UPDATE];
  relay.decideOpen = (_grant, openIndex) =>
    relay.openAuthz[openIndex] === null
      ? { kind: "ack" }
      : { kind: "fatal", details: releasedRefusal() };
  relayHolder.factory = relay.factory;
  const publicKey = hex(relay.hostStaticPublicKey);
  let row: HostDirectoryEntry | null = rowFor(hostId, publicKey, {
    kind: "user",
    id: USER_ID,
  });
  const lease = new MutableBearerLease(SIGN_IN, USER_ID);
  const reads = { count: 0 };
  const transport = openBrowserSessionsTransport(
    rowFor(hostId, publicKey, { kind: "user", id: USER_ID }),
    USER_ID,
    {
      authnBaseUrl: () => "https://authn.test",
      bearer: () => lease,
      cloudAuthorized: () => true,
      endpoint: () => null,
      liveRow: () => row,
      confirmRow: () => {
        reads.count += 1;
        return confirmRow((owner) => {
          row = rowFor(hostId, publicKey, owner);
        });
      },
      appVersion: "1.5.0",
      hostTokens: createHostTokenSource({
        persistence: createMemoryHostTokenPersistence(),
        mint: () => Promise.resolve({ kind: "no-sign-in" }),
        signIn: null,
        now: () => Date.now(),
      }),
    },
  );
  if (transport === null) throw new Error("the jar transport did not build");
  return { relay, reads, close: () => transport.close() };
}

describe("desktop main's remote jar stream and its row read", () => {
  const closers: Array<() => void> = [];

  beforeEach(() => {
    processReleasedHosts.forgetAll();
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const close of closers.splice(0)) close();
    retireAllRemoteSessions();
    relayHolder.factory = null;
  });

  it("still opens with the sign-in when the row read fails", async () => {
    const run = openJarTransport(() => Promise.resolve(false));
    closers.push(run.close);

    await vi.waitFor(
      () => expect(run.relay.openBearers).toEqual(["", SIGN_IN]),
      WAIT,
    );
    expect(run.reads.count).toBe(1);
  }, 20_000);

  it("still opens with the sign-in when the row read passes the ceiling", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const run = openJarTransport(() => new Promise<boolean>(() => undefined));
    closers.push(run.close);

    await vi.waitFor(() => expect(run.reads.count).toBe(1), WAIT);
    // The attach waits on the read: only the host-only token's open is written.
    expect(run.relay.openBearers).toEqual([""]);
    await vi.advanceTimersByTimeAsync(ROW_CONFIRM_CEILING_MS);

    await vi.waitFor(
      () => expect(run.relay.openBearers).toEqual(["", SIGN_IN]),
      WAIT,
    );
  }, 20_000);

  it("opens with no sign-in when the row read commits a row that moved to a team", async () => {
    const run = openJarTransport((setRow) => {
      setRow({ kind: "team", id: "team-1", name: "Team" });
      return Promise.resolve(true);
    });
    closers.push(run.close);

    // The second open is the one the sign-in would ride.
    await vi.waitFor(() => expect(run.relay.openBearers).toHaveLength(2), WAIT);
    expect(run.reads.count).toBe(1);
    expect(run.relay.openBearers).toEqual(["", ""]);
    expect(run.relay.openAuthz.every((authz) => authz !== null)).toBe(true);
  }, 20_000);
});
